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
 * @对应文档章节: docs/ceteris-link-protocol.md 第 6 章
 */
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { COMMAND_CHANNELS, type CommandEnvelope } from '@shared/protocol';
import { LINK_RESUME_TTL_MS } from '@shared/link-protocol';
import { generateLinkToken } from './link-crypto';

vi.mock('electron', () => ({ app: { getVersion: () => '0.0.0-test' } }));
vi.mock('../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/** Host 上的业务层替身:记录 ownership 和收到的输入。 */
class FakeHost {
  readonly realWindows = new Set<string>(['host-local-window']);
  readonly virtualWindows = new Map<string, (channel: string, envelope: unknown) => void>();
  readonly owners = new Map<string, string | null>();
  readonly inputs: string[] = [];
  /** 为 true 时 send-input 永不返回,用来制造"已发出、未确认"的命令 */
  holdInputs = false;
  private nextNumber = 1;

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
      // 与 handleWindowClosed 一致:归属清空,PTY 不动
      for (const [sessionId, owner] of this.owners) {
        if (owner === windowId) this.owners.set(sessionId, null);
      }
      return existed;
    },
  };

  getOwnedSessionIds = (windowId: string): string[] =>
    [...this.owners].filter(([, owner]) => owner === windowId).map(([id]) => id);

  dispatch = async (channel: string, envelope: CommandEnvelope<unknown>): Promise<unknown> => {
    if (channel === COMMAND_CHANNELS.SESSION_CLAIM) {
      const { sessionId } = envelope.payload as { sessionId: string };
      const owner = this.owners.get(sessionId);
      if (owner === undefined) throw new Error('SessionNotFound');
      if (owner !== null && owner !== envelope.windowId) throw new Error('SessionAlreadyOwned');
      this.owners.set(sessionId, envelope.windowId);
      return {};
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
  const windows = new Set<string>();
  const remote = new Map<string, string>();
  const win = {
    isDestroyed: () => false,
    webContents: {
      send: (channel: string, envelope: unknown) => events.push({ channel, envelope }),
      reload,
    },
  };
  return {
    events,
    reload,
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

  it('重连保持 windowId,恢复归属,并且在 reload 之前完成', async () => {
    const { host, port, token } = await startHost();
    const { client, local } = startClient(port, token);
    await waitFor(connected(client), '首次连接');
    const windowId = client.boundWindowId!;
    host.owners.set('s1', windowId);

    let ownerAtReload: string | null | undefined;
    local.reload.mockImplementation(() => {
      ownerAtReload = host.owners.get('s1');
    });

    dropConnection(client);
    await waitFor(() => local.reload.mock.calls.length === 1, '重连后 reload');

    expect(client.boundWindowId).toBe(windowId);
    expect(ownerAtReload).toBe(windowId);
    expect(host.owners.get('s1')).toBe(windowId);
  });

  it('断线期间被 Host 本机接管的 session 不会被抢回', async () => {
    const { host, port, token } = await startHost();
    const { client, local } = startClient(port, token);
    await waitFor(connected(client), '首次连接');
    host.owners.set('s1', client.boundWindowId);

    dropConnection(client);
    await waitFor(() => host.owners.get('s1') === null, '归属释放');
    host.owners.set('s1', 'host-local-window');

    await waitFor(() => local.reload.mock.calls.length === 1, '重连');
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

    await waitFor(() => local.reload.mock.calls.length === 1, '重连');
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

    await waitFor(() => local.reload.mock.calls.length === 1, '重连');
    expect(host.owners.get('s1')).toBeNull();
  });

  it('被 Host 踢掉的客户端重连后不恢复归属', async () => {
    const { host, server, port, token } = await startHost();
    const { client, local } = startClient(port, token);
    await waitFor(connected(client), '首次连接');
    const windowId = client.boundWindowId!;
    host.owners.set('s1', windowId);

    expect(server.disconnectClient(windowId)).toBe(true);
    await waitFor(() => local.reload.mock.calls.length === 1, '重连');
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

    await waitFor(() => local.reload.mock.calls.length === 1, '重连');
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
    await waitFor(() => local.reload.mock.calls.length === 1, 'reload');
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

    await waitFor(() => local.reload.mock.calls.length === 1, '重连');
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

    await waitFor(() => local.reload.mock.calls.length === 1, '重连');
    await new Promise((r) => setTimeout(r, 100));
    expect(host.inputs).toEqual([]);
  });

  it('确认过的输入只执行一次,重连不影响', async () => {
    const { host, port, token } = await startHost();
    const { client, local } = startClient(port, token);
    await waitFor(connected(client), '连接');

    await client.forwardCommand(COMMAND_CHANNELS.SESSION_SEND_INPUT, { data: 'once' });
    dropConnection(client);
    await waitFor(() => local.reload.mock.calls.length === 1, '重连');

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

    const payload = 'x'.repeat(256 * 1024);
    const send = host.virtualWindows.get(windowId)!;
    for (let i = 0; i < 2000 && host.virtualWindows.has(windowId); i++) {
      send('evt:session:output', { payload });
      await new Promise((r) => setImmediate(r));
    }
    expect(host.virtualWindows.has(windowId)).toBe(false);
    expect(host.owners.get('s1')).toBeNull();

    socket.resume();
    await waitFor(() => local.reload.mock.calls.length === 1, '重连');
    expect(host.owners.get('s1')).toBe(windowId);
  });
});
