/**
 * @file src/main/link/link-client.ts
 * @purpose Marina Link 的 Client 侧。连到远端 Host,开一个本地窗口作为它的
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
 *   id,于是重连只需要 reload 一次 renderer,窗口位置、窗口 id、session 归属
 *   全部原样恢复。
 * - **本地窗口关闭 = 断开连接**。用户关掉远程窗口就是"我不看了",此时主动
 *   断开;Host 那边虚拟窗口注销,session 转无主继续跑。
 *
 * @对应文档章节: docs/marina-link-protocol.md
 *
 * @不要在这里做的事:
 * - 不要缓存 / 改写 Host 推来的事件 payload(Client 是纯管道,任何"聪明"的
 *   本地状态都会与 Host 产生分歧)
 * - 不要在这里判断哪些命令该转发(那是 shouldForwardToHost 的职责,统一在
 *   ipc.ts 的 handleCommand 里判断)
 *
 * @常见问题排查:
 * - 连上但窗口空白 → 看 renderer DevTools:多半是 get-snapshot 转发失败
 * - 一直 reconnecting → 看日志里的 lastError;token 不一致表现为握手后立刻断
 * - 打字有明显延迟 → 检查两端到 Tailscale 的 RTT;Link 本身不引入缓冲
 */
import { connect, type Socket } from 'node:net';
import { hostname } from 'node:os';
import { app } from 'electron';
import {
  LINK_HANDSHAKE_TIMEOUT_MS,
  LINK_HEARTBEAT_INTERVAL_MS,
  LINK_HEARTBEAT_TIMEOUT_MS,
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
} from '@shared/link-protocol';
import {
  COMMAND_CHANNELS,
  EVENT_CHANNELS,
  PROTOCOL_VERSION,
  type LinkConnectionStatePayload,
} from '@shared/protocol';
import { encodeFrame, FrameDecodeError, FrameDecoder } from './frame-codec';
import {
  createCipherPair,
  deriveSessionKeys,
  generateEphemeralKeyPair,
  generateHandshakeNonce,
  type LinkCipherStream,
} from './link-crypto';
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
  /** Fires once per connection, after the hidden remote window exists. */
  onRemoteWindowCreated?: (windowId: string) => void;
}

/**
 * 重连退避序列(毫秒)。
 *
 * 前几次快速重试覆盖"Wi-Fi 抖一下"这类瞬时故障;之后拉长到 30 秒,避免
 * Host 关机时客户端每秒疯狂重连、刷爆日志也浪费电。到顶后保持 30 秒不再增长,
 * 这样用户把 Host 开机后最多等半分钟就会自动恢复,不需要手动点重连。
 */
const RECONNECT_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

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
      resolve: (v: unknown) => void;
      reject: (e: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  /** 见 LinkConnectionStatePayload.unconfirmedInputs */
  private unconfirmedInputs = 0;

  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private handshakeTimer: NodeJS.Timeout | null = null;
  private lastInboundAt = 0;
  /** 用户主动断开时置位,阻止自动重连 */
  private disposed = false;

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
      nextRetryInMs:
        this.state === 'reconnecting'
          ? (RECONNECT_BACKOFF_MS[
              Math.min(this.reconnectAttempt, RECONNECT_BACKOFF_MS.length - 1)
            ] ?? null)
          : null,
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
      this.lastInboundAt = Date.now();
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
          this.fail('握手超时。对方端口可能不是 Marina Link,或网络被中间设备拦截。');
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

      this.pending.set(id, { channel, resolve, reject, timer });
      this.writeEncrypted<LinkCommandForward>({ type: 'cmd', id, channel, payload });
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
    this.lastInboundAt = Date.now();

    let frames: Buffer[];
    try {
      frames = this.decoder.push(chunk);
    } catch (err) {
      if (err instanceof FrameDecodeError) {
        this.fail(
          `收到无法解析的数据。目标端口 ${this.targetAddress} 上运行的多半不是 ` +
            `Marina Link Host。请确认端口号,以及 Host 端已打开"允许远程连接"。`,
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

    this.writeEncrypted<LinkAuth>({
      type: 'auth',
      clientName: hostname(),
      clientVersion: app.getVersion(),
      ipcProtocolVersion: PROTOCOL_VERSION,
      ...(this.windowId ? { preferredWindowId: this.windowId } : {}),
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
    } else {
      // 重连路径:窗口还在,但它的 renderer 持有的是断线前的旧状态(session
      // 列表、scrollback、owner 归属都可能已经变了)。最稳的做法是整页 reload:
      // renderer 会重新 handshake、重新拉 snapshot、重新 claim,回到与 Host
      // 完全一致的状态。相比"手工对账增量事件",reload 慢一点但不可能出错。
      const win = this.deps.windowManager.getById(msg.virtualWindowId);
      if (win && !win.isDestroyed()) {
        logger.info('LinkClient', `重连成功,reload 远程窗口 ${msg.virtualWindowId}`);
        win.webContents.reload();
      }
    }

    this.startHeartbeat();
    // setState('connected') 发生在窗口创建之前,那一刻还没有 webContents 可推。
    // 这里补一次,确保新窗口一挂载就能拿到"已连接 + Host 名字"。
    this.pushConnectionStateToWindow();
  }

  private resolveCommand(msg: LinkCommandResult): void {
    const entry = this.pending.get(msg.id);
    if (!entry) return; // 已超时的命令,结果晚到,丢弃
    this.pending.delete(msg.id);
    clearTimeout(entry.timer);

    if (msg.ok) {
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
   */
  private injectEvent(msg: LinkEventPush): void {
    if (!this.windowId) return;
    const win = this.deps.windowManager.getById(this.windowId);
    if (!win || win.isDestroyed()) return;
    win.webContents.send(msg.channel, applyLocalThemeToLinkEvent(msg.channel, msg.envelope));
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      if (this.state !== 'connected') return;
      if (Date.now() - this.lastInboundAt > LINK_HEARTBEAT_TIMEOUT_MS) {
        this.fail('心跳超时,连接已失效(Host 可能休眠或网络中断)。正在重连…');
        return;
      }
      this.writeEncrypted<LinkPing>({ type: 'ping', t: Date.now() });
    }, LINK_HEARTBEAT_INTERVAL_MS);
  }

  private writePlain<T>(msg: T): void {
    if (!this.socket || this.socket.destroyed) return;
    this.socket.write(encodeFrame(Buffer.from(JSON.stringify(msg), 'utf8')));
  }

  private writeEncrypted<T>(msg: T): void {
    if (!this.socket || this.socket.destroyed || !this.send) return;
    try {
      this.socket.write(encodeFrame(this.send.encrypt(Buffer.from(JSON.stringify(msg), 'utf8'))));
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

    this.setState('reconnecting');
    const delay =
      RECONNECT_BACKOFF_MS[Math.min(this.reconnectAttempt, RECONNECT_BACKOFF_MS.length - 1)] ??
      30_000;
    this.reconnectAttempt++;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private teardownSocket(_reason: string): void {
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.handshakeTimer = null;
    this.heartbeatTimer = null;
    this.reconnectTimer = null;

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
        `${target} 拒绝连接。可能原因:(1) Host 端 Marina 没开"允许远程连接";` +
        `(2) 端口号填错了;(3) Host 上 Marina 没在运行。`
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
