/**
 * @file src/main/link/link-session-resume.test.ts
 * @purpose 在真实 TCP 环回连接上,用真实的 LinkServer 和 LinkClient 验证断线、
 *   重连和命令语义。
 *
 * @为什么不用 mock socket:
 * 这里要防的 bug 都出在时序上:重连早于 Host 判定旧连接超时、认证完成前窗口已
 * reload、写缓冲积压。这些只有真 socket 和真定时器才会暴露。替身只用在 Link 层
 * 之外:WindowManager 和命令 handler,它们的语义由各自的测试覆盖。
 *
 * ADR-050 之后重连不再 reload 窗口:Host 回 resume(snapshot)并补发漏掉的输出,
 * 客户端注入 evt:app:resync。这里的"重连完成"因此以 resync 到达为准。
 *
 * 末尾两组测试覆盖 ADR-056 的压缩协商和 ADR-055 的连接测试,同样走真实 socket。
 *
 * @对应文档章节: docs/ceteris-link-protocol.md 第 6 章;docs/软件定义书.md ADR-050、ADR-055、ADR-056
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { connect } from 'node:net';
import { COMMAND_CHANNELS, EVENT_CHANNELS, type CommandEnvelope } from '@shared/protocol';
import {
  LINK_PROTOCOL_VERSION,
  LINK_RESUME_TTL_MS,
  type LinkHandshakeError,
} from '@shared/link-protocol';
import { generateLinkToken } from './link-crypto';
import { encodeFrame, FrameDecoder } from './frame-codec';
import { OutputRing } from '../output-ring';

vi.mock('electron', () => ({ app: { getVersion: () => '0.0.0-test' } }));
vi.mock('../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/** Host 上的业务层替身:记录 ownership、分屏、最近输出环和收到的输入。 */
class FakeHost {
  readonly realWindows = new Set<string>(['host-local-window']);
  readonly virtualWindows = new Map<string, (channel: string, envelope: unknown) => void>();
  readonly owners = new Map<string, string | null>();
  readonly paneSessions = new Map<string, string[]>();
  readonly rings = new Map<string, OutputRing>();
  private readonly seqs = new Map<string, number>();
  readonly inputs: string[] = [];
  /** 为 true 时 send-input 永不返回,用来制造"已发出、未确认"的命令 */
  holdInputs = false;
  /** claim 时顺带产生的输出,模拟 claim 序列化终端状态时 flush 出来的字节 */
  outputOnClaim: string | null = null;
  /** 最近输出环的容量,测试缺口时调小 */
  ringCapBytes = 1024 * 1024;
  /** claim 已改归属、尚未返回时调用,模拟 claim 序列化终端状态的那段等待 */
  onClaim: ((sessionId: string) => Promise<void>) | null = null;
  /** 每次 AGENT_NOTICES_READY 的 windowId */
  readonly noticesReady: string[] = [];
  private nextNumber = 1;

  /**
   * 模拟一段 PTY 输出:进最近输出环;有 owner 且 owner 是在线的虚拟窗口时推过去,
   * 与 ipc.ts 的 owner-only 路由一致。
   */
  emitOutput(sessionId: string, text: string): number {
    const seq = (this.seqs.get(sessionId) ?? -1) + 1;
    this.seqs.set(sessionId, seq);
    const data = Buffer.from(text).toString('base64');
    let ring = this.rings.get(sessionId);
    if (!ring) {
      ring = new OutputRing(this.ringCapBytes);
      this.rings.set(sessionId, ring);
    }
    ring.append(seq, data);
    const owner = this.owners.get(sessionId);
    const send = owner ? this.virtualWindows.get(owner) : undefined;
    send?.(EVENT_CHANNELS.SESSION_OUTPUT, {
      eventId: randomUUID(),
      timestamp: Date.now(),
      payload: { sessionId, data, seq },
    });
    return seq;
  }

  readonly windowManager = {
    registerVirtualWindow: (
      send: (channel: string, envelope: unknown) => void,
      preferred?: string,
    ): { id: string; number: number } => {
      // 与 WindowManager.registerVirtualWindow 的复用规则一致
      const reusable =
        preferred && !this.realWindows.has(preferred) && !this.virtualWindows.has(preferred);
      const id = reusable ? preferred : randomUUID();
      this.virtualWindows.set(id, send);
      return { id, number: this.nextNumber++ };
    },
    unregisterVirtualWindow: (windowId: string): boolean => {
      const existed = this.virtualWindows.delete(windowId);
      // 与 handleWindowClosed 一致:分屏列表删掉,归属清空,PTY 不动
      this.paneSessions.delete(windowId);
      for (const [sessionId, owner] of this.owners) {
        if (owner === windowId) this.owners.set(sessionId, null);
      }
      return existed;
    },
  };

  getOwnedSessionIds = (windowId: string): string[] =>
    [...this.owners].filter(([, owner]) => owner === windowId).map(([id]) => id);

  getPaneSessionIds = (windowId: string): string[] => this.paneSessions.get(windowId) ?? [];

