/**
 * @file src/main/link/link-client.ts
 * @purpose Ceteris Link 的 Client 侧。连到远端 Host,开一个本地窗口作为它的
 *   "显示器":该窗口的命令被转发到 Host,Host 推来的事件被注入该窗口。
 *
 * @关键设计:
 * - **renderer 完全不知道自己是远程的**。它照常 invoke / on,照常拿 snapshot、
 *   收 evt:session:output、写 PTY 输入。所有远程性都被吸收在 main 进程这一层。
 *   这是整个特性能做到"和本地一模一样"的根本原因。
 * - **窗口身份取自 Host**。本地窗口用 Host 分配的虚拟 windowId 作为自己的 id
 *   (createWindow 的 forcedWindowId),这样 renderer 拿 `window.api.windowId`
 *   与 session.ownerWindowId 比对时天然对得上。详见 window-manager 里
 *   forcedWindowId 的注释。
 * - **重连保持身份**。auth 时带上 preferredWindowId,Host 复用同一个虚拟窗口
 *   id,窗口位置、窗口 id、session 归属全部原样恢复。
 * - **重连不 reload**(ADR-050)。这里记下每个 session 已经交给窗口的最后一个
 *   seq,重连时随 auth 报给 Host。Host 回一条 resume(完整 snapshot)并补发漏掉的
 *   输出;snapshot 作为 evt:app:resync 注入窗口,输出照常注入。窗口里的 xterm
 *   不重建,用户看不到闪烁。只有 Host 无法原地恢复时才退回 reload。
 * - **活性**(ADR-050)。每 5 秒 ping;ping 后 3 秒或输入后 1 秒没有任何入站帧就
 *   标记"变慢"推给窗口;15 秒没有入站就断开重连。规则在 link-liveness.ts。
 * - **本地窗口关闭 = 断开连接**。用户关掉远程窗口就是"我不看了",此时主动
 *   断开;Host 那边虚拟窗口注销,session 转无主继续跑。
 *
 * @对应文档章节: docs/ceteris-link-protocol.md
 *
 * @不要在这里做的事:
 * - 不要缓存 / 改写 Host 推来的事件 payload(Client 是纯管道,任何"聪明"的
 *   本地状态都会与 Host 产生分歧)。唯一的例外是每个 session 的最后一个 seq
 *   (lastSeqBySession):它只用于重连补发和去重,不改写任何 payload
 * - 不要在这里判断哪些命令该转发(那是 shouldForwardToHost 的职责,统一在
 *   ipc.ts 的 handleCommand 里判断)
 *
 * @常见问题排查:
 * - 连上但窗口空白 → 看 renderer DevTools:多半是 get-snapshot 转发失败
 * - 一直 reconnecting → 看日志里的 lastError;token 不一致表现为握手后立刻断
 * - 打字有明显延迟 → 检查两端到 Tailscale 的 RTT;Link 本身不引入缓冲。
 *   dev / beta 构建可设 CETERIS_LINK_DELAY_MS 人为加延迟复现
 * - 重连后某个终端闪了一下重画 → 日志里搜 "resume":gap 表示漏掉的输出超过了
 *   Host 的 1 MiB 最近输出环,该 session 重新拉了 scrollback
 */
import { connect, type Socket } from 'node:net';
import { hostname } from 'node:os';
import { app } from 'electron';
import {
  LINK_HANDSHAKE_TIMEOUT_MS,
  LINK_HEARTBEAT_INTERVAL_MS,
  LINK_PROTOCOL_VERSION,
  type LinkAuth,
  type LinkAuthOk,
  type LinkAuthRejected,
  type LinkClientStatus,
  type LinkCommandForward,
  type LinkCommandResult,
  type LinkConnectionState,
  type LinkEventPush,
  type LinkHandshakeError,
  type LinkHello,
  type LinkHelloAck,
  type LinkMessage,
  type LinkPing,
  type LinkResume,
  type LinkResumeRequest,
} from '@shared/link-protocol';
import {
  COMMAND_CHANNELS,
  EVENT_CHANNELS,
  PROTOCOL_VERSION,
  type AppResyncPayload,
  type EventEnvelope,
  type LinkConnectionStatePayload,
  type SessionDestroyedPayload,
  type SessionOutputPayload,
  type SessionOwnerChangedPayload,
} from '@shared/protocol';
import type { AppSnapshot } from '@shared/types';
import { encodeFrame, FrameDecodeError, FrameDecoder } from './frame-codec';
import {
  createCipherPair,
  deriveSessionKeys,
  generateEphemeralKeyPair,
  generateHandshakeNonce,
  type LinkCipherStream,
} from './link-crypto';
import { computeReconnectDelay, LinkLiveness } from './link-liveness';
import type { CreateWindowOptions, WindowManager } from '../window-manager';
import { logger } from '../logger';
import { applyLocalThemeToLinkEvent } from '../ipc';