  dispatch = async (channel: string, envelope: CommandEnvelope<unknown>): Promise<unknown> => {
    if (channel === COMMAND_CHANNELS.SESSION_CLAIM) {
      const { sessionId } = envelope.payload as { sessionId: string };
      const owner = this.owners.get(sessionId);
      if (owner === undefined) throw new Error('SessionNotFound');
      if (owner !== null && owner !== envelope.windowId) throw new Error('SessionAlreadyOwned');
      this.owners.set(sessionId, envelope.windowId);
      // 与 SessionManager.claimOwner 一致:单焦点,分屏里的除外
      const panes = this.paneSessions.get(envelope.windowId) ?? [];
      for (const [id, o] of this.owners) {
        if (o === envelope.windowId && id !== sessionId && !panes.includes(id)) {
          this.owners.set(id, null);
        }
      }
      if (this.outputOnClaim) this.emitOutput(sessionId, this.outputOnClaim);
      if (this.onClaim) await this.onClaim(sessionId);
      return {};
    }
    if (channel === COMMAND_CHANNELS.AGENT_NOTICES_READY) {
      this.noticesReady.push(envelope.windowId);
      return undefined;
    }
    if (channel === COMMAND_CHANNELS.SESSION_SET_PANE_SESSIONS) {
      const { sessionIds } = envelope.payload as { sessionIds: string[] };
      this.paneSessions.set(envelope.windowId, sessionIds);
      return undefined;
    }
    if (channel === COMMAND_CHANNELS.APP_GET_SNAPSHOT) {
      return {
        myWindowId: envelope.windowId,
        sessions: [...this.owners].map(([id, ownerWindowId]) => ({ id, ownerWindowId })),
      };
    }
    if (channel === COMMAND_CHANNELS.SESSION_OUTPUT_SINCE) {
      const { sessionId, afterSeq } = envelope.payload as { sessionId: string; afterSeq: number };
      if (!this.owners.has(sessionId)) return { status: 'unknown-session' };
      const res = this.rings.get(sessionId)?.since(afterSeq) ?? { gap: false, chunks: [] };
      return res.gap ? { status: 'gap' } : { status: 'ok', chunks: res.chunks };
    }
    if (channel === COMMAND_CHANNELS.SESSION_SEND_INPUT) {
      const { data } = envelope.payload as { data: string };
      this.inputs.push(data);
      if (this.holdInputs) return new Promise(() => undefined);
      return { accepted: true };
    }
    return { echoedFrom: envelope.windowId };
  };
}

const ipcMock = vi.hoisted(() => ({
  host: null as FakeHost | null,
}));
vi.mock('../ipc', () => ({
  dispatchLocalCommand: (channel: string, envelope: CommandEnvelope<unknown>) =>
    ipcMock.host!.dispatch(channel, envelope),
  applyLocalThemeToLinkEvent: (_channel: string, envelope: unknown) => envelope,
}));

const { LinkServer } = await import('./link-server');
const { LinkClient } = await import('./link-client');
type Server = InstanceType<typeof LinkServer>;
type Client = InstanceType<typeof LinkClient>;

/** 客户端机器上的窗口替身。 */
function makeClientWindowManager() {
  const events: Array<{ channel: string; envelope: unknown }> = [];
  const reload = vi.fn();
  /** 每次向窗口发事件时调用,用来记录"那一刻"的 Host 状态 */
  const onSend = vi.fn((_channel: string, _envelope: unknown): void => undefined);
  const windows = new Set<string>();
  const remote = new Map<string, string>();
  const win = {
    isDestroyed: () => false,
    webContents: {
      send: (channel: string, envelope: unknown) => {
        events.push({ channel, envelope });
        onSend(channel, envelope);
      },
      reload,
    },
  };
  return {
    events,
    reload,
    onSend,
    windows,
    manager: {
      markWindowRemote: (windowId: string, linkId: string) => remote.set(windowId, linkId),
      unmarkWindowRemote: (windowId: string) => remote.delete(windowId),
      createWindow: (opts: { forcedWindowId: string }) => windows.add(opts.forcedWindowId),
      getById: (windowId: string) => (windows.has(windowId) ? win : null),
    },
  };
}

const servers: Server[] = [];
const clients: Client[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const c of clients.splice(0)) c.disconnect('test-end');
  for (const s of servers.splice(0)) await s.stop();
});