/** 单条 Link 连接的配置。 */
export interface LinkClientConfig {
  /** 用户给这台 Host 起的名字,仅用于 UI 与日志 */
  label: string;
  host: string;
  port: number;
  token: string;
}

export interface LinkClientDeps {
  windowManager: WindowManager;
  /** 创建远程窗口时合并的基础 options(窗口尺寸等,来自 settings.windowDefaults) */
  getWindowOptions: () => CreateWindowOptions;
  /** 连接状态变化时回调,供 LinkManager 广播给 renderer 渲染状态条 */
  onStatusChange: (linkId: string, status: LinkClientStatus) => void;
  /**
   * 每个出站帧额外等待的毫秒数,模拟 DERP 中继延迟。只有 dev / beta 构建会传非 0,
   * 见 link-liveness.ts 的 readLinkDelayMs。
   */
  outboundDelayMs?: number;
  /** Fires once per connection, after the hidden remote window exists. */
  onRemoteWindowCreated?: (windowId: string) => void;
  /**
   * Sees every Host event delivered to the remote window, after delivery. ADR-048 uses it
   * to notify on this machine when a tab this window holds finishes a turn.
   */
  onRemoteEvent?: (windowId: string, channel: string, envelope: unknown) => void;
}

/** 一次转发命令的等待上限。超时后向 renderer reject,避免 UI 永远转圈。 */
const COMMAND_TIMEOUT_MS = 30_000;

/**
 * 一条到远端 Host 的连接,以及它在本地对应的那个窗口。
 */
export class LinkClient {
  private socket: Socket | null = null;
  private decoder = new FrameDecoder();
  private send: LinkCipherStream | null = null;
  private recv: LinkCipherStream | null = null;

  private keyPair = generateEphemeralKeyPair();
  private clientNonce = generateHandshakeNonce();

  private state: LinkConnectionState = 'idle';
  private hostName = '';
  private lastError = '';
  private rttMs: number | null = null;
  /** TCP is up but auth-ok has not arrived. A close in this window is a rejection. */
  private awaitingAuthOk = false;

  /**
   * Host 分配的虚拟 windowId,同时也是本地那个远程窗口的 id。
   * 重连时作为 preferredWindowId 送回 Host 以保持身份稳定。
   */
  private windowId: string | null = null;
  /** 本地窗口是否已创建。重连时不重复创建,只 reload。 */
  private windowCreated = false;

  private nextCommandId = 1;
  private readonly pending = new Map<
    number,
    {
      channel: string;
      /** get-scrollback / claim 的目标 session,结果回来时记它的 lastSeq */
      sessionId: string | null;
      resolve: (v: unknown) => void;
      reject: (e: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  /** 见 LinkConnectionStatePayload.unconfirmedInputs */
  private unconfirmedInputs = 0;

  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  /** 当前这次重连实际要等的毫秒数(含抖动),供状态条显示 */
  private reconnectDelayMs: number | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private handshakeTimer: NodeJS.Timeout | null = null;
  /** 活性判断(ADR-050)。认证通过时新建,断开时丢弃 */
  private liveness: LinkLiveness | null = null;
  private livenessTimer: NodeJS.Timeout | null = null;
  private laggy = false;
  /** 用户主动断开时置位,阻止自动重连 */
  private disposed = false;

  /**
   * ADR-050:sessionId → 已交给窗口的最后一个 seq。来源是注入的 evt:session:output
   * 和转发回来的 get-scrollback / claim 结果。重连时作为 resume 请求发给 Host,
   * 平时用来丢掉重复的输出。session 关闭或被别的窗口接管时删除。
   */
  private readonly lastSeqBySession = new Map<string, number>();
  /** 这次认证带了 resume,auth-ok 之后等 Host 的 resume 消息 */
  private resumeRequested = false;

  constructor(
    readonly id: string,
    private config: LinkClientConfig,
    private readonly deps: LinkClientDeps,
  ) {}

  /**
   * 连接是否已终止。
   *
   * 写成方法而不是直接比较 this.state:handleHandshakeFrame /
   * handleEncryptedFrame 可能在循环中途通过 fail() 把 state 改成 'closed',
   * TS 的控制流分析看不到跨方法赋值,会把循环里的比较判成恒假并报 TS2367。
   */
  private isClosed(): boolean {
    return this.state === 'closed';
  }

  get targetAddress(): string {
    return `${this.config.host}:${this.config.port}`;
  }

  /** 该连接当前绑定的本地窗口 id(未连接时 null)。 */
  get boundWindowId(): string | null {
    return this.windowId;
  }

  getStatus(): LinkClientStatus {
    return {
      state: this.state,
      hostName: this.hostName,
      address: this.targetAddress,
      rttMs: this.rttMs,
      lastError: this.lastError,
      nextRetryInMs: this.state === 'reconnecting' ? this.reconnectDelayMs : null,
      laggy: this.state === 'connected' && this.laggy,
    };
  }

  /** 远程窗口展示连接状态所需的全部信息。 */
  getConnectionState(): LinkConnectionStatePayload {
    return {
      state: this.state,
      hostName: this.hostName,
      address: this.targetAddress,
      lastError: this.lastError,
      unconfirmedInputs: this.unconfirmedInputs,
      laggy: this.state === 'connected' && this.laggy,
    };
  }

  /** 用户确认已看过"输入未确认"提示。 */
  acknowledgeUnconfirmed(): void {
    this.unconfirmedInputs = 0;
    this.pushConnectionStateToWindow();
  }

  /**
   * 发起连接。幂等:已连接或正在连接时直接返回。
   */
  connect(): void {
    if (this.disposed) return;
    if (this.state === 'connecting' || this.state === 'connected') return;

    this.setState(this.reconnectAttempt > 0 ? 'reconnecting' : 'connecting');

    // 每次连接都要用全新的临时密钥与 nonce。复用会破坏前向保密,而且旧的
    // 计数器状态残留会让新连接第一帧就解密失败。
    this.keyPair = generateEphemeralKeyPair();
    this.clientNonce = generateHandshakeNonce();
    this.decoder = new FrameDecoder();
    this.send = null;
    this.recv = null;

    const socket = connect({ host: this.config.host, port: this.config.port });
    this.socket = socket;
    socket.setNoDelay(true); // 终端交互延迟敏感,理由同 link-server

    socket.on('connect', () => {
      logger.info('LinkClient', `TCP 已连上 ${this.targetAddress},开始握手`);
      this.awaitingAuthOk = true;
      this.writePlain<LinkHello>({
        type: 'hello',
        linkVersion: LINK_PROTOCOL_VERSION,
        clientPublicKey: this.keyPair.publicKeyRaw.toString('base64'),
        clientNonce: this.clientNonce.toString('base64'),
      });
      this.handshakeTimer = setTimeout(() => {
        if (this.state !== 'connected') {
          this.fail('握手超时。对方端口可能不是 Ceteris Link,或网络被中间设备拦截。');
        }
      }, LINK_HANDSHAKE_TIMEOUT_MS);
    });

    socket.on('data', (chunk) => this.handleData(chunk));
    socket.on('error', (err: NodeJS.ErrnoException) => {
      this.fail(describeConnectError(err, this.config));
    });
    socket.on('close', () => {
      if (this.state === 'closed') return;
      // A wrong token only shows up on the Host: it cannot decrypt our first frame
      // and hangs up without a reply, so a silent close here is the only signal.
      this.fail(
        this.awaitingAuthOk
          ? 'Host 在认证阶段断开了连接,最常见的原因是两端令牌不一致。请重新复制 Host 的访问令牌。'
          : this.lastError || '连接已断开',
      );
    });
  }

  /**
   * 用户主动断开。不会自动重连;本地窗口保留(内容变成断线提示)由调用方决定。
   */
  disconnect(reason = 'user-disconnect'): void {
    this.disposed = true;
    this.teardownSocket(reason);
    this.setState('closed');
    if (this.windowId) {
      this.deps.windowManager.unmarkWindowRemote(this.windowId);
    }
  }

  /** 更新配置(用户在设置里改了地址 / token),会触发一次重连。 */
  /** Title bar name of this Host: what the user typed, else what the Host reported. */
  get label(): string {
    return this.config.label || this.hostName || this.config.host;
  }

  updateConfig(config: LinkClientConfig): void {
    this.config = config;
    this.reconnectAttempt = 0;
    this.teardownSocket('config-changed');
    this.connect();
  }

  /**
   * 转发一条命令到 Host 并等待结果。
   *
   * 命令只发送一次,不排队、不重试。未连接时直接失败,所以断线期间的按键不会在
   * 重连后补发;发出后没收到确认的命令结果未知,也不重发。这样重连不可能造成
   * 同一条命令执行两次。
   *
   * @throws Error 未连接、超时,或 Host 侧 handler 抛出的业务错误
   *   (错误的 code 字段会被保留,renderer 的 try/catch 分支因此仍然有效)
   */
  forwardCommand(channel: string, payload: unknown): Promise<unknown> {
    if (this.state !== 'connected' || !this.send) {
      return Promise.reject(
        new Error(
          `[LinkClient] 与 ${this.config.label}(${this.targetAddress})的连接当前不可用` +
            `(状态:${this.state})。等待自动重连,或在设置里检查地址与 token。`,
        ),
      );
    }

    const id = this.nextCommandId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.noteUnconfirmed(channel);
        this.pushConnectionStateToWindow();
        reject(
          new Error(
            `[LinkClient] 命令 ${channel} 等待 Host 响应超过 ${COMMAND_TIMEOUT_MS}ms。` +
              `可能原因:(1) 网络极慢或已中断;(2) Host 端该命令卡住了。` +
              `建议:看 Host 的日志。`,
          ),
        );
      }, COMMAND_TIMEOUT_MS);

      const sessionId = (payload as { sessionId?: unknown } | null)?.sessionId;
      this.pending.set(id, {
        channel,
        sessionId: typeof sessionId === 'string' ? sessionId : null,
        resolve,
        reject,
        timer,
      });
      this.writeEncrypted<LinkCommandForward>({ type: 'cmd', id, channel, payload });
      if (channel === COMMAND_CHANNELS.SESSION_SEND_INPUT && this.liveness) {
        this.liveness.noteInputSent(Date.now());
        this.scheduleLivenessCheck();
      }
    });
  }

  // ────────────────────────────────────────────────────────────────
  // 内部
  // ────────────────────────────────────────────────────────────────

  private noteUnconfirmed(channel: string): void {
    if (channel === COMMAND_CHANNELS.SESSION_SEND_INPUT) this.unconfirmedInputs++;
  }

  private handleData(chunk: Buffer): void {
    if (this.state === 'closed') return;
    // 任何入站字节都算活动,也清掉"变慢"(ADR-050)
    // 不在这里重排定时器:大量输出时每个 chunk 都重建定时器太浪费。已排的定时器
    // 到点后按最新的入站时间重新判断,并排下一次。
    if (this.liveness) {
      this.liveness.noteInbound(Date.now());
      this.setLaggy(false);
      if (!this.livenessTimer) this.scheduleLivenessCheck();
    }

    let frames: Buffer[];
    try {
      frames = this.decoder.push(chunk);
    } catch (err) {
      if (err instanceof FrameDecodeError) {
        this.fail(
          `收到无法解析的数据。目标端口 ${this.targetAddress} 上运行的多半不是 ` +
            `Ceteris Link Host。请确认端口号,以及 Host 端已打开"允许远程连接"。`,
        );
      } else {
        this.fail(`分帧失败:${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }

    for (const frame of frames) {
      if (this.isClosed()) return;
      try {
        if (!this.recv) this.handleHandshakeFrame(frame);
        else this.handleEncryptedFrame(frame);
      } catch (err) {
        this.fail(err instanceof Error ? err.message : String(err));
        return;
      }
    }
  }

  private handleHandshakeFrame(frame: Buffer): void {
    const msg = JSON.parse(frame.toString('utf8')) as LinkHelloAck | LinkHandshakeError;
    if (msg.type === 'handshake-error') {
      throw new Error(msg.message);
    }
    if (msg.type !== 'hello-ack') {
      throw new Error(`握手阶段收到非预期消息:type=${String((msg as { type: string }).type)}`);
    }

    const serverPublicKeyRaw = Buffer.from(msg.serverPublicKey, 'base64');
    const serverNonce = Buffer.from(msg.serverNonce, 'base64');

    const keys = deriveSessionKeys({
      ownPrivateKey: this.keyPair.privateKey,
      peerPublicKeyRaw: serverPublicKeyRaw,
      clientPublicKeyRaw: this.keyPair.publicKeyRaw,
      serverPublicKeyRaw,
      clientNonce: this.clientNonce,
      serverNonce,
      token: this.config.token,
    });
    const pair = createCipherPair(keys, 'client');
    this.send = pair.send;
    this.recv = pair.recv;
    this.decoder.raiseLimit();

    // 窗口已经存在 = 这是重连。带上 resume,Host 原地同步,不用 reload(ADR-050)。
    const resume: LinkResumeRequest | null = this.windowCreated
      ? {
          sessions: [...this.lastSeqBySession].map(([sessionId, afterSeq]) => ({
            sessionId,
            afterSeq,
          })),
        }
      : null;
    this.resumeRequested = resume !== null;
    this.writeEncrypted<LinkAuth>({
      type: 'auth',
      clientName: hostname(),
      clientVersion: app.getVersion(),
      ipcProtocolVersion: PROTOCOL_VERSION,
      ...(this.windowId ? { preferredWindowId: this.windowId } : {}),
      ...(resume ? { resume } : {}),
    });
  }

  private handleEncryptedFrame(frame: Buffer): void {
    if (!this.recv) return;
    const plaintext = this.recv.decrypt(frame);
    const msg = JSON.parse(plaintext.toString('utf8')) as LinkMessage;

    switch (msg.type) {
      case 'auth-ok':
        this.completeAuth(msg);
        break;
      case 'auth-rejected':
        throw new Error((msg as LinkAuthRejected).message);
      case 'cmd-result':
        this.resolveCommand(msg);
        break;
      case 'evt':
        this.injectEvent(msg);
        break;
      case 'ping':
        this.writeEncrypted({ type: 'pong', t: msg.t });
        break;
      case 'pong':
        this.rttMs = Date.now() - msg.t;
        break;
      case 'bye':
        this.fail(`Host 主动断开:${msg.reason}`);
        break;
      case 'resume':
        this.applyResume(msg);
        break;
      default:
        logger.info('LinkClient', `忽略未知消息类型:${String((msg as { type: string }).type)}`);
    }
  }

  /**
   * 认证成功:建立(或复用)本地窗口,并把它标记为远程窗口。
   */
  private completeAuth(msg: LinkAuthOk): void {
    // 本地窗口的 id 在创建时固定,换不了。Host 应当总是归还原 id,对不上时必须
    // 报错:继续下去窗口收不到任何事件,却显示"已连接"。
    if (this.windowCreated && msg.virtualWindowId !== this.windowId) {
      throw new Error(
        `Host 分配了新的窗口 id(${msg.virtualWindowId}),与本地窗口 ${this.windowId} ` +
          `不一致。可能原因:(1) Host 拒绝复用该 id;(2) 两端版本不一致。` +
          `建议:关闭这个远程窗口后重新连接。`,
      );
    }

    if (this.handshakeTimer) {
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = null;
    }

    this.hostName = msg.hostName;
    this.lastError = '';
    this.awaitingAuthOk = false;
    this.reconnectAttempt = 0;
    this.windowId = msg.virtualWindowId;
    this.setState('connected');

    // 标记必须在窗口创建之前:窗口一 load,renderer 立刻开始 handshake 并发
    // cmd:app:get-snapshot;如果那一刻还没标记成远程窗口,这条命令会被本地
    // 守护进程处理,renderer 会先拿到一份本机的 snapshot 再被远端数据覆盖,
    // 表现为窗口闪一下本地内容。
    this.deps.windowManager.markWindowRemote(msg.virtualWindowId, this.id);

    if (!this.windowCreated) {
      const base = this.deps.getWindowOptions();
      this.deps.windowManager.createWindow({
        ...base,
        forcedWindowId: msg.virtualWindowId,
        startHidden: true,
      });
      this.windowCreated = true;
      this.deps.onRemoteWindowCreated?.(msg.virtualWindowId);
      logger.info(
        'LinkClient',
        `已连接 ${msg.hostName}(${this.targetAddress}),创建远程窗口 ` +
          `${msg.virtualWindowId}(Window ${msg.virtualWindowNumber})`,
      );
    } else if (this.resumeRequested) {
      // 重连路径(ADR-050):窗口里的状态停在断线那一刻。Host 紧接着发 resume,
      // 由 applyResume 原地同步,不再整页 reload。
      logger.info('LinkClient', `重连成功,等待 Host 的 resume(窗口 ${msg.virtualWindowId})`);
    } else {
      this.reloadWindow('重连时没有带 resume');
    }

    this.liveness = new LinkLiveness(Date.now());
    this.laggy = false;
    this.scheduleLivenessCheck();
    this.startHeartbeat();
    // setState('connected') 发生在窗口创建之前,那一刻还没有 webContents 可推。
    // 这里补一次,确保新窗口一挂载就能拿到"已连接 + Host 名字"。
    this.pushConnectionStateToWindow();
  }

  /**
   * 处理 Host 的 resume(ADR-050):用新 snapshot 原地同步窗口,不 reload。
   *
   * 时序由 Host 保证:resume 之后依次是漏掉的输出(普通 evt 帧)和认证期间攒下的
   * 事件,所以这里只需按顺序注入。重叠的输出靠 lastSeqBySession 去重。
   *
   * @副作用 向窗口发 evt:app:resync;删掉不再属于本窗口的 session 的 seq 记录;
   *   Host 无法原地恢复时 reload 窗口(最后手段)
   */
  private applyResume(msg: LinkResume): void {
    this.resumeRequested = false;
    const replaySessionIds: string[] = [];
    for (const s of msg.sessions) {
      if (s.status === 'replayed') continue;
      this.lastSeqBySession.delete(s.sessionId);
      if (s.status === 'gap') replaySessionIds.push(s.sessionId);
    }
    if (!msg.snapshot) {
      this.lastSeqBySession.clear();
      this.reloadWindow('Host 无法原地恢复');
      return;
    }
    logger.info(
      'LinkClient',
      `resume:${msg.sessions.length} 个 session,需要重新拉 scrollback 的 ` +
        `${replaySessionIds.length} 个(${replaySessionIds.join(',') || '无'})`,
    );
    const envelope: EventEnvelope<AppResyncPayload> = {
      eventId: `link-resume-${Date.now()}`,
      timestamp: Date.now(),
      payload: { snapshot: msg.snapshot as AppSnapshot, replaySessionIds },
    };
    this.sendToWindow(EVENT_CHANNELS.APP_RESYNC, envelope);
  }

  /** 整页 reload 远程窗口:renderer 重新握手、拉 snapshot。只在无法原地恢复时用。 */
  private reloadWindow(reason: string): void {
    if (!this.windowId) return;
    const win = this.deps.windowManager.getById(this.windowId);
    if (win && !win.isDestroyed()) {
      logger.info('LinkClient', `reload 远程窗口 ${this.windowId}:${reason}`);
      win.webContents.reload();
    }
  }

  /**
   * 记下"窗口已经拿到 seq 为止的输出"。只前进不后退。
   *
   * @returns false 表示这个 seq 已经交过,调用方应丢弃这条输出
   */
  private advanceSeq(sessionId: string, seq: number): boolean {
    const prev = this.lastSeqBySession.get(sessionId);
    if (prev !== undefined && seq <= prev) return false;
    this.lastSeqBySession.set(sessionId, seq);
    return true;
  }

  /**
   * 维护 lastSeqBySession。
   *
   * @returns false 表示这条事件是重复的输出,不该注入
   */
  private trackEvent(msg: LinkEventPush): boolean {
    // payload 来自网络,形状不对时不参与去重,原样交给窗口(与改动前的行为一致)
    const payload = (msg.envelope as EventEnvelope<unknown> | null)?.payload;
    if (!payload || typeof payload !== 'object') return true;
    switch (msg.channel) {
      case EVENT_CHANNELS.SESSION_OUTPUT: {
        const p = payload as Partial<SessionOutputPayload>;
        if (typeof p.sessionId !== 'string' || typeof p.seq !== 'number') return true;
        return this.advanceSeq(p.sessionId, p.seq);
      }
      case EVENT_CHANNELS.SESSION_DESTROYED:
        this.lastSeqBySession.delete((payload as SessionDestroyedPayload).sessionId);
        return true;
      case EVENT_CHANNELS.SESSION_OWNER_CHANGED: {
        const p = payload as SessionOwnerChangedPayload;
        if (p.newOwnerWindowId !== this.windowId) this.lastSeqBySession.delete(p.sessionId);
        return true;
      }
      default:
        return true;
    }
  }

  private sendToWindow(channel: string, envelope: unknown): void {
    if (!this.windowId) return;
    const win = this.deps.windowManager.getById(this.windowId);
    if (!win || win.isDestroyed()) return;
    win.webContents.send(channel, applyLocalThemeToLinkEvent(channel, envelope));
  }

  private resolveCommand(msg: LinkCommandResult): void {
    const entry = this.pending.get(msg.id);
    if (!entry) return; // 已超时的命令,结果晚到,丢弃
    this.pending.delete(msg.id);
    clearTimeout(entry.timer);

    if (msg.ok) {
      // get-scrollback 与 claim 带"快照时刻的 lastSeq",窗口之后只写更大的 seq。
      // 记下它,重连时没有新输出的 session 也能补(ADR-050)。
      const lastSeq = (msg.result as { lastSeq?: unknown } | null)?.lastSeq;
      if (
        entry.sessionId &&
        typeof lastSeq === 'number' &&
        (entry.channel === COMMAND_CHANNELS.SESSION_GET_SCROLLBACK ||
          entry.channel === COMMAND_CHANNELS.SESSION_CLAIM)
      ) {
        this.advanceSeq(entry.sessionId, lastSeq);
      }
      entry.resolve(msg.result);
      return;
    }
    // 保留 Host 端的 error code:renderer 里大量 `if (e.code === 'CwdNotAccessible')`
    // 这样的分支依赖它。丢掉 code 会让远程窗口的错误处理全部退化成通用提示。
    const err = new Error(msg.error?.message ?? '远端命令执行失败') as Error & {
      code?: string;
    };
    err.code = msg.error?.code ?? 'Internal';
    entry.reject(err);
  }

  /**
   * 把 Host 推来的事件注入本地窗口的 renderer。
   *
   * 直接原样 webContents.send:envelope 已经是 Host 端 wrapEvent 包好的结构,
   * preload 的 on() 会剥掉外壳把 payload 交给业务代码,与本地路径完全一致。
   *
   * ADR-050:顺带维护 lastSeqBySession。重复的输出(seq 不大于已交出的)丢弃:
   * 重连补发与认证期间攒下的事件可能有重叠。
   */
  private injectEvent(msg: LinkEventPush): void {
    if (!this.trackEvent(msg)) return;
    if (!this.windowId) return;
    const win = this.deps.windowManager.getById(this.windowId);
    if (!win || win.isDestroyed()) return;
    win.webContents.send(msg.channel, applyLocalThemeToLinkEvent(msg.channel, msg.envelope));
    this.deps.onRemoteEvent?.(this.windowId, msg.channel, msg.envelope);
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      if (this.state !== 'connected') return;
      this.writeEncrypted<LinkPing>({ type: 'ping', t: Date.now() });
      this.liveness?.notePingSent(Date.now());
      this.scheduleLivenessCheck();
    }, LINK_HEARTBEAT_INTERVAL_MS);
  }

  /**
   * 在活性判定下一次可能变化的时刻再看一次。发 ping、发输入、定时器到点后重排
   * (入站只在没有定时器时才排),任何时刻只有一个活性定时器。
   */
  private scheduleLivenessCheck(): void {
    if (!this.liveness) return;
    if (this.livenessTimer) clearTimeout(this.livenessTimer);
    const now = Date.now();
    const delay = Math.max(0, this.liveness.nextCheckAt(now) - now);
    this.livenessTimer = setTimeout(() => {
      this.livenessTimer = null;
      this.checkLiveness();
    }, delay);
  }

  private checkLiveness(): void {
    if (!this.liveness || this.isClosed()) return;
    const verdict = this.liveness.verdict(Date.now());
    if (verdict.dead) {
      this.fail('心跳超时,连接已失效(Host 可能休眠或网络中断)。正在重连…');
      return;
    }
    this.setLaggy(verdict.laggy);
    this.scheduleLivenessCheck();
  }

  /** 切换"变慢"标记,有变化才推给窗口和设置页。 */
  private setLaggy(laggy: boolean): void {
    if (this.laggy === laggy) return;
    this.laggy = laggy;
    if (this.state !== 'connected') return;
    if (laggy) logger.info('LinkClient', `${this.targetAddress} 没有回音,标记为变慢`);
    this.deps.onStatusChange(this.id, this.getStatus());
    this.pushConnectionStateToWindow();
  }

  /**
   * 写一个帧。设了人工延迟时推迟写出:同一延迟的 setTimeout 按注册顺序触发,
   * 帧序(以及 GCM 计数器的顺序)不会乱。
   */
  private writeFrame(frame: Buffer): void {
    const socket = this.socket;
    if (!socket || socket.destroyed) return;
    const delay = this.deps.outboundDelayMs ?? 0;
    if (delay <= 0) {
      socket.write(frame);
      return;
    }
    setTimeout(() => {
      if (!socket.destroyed) socket.write(frame);
    }, delay);
  }

  private writePlain<T>(msg: T): void {
    this.writeFrame(encodeFrame(Buffer.from(JSON.stringify(msg), 'utf8')));
  }

  private writeEncrypted<T>(msg: T): void {
    if (!this.socket || this.socket.destroyed || !this.send) return;
    try {
      this.writeFrame(encodeFrame(this.send.encrypt(Buffer.from(JSON.stringify(msg), 'utf8'))));
    } catch (err) {
      this.fail(`发送失败:${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * 连接失败 / 断开的统一入口:清理 socket、拒掉所有在途命令、安排重连。
   *
   * 拒掉在途命令很重要:renderer 里每个 invoke 都在 await,如果连接没了却不
   * reject,那些 Promise 会永远挂着,UI 上表现为按钮一直转圈、终端标签卡在
   * "创建中"。
   */
  private fail(reason: string): void {
    if (this.state === 'closed') return;
    this.lastError = reason;
    this.awaitingAuthOk = false;
    logger.warn('LinkClient', `${this.config.label}(${this.targetAddress}):${reason}`);

    this.teardownSocket('fail');

    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      this.noteUnconfirmed(entry.channel);
      entry.reject(new Error(`[LinkClient] 连接中断,命令结果未知:${reason}`));
    }
    this.pending.clear();

    if (this.disposed) {
      this.setState('closed');
      return;
    }

    // 退避从 0.5 秒起翻倍到 30 秒,带 ±20% 抖动(ADR-050)。先算好再切状态,
    // 状态条拿到的就是这一次真实的等待时间。
    const delay = computeReconnectDelay(this.reconnectAttempt);
    this.reconnectDelayMs = delay;
    this.setState('reconnecting');
    this.reconnectAttempt++;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private teardownSocket(_reason: string): void {
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.livenessTimer) clearTimeout(this.livenessTimer);
    this.handshakeTimer = null;
    this.heartbeatTimer = null;
    this.reconnectTimer = null;
    this.livenessTimer = null;
    this.liveness = null;
    this.laggy = false;
    this.resumeRequested = false;

    const socket = this.socket;
    this.socket = null;
    this.send = null;
    this.recv = null;
    if (socket && !socket.destroyed) {
      socket.removeAllListeners();
      socket.destroy();
    }
  }

  /**
   * 切换状态,并把结果通知两个受众:
   * 1. LinkManager → 广播给本机普通窗口刷新设置页
   * 2. **本连接绑定的那个远程窗口**,定向推送
   *
   * 第 2 条是必需的:远程窗口被排除在普通事件广播之外(它的数据源是 Host),
   * 广播根本到不了它。而它恰恰是最需要知道"断线了"的那个 —— 否则用户面对的
   * 就是一个毫无解释、突然不响应的终端。
   */
  private setState(state: LinkConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    this.deps.onStatusChange(this.id, this.getStatus());
    this.pushConnectionStateToWindow();
  }

  private pushConnectionStateToWindow(): void {
    if (!this.windowId) return;
    const win = this.deps.windowManager.getById(this.windowId);
    if (!win || win.isDestroyed()) return;
    win.webContents.send(EVENT_CHANNELS.LINK_CONNECTION_STATE, {
      eventId: `link-${Date.now()}`,
      timestamp: Date.now(),
      payload: this.getConnectionState(),
    });
  }
}

/**
 * 把 node 的 connect 错误翻译成用户能据以行动的中文说明。
 */
function describeConnectError(err: NodeJS.ErrnoException, config: LinkClientConfig): string {
  const target = `${config.host}:${config.port}`;
  switch (err.code) {
    case 'ECONNREFUSED':
      return (
        `${target} 拒绝连接。可能原因:(1) Host 端 Ceteris 没开"允许远程连接";` +
        `(2) 端口号填错了;(3) Host 上 Ceteris 没在运行。`
      );
    case 'ETIMEDOUT':
      return (
        `连接 ${target} 超时。可能原因:(1) 两台机器不在同一个 Tailscale 网络里;` +
        `(2) Host 关机 / 休眠;(3) 防火墙挡了这个端口。` +
        `先在客户端跑 \`tailscale ping <host>\` 确认两台机器能互通。`
      );
    case 'ENOTFOUND':
      return (
        `找不到主机 ${config.host}。检查地址是否拼错;使用 MagicDNS 名称时确认本机 ` +
        `Tailscale 已连接,或改填 Host 的 100.x.y.z。`
      );
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return `无法路由到 ${config.host}。检查 Tailscale 是否在两端都已连接。`;
    default:
      return `连接 ${target} 失败:${err.message}`;
  }
}