async function waitFor(condition: () => boolean, label: string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`waitFor 超时:${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function startHost(opts: { maxWriteBacklogBytes?: number } = {}) {
  const host = new FakeHost();
  ipcMock.host = host;
  const token = generateLinkToken();
  const server = new LinkServer({
    windowManager: host.windowManager as never,
    getToken: () => token,
    getOwnedSessionIds: host.getOwnedSessionIds,
    getPaneSessionIds: host.getPaneSessionIds,
    ...opts,
  });
  servers.push(server);
  expect(await server.start({ bindAddress: '127.0.0.1', port: 0 })).toBe(true);
  return { host, server, token, port: server.getStatus().port };
}

/** 建一个客户端。preset 用来预置"已经连过一次"的内部状态。 */
function makeClient(
  port: number,
  token: string,
  preset: { windowId?: string; windowCreated?: boolean } = {},
) {
  const local = makeClientWindowManager();
  const client = new LinkClient(
    randomUUID(),
    { label: 'host', host: '127.0.0.1', port, token },
    {
      windowManager: local.manager as never,
      getWindowOptions: () => ({}) as never,
      onStatusChange: () => undefined,
    },
  );
  Object.assign(client, preset);
  if (preset.windowCreated && preset.windowId) local.windows.add(preset.windowId);
  clients.push(client);
  client.connect();
  return { client, local };
}

const startClient = (port: number, token: string) => makeClient(port, token);

const connected = (c: Client) => (): boolean => c.getStatus().state === 'connected';

type ClientWindow = ReturnType<typeof makeClientWindowManager>;

/** 窗口收到的 evt:app:resync 的 payload。 */
const resyncs = (local: ClientWindow) =>
  local.events
    .filter((e) => e.channel === EVENT_CHANNELS.APP_RESYNC)
    .map(
      (e) => (e.envelope as { payload: { snapshot: unknown; replaySessionIds: string[] } }).payload,
    );

/** 窗口收到的某 session 的输出:[seq, 文本]。 */
const outputs = (local: ClientWindow, sessionId: string): Array<[number, string]> =>
  local.events
    .filter((e) => e.channel === EVENT_CHANNELS.SESSION_OUTPUT)
    .map(
      (e) => (e.envelope as { payload: { sessionId: string; seq: number; data: string } }).payload,
    )
    .filter((p) => p?.sessionId === sessionId)
    .map((p) => [p.seq, Buffer.from(p.data, 'base64').toString()]);

/** 等到窗口完成第 n 次原地恢复。 */
const restored =
  (local: ClientWindow, n = 1) =>
  (): boolean =>
    resyncs(local).length >= n;

/** 模拟网络中断:连接被切断,但 LinkClient 没有调用 disconnect。 */
function dropConnection(client: Client): void {
  (client as unknown as { socket: { destroy: () => void } }).socket.destroy();
}

describe('Link 基本转发', () => {
  it('命令在 Host 上以虚拟窗口身份执行,事件按序到达窗口', async () => {
    const { host, port, token } = await startHost();
    const { client, local } = startClient(port, token);
    await waitFor(connected(client), '连接');

    const windowId = client.boundWindowId!;
    const result = await client.forwardCommand('cmd:test:echo', {});
    expect(result).toEqual({ echoedFrom: windowId });

    const send = host.virtualWindows.get(windowId)!;
    for (let i = 0; i < 200; i++) send('evt:session:output', { seq: i });
    await waitFor(
      () => local.events.filter((e) => e.channel === 'evt:session:output').length === 200,
      '流式事件全部到达',
    );
    const seqs = local.events
      .filter((e) => e.channel === 'evt:session:output')
      .map((e) => (e.envelope as { seq: number }).seq);
    expect(seqs).toEqual([...Array(200).keys()]);
  });

  it('令牌错误的客户端拿不到窗口,也进不了 Host', async () => {
    const { host, port } = await startHost();
    const { client } = startClient(port, generateLinkToken());
    await waitFor(() => client.getStatus().state === 'reconnecting', '被拒绝');
    expect(client.boundWindowId).toBeNull();
    expect(host.virtualWindows.size).toBe(0);
    expect(client.getStatus().lastError).toMatch(/令牌不一致/);
  });
});

describe('断线与重连', () => {
  it('意外断线后 session 转为无主,Host 本机可以立刻使用', async () => {
    const { host, port, token } = await startHost();
    const { client } = startClient(port, token);
    await waitFor(connected(client), '连接');
    host.owners.set('s1', client.boundWindowId);

    dropConnection(client);
    await waitFor(() => host.owners.get('s1') === null, '归属释放');
    expect(host.virtualWindows.size).toBe(0);
  });

  it('重连保持 windowId,恢复归属,并且在 resync 之前完成,不 reload', async () => {
    const { host, port, token } = await startHost();
    const { client, local } = startClient(port, token);
    await waitFor(connected(client), '首次连接');
    const windowId = client.boundWindowId!;
    host.owners.set('s1', windowId);

    let ownerAtResync: string | null | undefined;
    local.onSend.mockImplementation((channel) => {
      if (channel === EVENT_CHANNELS.APP_RESYNC) ownerAtResync = host.owners.get('s1');
    });

    dropConnection(client);
    await waitFor(restored(local), '重连后原地恢复');

    expect(client.boundWindowId).toBe(windowId);
    expect(ownerAtResync).toBe(windowId);
    expect(host.owners.get('s1')).toBe(windowId);
    expect(local.reload).not.toHaveBeenCalled();
  });

  it('断线期间被 Host 本机接管的 session 不会被抢回', async () => {
    const { host, port, token } = await startHost();
    const { client, local } = startClient(port, token);
    await waitFor(connected(client), '首次连接');
    host.owners.set('s1', client.boundWindowId);

    dropConnection(client);
    await waitFor(() => host.owners.get('s1') === null, '归属释放');
    host.owners.set('s1', 'host-local-window');

    await waitFor(restored(local), '重连');
    expect(host.owners.get('s1')).toBe('host-local-window');
  });

  it('断线期间已关闭的 session 不影响重连', async () => {
    const { host, port, token } = await startHost();
    const { client, local } = startClient(port, token);
    await waitFor(connected(client), '首次连接');
    host.owners.set('gone', client.boundWindowId);
    host.owners.set('kept', client.boundWindowId);

    dropConnection(client);
    await waitFor(() => host.owners.get('kept') === null, '归属释放');
    host.owners.delete('gone');

    await waitFor(restored(local), '重连');
    expect(host.owners.get('kept')).toBe(client.boundWindowId);
  });

  it('归属记录过期后不再恢复', async () => {
    const { host, port, token } = await startHost();
    const { client, local } = startClient(port, token);
    await waitFor(connected(client), '首次连接');
    host.owners.set('s1', client.boundWindowId);

    const realNow = Date.now;
    dropConnection(client);
    await waitFor(() => host.owners.get('s1') === null, '归属释放');
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + LINK_RESUME_TTL_MS + 1);

    await waitFor(restored(local), '重连');
    expect(host.owners.get('s1')).toBeNull();
  });

  it('被 Host 踢掉的客户端重连后不恢复归属', async () => {
    const { host, server, port, token } = await startHost();
    const { client, local } = startClient(port, token);
    await waitFor(connected(client), '首次连接');
    const windowId = client.boundWindowId!;
    host.owners.set('s1', windowId);

    expect(server.disconnectClient(windowId)).toBe(true);
    await waitFor(restored(local), '重连');
    expect(host.owners.get('s1')).toBeNull();
  });

  it('Host 监听重启后客户端自动回来并恢复归属', async () => {
    const { host, server, port, token } = await startHost();
    const { client, local } = startClient(port, token);
    await waitFor(connected(client), '首次连接');
    const windowId = client.boundWindowId!;
    host.owners.set('s1', windowId);

    await server.stop();
    expect(await server.start({ bindAddress: '127.0.0.1', port })).toBe(true);

    await waitFor(restored(local), '重连');
    expect(host.owners.get('s1')).toBe(windowId);
  });
});

describe('半开连接', () => {
  /**
   * Wi-Fi 切换或休眠唤醒时,客户端重连早于 Host 判定旧连接超时。这里让旧连接保持
   * 打开但不再响应,再用同一 windowId 发起新连接。
   */
  async function reconnectWhileOldConnectionLingers() {
    const { host, server, port, token } = await startHost();
    const first = startClient(port, token);
    await waitFor(connected(first.client), '首次连接');
    const windowId = first.client.boundWindowId!;
    host.owners.set('s1', windowId);

    // 让这个 LinkClient 彻底失声,只留下 Host 看到的那条半开连接
    const internals = first.client as unknown as {
      socket: { pause: () => void; removeAllListeners: () => void } | null;
    };
    internals.socket?.removeAllListeners();
    internals.socket?.pause();
    internals.socket = null;
    first.client.disconnect('test-silence');

    const { client: resumed, local } = makeClient(port, token, { windowId, windowCreated: true });
    await waitFor(connected(resumed), '新连接');
    return { host, server, windowId, resumed, local };
  }

  it('新连接拿回原 windowId,不会分配新 id 造成窗口失效', async () => {
    const { resumed, windowId, local } = await reconnectWhileOldConnectionLingers();
    expect(resumed.boundWindowId).toBe(windowId);
    await waitFor(restored(local), '原地恢复');
  });

  it('旧连接被取代,Host 只保留一个客户端,归属恢复', async () => {
    const { host, server, windowId } = await reconnectWhileOldConnectionLingers();
    expect(host.virtualWindows.size).toBe(1);
    expect(server.getStatus().clients).toHaveLength(1);
    expect(host.owners.get('s1')).toBe(windowId);
  });

  it('客户端不能用 Host 本地窗口的 id 冒充它', async () => {
    const { host, port, token } = await startHost();
    host.owners.set('s1', 'host-local-window');
    const { client } = makeClient(port, token, { windowId: 'host-local-window' });
    await waitFor(connected(client), '连接');

    expect(client.boundWindowId).not.toBe('host-local-window');
    expect(host.owners.get('s1')).toBe('host-local-window');
  });

  it('Host 换了 windowId 时明确报错,不留下静默失效的窗口', async () => {
    const { host, port, token } = await startHost();
    const { client } = makeClient(port, token, {
      windowId: 'host-local-window',
      windowCreated: true,
    });

    await waitFor(() => /不一致/.test(client.getStatus().lastError), '报错');
    expect(client.getStatus().state).not.toBe('connected');
    expect(host.realWindows.has('host-local-window')).toBe(true);
  });
});

describe('命令语义', () => {
  it('在途输入在断线时计为未确认,重连后不重发', async () => {
    const { host, port, token } = await startHost();
    const { client, local } = startClient(port, token);
    await waitFor(connected(client), '连接');
    host.holdInputs = true;

    const pending = client.forwardCommand(COMMAND_CHANNELS.SESSION_SEND_INPUT, { data: 'cmd' });
    await waitFor(() => host.inputs.length === 1, 'Host 收到输入');

    dropConnection(client);
    await expect(pending).rejects.toThrow(/命令结果未知/);
    expect(client.getConnectionState().unconfirmedInputs).toBe(1);

    await waitFor(restored(local), '重连');
    await new Promise((r) => setTimeout(r, 100));
    expect(host.inputs).toEqual(['cmd']);
    expect(client.getConnectionState().unconfirmedInputs).toBe(1);

    client.acknowledgeUnconfirmed();
    expect(client.getConnectionState().unconfirmedInputs).toBe(0);
  });

  it('其他在途命令不计入未确认输入', async () => {
    const { host, port, token } = await startHost();
    const { client } = startClient(port, token);
    await waitFor(connected(client), '连接');
    host.dispatch = () => new Promise(() => undefined);

    const pending = client.forwardCommand(COMMAND_CHANNELS.SESSION_RESIZE, {});
    dropConnection(client);
    await expect(pending).rejects.toThrow(/命令结果未知/);
    expect(client.getConnectionState().unconfirmedInputs).toBe(0);
  });

  it('断线期间的输入立即失败,不排队,重连后也不补发', async () => {
    const { host, port, token } = await startHost();
    const { client, local } = startClient(port, token);
    await waitFor(connected(client), '连接');

    dropConnection(client);
    await waitFor(() => client.getStatus().state === 'reconnecting', '断线');
    await expect(
      client.forwardCommand(COMMAND_CHANNELS.SESSION_SEND_INPUT, { data: 'offline' }),
    ).rejects.toThrow(/连接当前不可用/);
    expect(client.getConnectionState().unconfirmedInputs).toBe(0);

    await waitFor(restored(local), '重连');
    await new Promise((r) => setTimeout(r, 100));
    expect(host.inputs).toEqual([]);
  });

  it('确认过的输入只执行一次,重连不影响', async () => {
    const { host, port, token } = await startHost();
    const { client, local } = startClient(port, token);
    await waitFor(connected(client), '连接');

    await client.forwardCommand(COMMAND_CHANNELS.SESSION_SEND_INPUT, { data: 'once' });
    dropConnection(client);
    await waitFor(restored(local), '重连');

    expect(host.inputs).toEqual(['once']);
    expect(client.getConnectionState().unconfirmedInputs).toBe(0);
  });
});

describe('背压', () => {
  it('客户端停止读取时写缓冲有上限,断开后归属可恢复', async () => {
    const { host, port, token } = await startHost({ maxWriteBacklogBytes: 1024 * 1024 });
    const { client, local } = startClient(port, token);
    await waitFor(connected(client), '连接');
    const windowId = client.boundWindowId!;
    host.owners.set('s1', windowId);

    const socket = (client as unknown as { socket: { pause: () => void; resume: () => void } })
      .socket;
    socket.pause();

    // 随机数据:ADR-056 之后重复的字符会被压成几百字节,写缓冲永远满不了
    const payload = randomBytes(192 * 1024).toString('base64');
    const send = host.virtualWindows.get(windowId)!;
    for (let i = 0; i < 2000 && host.virtualWindows.has(windowId); i++) {
      send('evt:session:output', { payload });
      await new Promise((r) => setImmediate(r));
    }
    expect(host.virtualWindows.has(windowId)).toBe(false);
    expect(host.owners.get('s1')).toBeNull();

    socket.resume();
    await waitFor(restored(local), '重连');
    expect(host.owners.get('s1')).toBe(windowId);
  });
});

describe('原地恢复(ADR-050)', () => {
  /** 连上、持有 s1、窗口已经收到 s1 的前两段输出。 */
  async function connectedWithOutput() {
    const started = await startHost();
    const { client, local } = startClient(started.port, started.token);
    await waitFor(connected(client), '首次连接');
    const windowId = client.boundWindowId!;
    started.host.owners.set('s1', windowId);
    started.host.emitOutput('s1', 'a');
    started.host.emitOutput('s1', 'b');
    await waitFor(() => outputs(local, 's1').length === 2, '首批输出');
    return { ...started, client, local, windowId };
  }

  it('断线期间的输出按原 seq 补发,恰好一次,之后的实时输出照常', async () => {
    const { host, client, local } = await connectedWithOutput();

    dropConnection(client);
    await waitFor(() => host.owners.get('s1') === null, '归属释放');
    host.emitOutput('s1', 'c'); // 无主,只进环
    host.emitOutput('s1', 'd');

    await waitFor(restored(local), '原地恢复');
    await waitFor(() => outputs(local, 's1').length === 4, '补发');
    host.emitOutput('s1', 'e');
    await waitFor(() => outputs(local, 's1').length === 5, '实时输出');

    expect(outputs(local, 's1')).toEqual([
      [0, 'a'],
      [1, 'b'],
      [2, 'c'],
      [3, 'd'],
      [4, 'e'],
    ]);
    expect(resyncs(local)[0]!.replaySessionIds).toEqual([]);
    expect(local.reload).not.toHaveBeenCalled();
  });

  it('补发的输出排在 resync 之后,窗口先拿到新 snapshot', async () => {
    const { host, client, local } = await connectedWithOutput();
    dropConnection(client);
    await waitFor(() => host.owners.get('s1') === null, '归属释放');
    host.emitOutput('s1', 'c');

    await waitFor(() => outputs(local, 's1').length === 3, '补发');
    const order = local.events
      .map((e) => e.channel)
      .filter((c) => c === EVENT_CHANNELS.APP_RESYNC || c === EVENT_CHANNELS.SESSION_OUTPUT);
    expect(order.slice(-2)).toEqual([EVENT_CHANNELS.APP_RESYNC, EVENT_CHANNELS.SESSION_OUTPUT]);
  });

  it('认证期间产生的输出在 resync 之后到达,与补发的重叠部分不重复', async () => {
    const { host, client, local } = await connectedWithOutput();
    dropConnection(client);
    await waitFor(() => host.owners.get('s1') === null, '归属释放');
    host.emitOutput('s1', 'c');
    // 重新接管时 Host 又产生一段输出:它既进了环(被补发),也进了 outbox
    host.outputOnClaim = 'claim';

    await waitFor(() => outputs(local, 's1').length === 4, '补发与 outbox');
    await new Promise((r) => setTimeout(r, 50));
    expect(outputs(local, 's1')).toEqual([
      [0, 'a'],
      [1, 'b'],
      [2, 'c'],
      [3, 'claim'],
    ]);
  });

  it('漏掉的输出超出最近输出环时,该 session 交给窗口重新拉 scrollback', async () => {
    const started = await startHost();
    started.host.ringCapBytes = 4;
    const { client, local } = startClient(started.port, started.token);
    await waitFor(connected(client), '首次连接');
    started.host.owners.set('s1', client.boundWindowId);
    started.host.emitOutput('s1', 'a');
    await waitFor(() => outputs(local, 's1').length === 1, '首批输出');

    dropConnection(client);
    await waitFor(() => started.host.owners.get('s1') === null, '归属释放');
    started.host.emitOutput('s1', 'xxxx');
    started.host.emitOutput('s1', 'yyyy'); // 挤掉 seq 1,afterSeq=0 落在缺口里

    await waitFor(restored(local), '原地恢复');
    expect(resyncs(local)[0]!.replaySessionIds).toEqual(['s1']);
    await new Promise((r) => setTimeout(r, 50));
    expect(outputs(local, 's1')).toEqual([[0, 'a']]);
    expect(started.host.owners.get('s1')).toBe(client.boundWindowId);
  });

  it('断线期间关闭的 session 不补发,新 snapshot 里也没有它', async () => {
    const { host, client, local } = await connectedWithOutput();
    dropConnection(client);
    await waitFor(() => host.owners.get('s1') === null, '归属释放');
    host.owners.delete('s1');

    await waitFor(restored(local), '原地恢复');
    const snapshot = resyncs(local)[0]!.snapshot as { sessions: Array<{ id: string }> };
    expect(snapshot.sessions.map((s) => s.id)).not.toContain('s1');
    expect(resyncs(local)[0]!.replaySessionIds).toEqual([]);
    expect(outputs(local, 's1')).toHaveLength(2);
  });

  it('断线期间被 Host 本机接管的 session 不补发输出', async () => {
    const { host, client, local } = await connectedWithOutput();
    dropConnection(client);
    await waitFor(() => host.owners.get('s1') === null, '归属释放');
    host.owners.set('s1', 'host-local-window');
    host.emitOutput('s1', 'local');

    await waitFor(restored(local), '原地恢复');
    await new Promise((r) => setTimeout(r, 50));
    expect(outputs(local, 's1')).toHaveLength(2);
    const snapshot = resyncs(local)[0]!.snapshot as {
      sessions: Array<{ id: string; ownerWindowId: string | null }>;
    };
    expect(snapshot.sessions).toContainEqual({ id: 's1', ownerWindowId: 'host-local-window' });
  });

  it('分屏里的几个 session 重连后全部恢复,不只剩最后一个', async () => {
    const { host, port, token } = await startHost();
    const { client, local } = startClient(port, token);
    await waitFor(connected(client), '首次连接');
    const windowId = client.boundWindowId!;
    host.owners.set('s1', windowId);
    host.owners.set('s2', windowId);
    host.paneSessions.set(windowId, ['s1', 's2']);

    dropConnection(client);
    await waitFor(() => host.owners.get('s1') === null, '归属释放');
    await waitFor(restored(local), '原地恢复');

    expect(host.owners.get('s1')).toBe(windowId);
    expect(host.owners.get('s2')).toBe(windowId);
    expect(host.paneSessions.get(windowId)).toEqual(['s1', 's2']);
  });

  it('多次断线都原地恢复,seq 记录跨多次重连保持', async () => {
    const { host, client, local } = await connectedWithOutput();
    for (let round = 1; round <= 2; round++) {
      dropConnection(client);
      await waitFor(() => host.owners.get('s1') === null, `第 ${round} 次归属释放`);
      host.emitOutput('s1', `r${round}`);
      await waitFor(restored(local, round), `第 ${round} 次恢复`);
      await waitFor(() => outputs(local, 's1').length === 2 + round, `第 ${round} 次补发`);
    }
    expect(outputs(local, 's1').map(([seq]) => seq)).toEqual([0, 1, 2, 3]);
    expect(local.reload).not.toHaveBeenCalled();
  });

  it('Host 取不到 snapshot 时退回 reload', async () => {
    const { host, client, local } = await connectedWithOutput();
    dropConnection(client);
    await waitFor(() => host.owners.get('s1') === null, '归属释放');
    const original = host.dispatch;
    host.dispatch = async (channel, envelope) => {
      if (channel === COMMAND_CHANNELS.APP_GET_SNAPSHOT) throw new Error('boom');
      return original(channel, envelope);
    };

    await waitFor(() => local.reload.mock.calls.length === 1, 'reload');
    expect(resyncs(local)).toHaveLength(0);
  });
});

describe('变慢提示(ADR-050)', () => {
  it('输入 1 秒没有回音时标记变慢,任何入站帧清掉', async () => {
    const { host, port, token } = await startHost();
    const { client, local } = startClient(port, token);
    await waitFor(connected(client), '连接');
    host.holdInputs = true;

    void client.forwardCommand(COMMAND_CHANNELS.SESSION_SEND_INPUT, { data: 'x' }).catch(() => {});
    expect(client.getConnectionState().laggy).toBe(false);
    await waitFor(() => client.getConnectionState().laggy, '变慢', 3000);
    expect(client.getStatus().laggy).toBe(true);
    const pushed = local.events
      .filter((e) => e.channel === EVENT_CHANNELS.LINK_CONNECTION_STATE)
      .map((e) => (e.envelope as { payload: { laggy: boolean } }).payload.laggy);
    expect(pushed).toContain(true);

    host.virtualWindows.get(client.boundWindowId!)!('evt:test:ping', { payload: {} });
    await waitFor(() => !client.getConnectionState().laggy, '恢复');
  });
});

describe('版本不一致', () => {
  it('旧版本客户端的 hello 收到明确的 version-mismatch,不会进入认证', async () => {
    const { host, port } = await startHost();
    const socket = connect({ host: '127.0.0.1', port });
    const decoder = new FrameDecoder();
    const reply = new Promise<LinkHandshakeError>((resolve, reject) => {
      socket.on('data', (chunk) => {
        const [frame] = decoder.push(chunk);
        if (frame) resolve(JSON.parse(frame.toString('utf8')) as LinkHandshakeError);
      });
      socket.on('error', reject);
    });
    socket.on('connect', () => {
      socket.write(
        encodeFrame(
          Buffer.from(
            JSON.stringify({
              type: 'hello',
              linkVersion: LINK_PROTOCOL_VERSION - 1,
              clientPublicKey: Buffer.alloc(32).toString('base64'),
              clientNonce: Buffer.alloc(16).toString('base64'),
            }),
            'utf8',
          ),
        ),
      );
    });

    const msg = await reply;
    socket.destroy();
    expect(msg.type).toBe('handshake-error');
    expect(msg.code).toBe('version-mismatch');
    expect(msg.message).toContain(String(LINK_PROTOCOL_VERSION));
    expect(host.virtualWindows.size).toBe(0);
  });
});

describe('parseResumeRequest', () => {
  it('没带 resume 返回 null,畸形条目丢弃,重复去掉', async () => {
    const { parseResumeRequest } = await import('./link-server');
    expect(parseResumeRequest(undefined)).toBeNull();
    expect(parseResumeRequest({})).toEqual({ sessions: [] });
    expect(
      parseResumeRequest({
        sessions: [
          { sessionId: 'a', afterSeq: 3 },
          { sessionId: 'a', afterSeq: 9 },
          { sessionId: 'b', afterSeq: -2 },
          { sessionId: 'c', afterSeq: 1.5 },
          { sessionId: 7, afterSeq: 1 },
          null,
          { sessionId: 'd', afterSeq: -1 },
        ],
      }),
    ).toEqual({
      sessions: [
        { sessionId: 'a', afterSeq: 3 },
        { sessionId: 'd', afterSeq: -1 },
      ],
    });
  });

  it('条目数封顶', async () => {
    const { parseResumeRequest } = await import('./link-server');
    const many = Array.from({ length: 2000 }, (_, i) => ({ sessionId: `s${i}`, afterSeq: 0 }));
    expect(parseResumeRequest({ sessions: many })!.sessions).toHaveLength(512);
  });
});

describe('恢复归属途中断开(ADR-050)', () => {
  it('不再接管剩下的 session,也不复活分屏记录;下次重连恢复全部', async () => {
    const { host, port, token } = await startHost();
    const first = startClient(port, token);
    await waitFor(connected(first.client), '首次连接');
    const windowId = first.client.boundWindowId!;
    for (const id of ['s1', 's2', 's3']) host.owners.set(id, windowId);
    host.paneSessions.set(windowId, ['s1', 's2', 's3']);

    dropConnection(first.client);
    await waitFor(() => host.owners.get('s1') === null, '归属释放');

    // 自动重连恢复到第一个 session 时,客户端又断了(socket 关闭)
    let claims = 0;
    host.onClaim = async () => {
      claims++;
      if (claims !== 1) return;
      first.client.disconnect('test-drop-mid-claim');
      await waitFor(() => host.virtualWindows.size === 0, 'Host 注销虚拟窗口');
    };
    await waitFor(() => claims === 1 && host.virtualWindows.size === 0, '途中断开');
    await new Promise((r) => setTimeout(r, 100));

    expect(claims).toBe(1);
    expect(host.owners.get('s1')).toBeNull();
    expect(host.owners.get('s2')).toBeNull();
    expect(host.owners.get('s3')).toBeNull();
    expect(host.paneSessions.has(windowId)).toBe(false);

    host.onClaim = null;
    const { client, local } = makeClient(port, token, { windowId, windowCreated: true });
    await waitFor(connected(client), '再次连接');
    await waitFor(restored(local), '原地恢复');
    expect(['s1', 's2', 's3'].map((id) => host.owners.get(id))).toEqual([
      windowId,
      windowId,
      windowId,
    ]);
    expect(host.paneSessions.get(windowId)).toEqual(['s1', 's2', 's3']);
  });
});

describe('恢复后重新报到(ADR-050)', () => {
  it('窗口报到过 agent 通知,原地恢复后 Client 替它再报一次', async () => {
    const { host, port, token } = await startHost();
    const { client, local } = startClient(port, token);
    await waitFor(connected(client), '连接');
    const windowId = client.boundWindowId!;
    await client.forwardCommand(COMMAND_CHANNELS.AGENT_NOTICES_READY, undefined);
    expect(host.noticesReady).toEqual([windowId]);

    dropConnection(client);
    await waitFor(restored(local), '原地恢复');
    await waitFor(() => host.noticesReady.length === 2, '重新报到');
    expect(host.noticesReady).toEqual([windowId, windowId]);
  });

  it('窗口没报到过时不替它报到', async () => {
    const { host, port, token } = await startHost();
    const { client, local } = startClient(port, token);
    await waitFor(connected(client), '连接');

    dropConnection(client);
    await waitFor(restored(local), '原地恢复');
    await new Promise((r) => setTimeout(r, 100));
    expect(host.noticesReady).toEqual([]);
  });
});

describe('压缩(ADR-056)', () => {
  it('两端都支持时启用,窗口拿到的输出与 Host 发出的逐字节相同', async () => {
    const { host, port, token } = await startHost();
    const { client, local } = startClient(port, token);
    await waitFor(connected(client), '连接');
    expect((client as unknown as { compressOut: boolean }).compressOut).toBe(true);
    host.owners.set('s1', client.boundWindowId!);

    const screen = Array.from({ length: 300 }, (_, i) => `line ${i} 文字 │ tool output`).join('\n');
    host.emitOutput('s1', screen);
    await waitFor(() => outputs(local, 's1').length === 1, '输出到达');
    expect(outputs(local, 's1')).toEqual([[0, screen]]);
  });
});

describe('连接测试(ADR-055)', () => {
  it('量出往返和上下行速度', async () => {
    const { port, token } = await startHost();
    const { client } = startClient(port, token);
    await waitFor(connected(client), '连接');

    const result = await client.runNetworkTest();
    expect(result.rtt?.received).toBe(20);
    expect(result.speedSkipped).toBeNull();
    expect(result.downMBps).toBeGreaterThan(0);
    expect(result.upMBps).toBeGreaterThan(0);
    expect(result.compressed).toBe(true);
  }, 20_000);

  it('Host 没声明 probe 时只量往返', async () => {
    const { port, token } = await startHost();
    const { client } = startClient(port, token);
    await waitFor(connected(client), '连接');
    Object.assign(client, { hostFeatures: undefined });

    const result = await client.runNetworkTest();
    expect(result.speedSkipped).toBe('host-too-old');
    expect(result.downMBps).toBeNull();
    expect(result.rtt?.received).toBe(20);
  }, 20_000);

  it('测试途中断线时报错,不等测速超时', async () => {
    const { port, token } = await startHost();
    const { client } = startClient(port, token);
    await waitFor(connected(client), '连接');

    const started = Date.now();
    const pending = client.runNetworkTest();
    setTimeout(() => dropConnection(client), 300);
    await expect(pending).rejects.toThrow(/测试途中/);
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 20_000);

  it('没连上时拒绝', async () => {
    const { port, token } = await startHost();
    const { client } = startClient(port, token);
    client.disconnect('test');
    await expect(client.runNetworkTest()).rejects.toThrow(/需要先连上/);
  });

  it('报出输出最多的标签,取不到名字时用 session id 开头', async () => {
    const { host, port, token } = await startHost();
    const { client, local } = startClient(port, token);
    await waitFor(connected(client), '连接');
    host.owners.set('session-one', client.boundWindowId!);
    host.emitOutput('session-one', `${String.fromCharCode(27)}[2J` + 'x'.repeat(5000));
    await waitFor(() => outputs(local, 'session-one').length === 1, '输出到达');

    const tabs = await client.getTabTraffic();
    expect(tabs).toEqual([
      {
        sessionId: 'session-one',
        name: 'session-',
        bytes: 5004,
        largestBurstBytes: 5004,
        redraws: 1,
        resyncs: 0,
      },
    ]);
  });
});
