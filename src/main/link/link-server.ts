/**
 * @file src/main/link/link-server.ts
 * @purpose Ceteris Link 的 Host 侧。监听 TCP,接受经过认证的远程客户端,
 *   把每个客户端注册成一个虚拟窗口,再把它发来的命令喂进本机既有的 IPC
 *   handler,并把本机产生的事件顺着 socket 推回去。
 *
 * @关键设计:
 * - **Host 不需要理解业务**。它只做三件事:解密分帧、把命令交给
 *   dispatchLocalCommand、把事件写回 socket。所有业务语义仍然只存在于
 *   session-manager / path-manager 里,Link 没有复制任何一行业务逻辑。
 * - **虚拟窗口是支点**。注册成虚拟窗口后,远程客户端在 SessionManager 眼里
 *   与本地窗口完全等价:它能 claim session、能成为 owner、断开时走同一条
 *   handleWindowClosed 清理路径。
 * - **断开 = 关窗**。socket 断掉时注销虚拟窗口,ipc.ts 注册的 onWindowClosed
 *   会把它持有的 session 全部转为无主。PTY 一直在跑,Host 本机窗口可以立刻
 *   接管 —— 这正是 Ceteris "会话不随窗口死" 哲学在远程场景下的自然延伸。
 * - **重连恢复归属**。意外断线时记下该客户端持有的 session,同一 windowId 重连后
 *   重新接管。这里不保留"挂起的虚拟窗口",因为那样 Host 本机在客户端回来之前
 *   无法使用这些 session。只恢复仍然无主的 session,已被别处接管的不抢。
 * - **新连接取代旧连接**。Wi-Fi 切换或休眠唤醒后,客户端重连往往早于 Host 判定
 *   旧连接超时。新连接带着相同 windowId 通过认证时立即断开旧连接,否则客户端
 *   窗口与 Host 分配的 id 对不上,窗口会静默失效。
 * - **每条连接一个状态机**,见 LinkConnection。握手超时、心跳超时、帧过大、
 *   解密失败,任一发生都是直接 destroy socket,不做任何"尝试恢复"。
 *
 * @对应文档章节: docs/ceteris-link-protocol.md;docs/ipc-protocol.md(被搬运的内层协议)
 *
 * @不要在这里做的事:
 * - 不要在这里解释任何 cmd:/evt: 的语义(那是 ipc.ts 的职责)
 * - 不要绕过 dispatchLocalCommand 直接调 SessionManager(会绕开日志与校验)
 * - 不要为了"省一次拷贝"把 socket 的 Buffer 直接交给上层(见 frame-codec 注释)
 *
 * @常见问题排查:
 * - 客户端连上立刻断 → 看日志里有没有 "帧认证失败":几乎总是两端 token 不一致
 * - 监听失败 EADDRINUSE → 端口被占,换端口或关掉占用进程
 * - 监听失败 EADDRNOTAVAIL → bindAddress 填了一个本机没有的 IP(常见于
 *   Tailscale 还没起来就启动了 Ceteris),改成 auto 或等 Tailscale 就绪后重开
 */
import { createServer, type Server, type Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { app } from 'electron';
import { hostname } from 'node:os';
import {
  LINK_HANDSHAKE_TIMEOUT_MS,
  LINK_HEARTBEAT_INTERVAL_MS,
  LINK_HEARTBEAT_TIMEOUT_MS,
  LINK_MAX_CLIENTS,
  LINK_MAX_WRITE_BACKLOG_BYTES,
  LINK_PROTOCOL_VERSION,
  LINK_RESUME_TTL_MS,
  type LinkAuth,
  type LinkAuthOk,
  type LinkAuthRejected,
  type LinkCommandForward,
  type LinkCommandResult,
  type LinkEventPush,
  type LinkHandshakeError,
  type LinkHello,
  type LinkHelloAck,
  type LinkHostClientInfo,
  type LinkHostStatus,
  type LinkMessage,
  type LinkPong,
  LINK_DEFAULT_PORT,
} from '@shared/link-protocol';
import { COMMAND_CHANNELS, PROTOCOL_VERSION, type CommandEnvelope } from '@shared/protocol';
import { encodeFrame, FrameDecodeError, FrameDecoder } from './frame-codec';
import {
  createCipherPair,
  deriveSessionKeys,
  generateEphemeralKeyPair,
  generateHandshakeNonce,
  type LinkCipherStream,
} from './link-crypto';
import { dispatchLocalCommand } from '../ipc';
import type { WindowManager } from '../window-manager';
import { logger } from '../logger';

/** LinkServer 需要的外部依赖。保持最小,便于将来加测试替身。 */
export interface LinkServerDeps {
  windowManager: WindowManager;
  /** 取当前 token。用回调而非值,这样用户在设置里重新生成 token 后立即生效。 */
  getToken: () => string;
  /** 列出某窗口持有的 session,意外断线时记下,重连后恢复。 */
  getOwnedSessionIds: (windowId: string) => string[];
  /** 覆盖写缓冲上限,仅测试使用。 */
  maxWriteBacklogBytes?: number;
}

/** LinkConnection 需要 LinkServer 提供的能力。 */
interface ConnectionHooks {
  onClosed: (conn: LinkConnection) => void;
  /** 断开占用该 windowId 的旧连接(如果有)。 */
  releaseWindow: (windowId: string) => void;
  rememberOwned: (windowId: string, sessionIds: string[]) => void;
  /** 取出并清除某 windowId 的待恢复记录,过期视为不存在。 */
  takeResumable: (windowId: string) => string[];
}

/**
 * 这些断开是用户的明确意图,重连后不恢复归属。其余都是意外断线。
 */
const NON_RESUMABLE_REASONS: ReadonlySet<string> = new Set(['client-bye', 'kicked-by-host']);

/** 启动监听的参数。 */
export interface LinkServerStartOptions {
  /**
   * 绑定地址。
   *
   * 强烈建议填 Tailscale 分配的 100.x.y.z,而不是 0.0.0.0:绑到具体地址
   * 等于让这个端口只在 tailnet 上可见,咖啡店的 Wi-Fi 邻居根本扫不到它。
   * 这是纵深防御的第一层(第二层才是 token + 加密)。
   */
  bindAddress: string;
  port: number;
}

/**
 * 连接的生命周期状态。
 *
 *   handshaking ──收到 hello,回 hello-ack,派生密钥──> awaiting-auth
 *   awaiting-auth ──首个加密帧解开且是 auth──> authenticating
 *   authenticating ──虚拟窗口注册完毕、归属恢复完毕──> ready
 *   任一阶段出错 / socket 断 ──> closed(终态,不可回退)
 */
type ConnectionState = 'handshaking' | 'awaiting-auth' | 'authenticating' | 'ready' | 'closed';

/**
 * 一条远程客户端连接。
 *
 * 每个实例独占一对加解密通道与一个虚拟窗口,互不影响。
 */
class LinkConnection {
  private state: ConnectionState = 'handshaking';
  private readonly decoder = new FrameDecoder();
  private send: LinkCipherStream | null = null;
  private recv: LinkCipherStream | null = null;

  /** 本端的临时密钥对,握手完成后不再需要 */
  private keyPair = generateEphemeralKeyPair();
  private serverNonce = generateHandshakeNonce();

  /** 注册到 WindowManager 后拿到的虚拟窗口 id */
  private virtualWindowId: string | null = null;
  private virtualWindowNumber = 0;

  private clientName = 'unknown';
  private clientVersion = 'unknown';
  readonly connectedAt = Date.now();
  readonly remoteAddress: string;

  private handshakeTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private lastInboundAt = Date.now();

  constructor(
    private readonly socket: Socket,
    private readonly deps: LinkServerDeps,
    private readonly hooks: ConnectionHooks,
  ) {
    this.remoteAddress = socket.remoteAddress ?? 'unknown';

    // Nagle 算法会把小包攒起来等 40ms 再发,对终端交互是致命的:每一次
    // 按键回显都会多出几十毫秒延迟,用户体感"打字有橡皮筋"。终端流量
    // 天生是大量小包,必须关掉。
    socket.setNoDelay(true);

    socket.on('data', (chunk) => this.handleData(chunk));
    socket.on('error', (err) => {
      // ECONNRESET 是客户端拔网线 / 强杀进程的正常表现,不值得 error 级别
      logger.info('LinkServer', `socket error from ${this.remoteAddress}: ${err.message}`);
      this.destroy('socket-error');
    });
    socket.on('close', () => this.destroy('socket-closed'));

    this.handshakeTimer = setTimeout(() => {
      if (this.state !== 'ready') {
        logger.warn(
          'LinkServer',
          `handshake timeout from ${this.remoteAddress} (state=${this.state}),断开`,
        );
        this.destroy('handshake-timeout');
      }
    }, LINK_HANDSHAKE_TIMEOUT_MS);
  }

  /**
   * 连接是否已终止。
   *
   * 写成方法而不是直接比较 this.state,是因为 handleHandshakeFrame /
   * handleEncryptedFrame 可能在循环中途把 state 改成 'closed',而 TS 的控制流
   * 分析看不到跨方法的赋值,会把循环里的 `this.state === 'closed'` 判成恒假
   * 并报 TS2367。方法调用切断了这条错误的窄化。
   */
  private isClosed(): boolean {
    return this.state === 'closed';
  }

  /** 这条连接是否占着指定的虚拟 windowId(含认证中的连接)。 */
  holdsWindow(windowId: string): boolean {
    return this.virtualWindowId === windowId;
  }

  /** 供设置页展示。未完成认证的连接不会出现在列表里。 */
  getInfo(): LinkHostClientInfo | null {
    if (this.state !== 'ready' || !this.virtualWindowId) return null;
    return {
      virtualWindowId: this.virtualWindowId,
      virtualWindowNumber: this.virtualWindowNumber,
      clientName: this.clientName,
      clientVersion: this.clientVersion,
      remoteAddress: this.remoteAddress,
      connectedAt: this.connectedAt,
    };
  }

  private handleData(chunk: Buffer): void {
    if (this.state === 'closed') return;
    this.lastInboundAt = Date.now();

    let frames: Buffer[];
    try {
      frames = this.decoder.push(chunk);
    } catch (err) {
      if (err instanceof FrameDecodeError) {
        logger.warn('LinkServer', `分帧失败(${this.remoteAddress}):${err.message}`);
      } else {
        logger.error('LinkServer', `分帧抛出非预期错误(${this.remoteAddress})`, err);
      }
      this.destroy('frame-error');
      return;
    }

    for (const frame of frames) {
      if (this.isClosed()) return;
      try {
        if (this.state === 'handshaking') this.handleHandshakeFrame(frame);
        else this.handleEncryptedFrame(frame);
      } catch (err) {
        // 任何一帧处理失败都是不可恢复的:要么对端不是 Ceteris,要么 token
        // 不对,要么流已经错位。继续读下去只会产生更多噪声。
        logger.warn(
          'LinkServer',
          `处理帧失败(${this.remoteAddress}, state=${this.state}):` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
        this.destroy('frame-handling-failed');
        return;
      }
    }
  }

  /**
   * 处理明文握手帧(仅 hello)。
   *
   * 成功后立即派生会话密钥并放宽帧上限;此后所有帧都必须是密文。
   */
  private handleHandshakeFrame(frame: Buffer): void {
    const msg = JSON.parse(frame.toString('utf8')) as LinkHello;
    if (msg.type !== 'hello') {
      throw new Error(`握手阶段收到非 hello 消息:type=${String(msg.type)}`);
    }
    if (msg.linkVersion !== LINK_PROTOCOL_VERSION) {
      // 版本不匹配与凭据无关,可以明确告知 —— 这不给攻击者任何有用信息,
      // 却能让用户立刻知道"两端版本不一样"而不是盲目怀疑 token。
      this.writePlain<LinkHandshakeError>({
        type: 'handshake-error',
        code: 'version-mismatch',
        message:
          `Host 的 Link 协议版本是 ${LINK_PROTOCOL_VERSION},客户端是 ${msg.linkVersion}。` +
          `请把两端 Ceteris 升级到同一版本。`,
      });
      throw new Error(`link 协议版本不匹配:client=${msg.linkVersion}`);
    }

    const clientPublicKeyRaw = Buffer.from(msg.clientPublicKey, 'base64');
    const clientNonce = Buffer.from(msg.clientNonce, 'base64');

    const keys = deriveSessionKeys({
      ownPrivateKey: this.keyPair.privateKey,
      peerPublicKeyRaw: clientPublicKeyRaw,
      clientPublicKeyRaw,
      serverPublicKeyRaw: this.keyPair.publicKeyRaw,
      clientNonce,
      serverNonce: this.serverNonce,
      token: this.deps.getToken(),
    });
    const pair = createCipherPair(keys, 'server');
    this.send = pair.send;
    this.recv = pair.recv;

    this.writePlain<LinkHelloAck>({
      type: 'hello-ack',
      linkVersion: LINK_PROTOCOL_VERSION,
      serverPublicKey: this.keyPair.publicKeyRaw.toString('base64'),
      serverNonce: this.serverNonce.toString('base64'),
    });

    // 认证边界:从这里开始对端要么掌握 token(能造出我们解得开的帧),
    // 要么下一帧就会解密失败被踢掉。可以放宽帧上限了。
    this.decoder.raiseLimit();
    this.state = 'awaiting-auth';
  }

  private handleEncryptedFrame(frame: Buffer): void {
    if (!this.recv) throw new Error('内部错误:recv 通道未初始化');
    const plaintext = this.recv.decrypt(frame);
    const msg = JSON.parse(plaintext.toString('utf8')) as LinkMessage;

    if (this.state === 'awaiting-auth') {
      if (msg.type !== 'auth') {
        throw new Error(`认证阶段收到非 auth 消息:type=${msg.type}`);
      }
      this.state = 'authenticating';
      void this.completeAuth(msg).catch((err: unknown) => {
        logger.error('LinkServer', `完成认证失败(${this.remoteAddress})`, err);
        this.destroy('auth-failed');
      });
      return;
    }

    if (this.state === 'authenticating') {
      throw new Error(`收到 auth-ok 之前客户端不应发送帧:type=${msg.type}`);
    }

    switch (msg.type) {
      case 'cmd':
        void this.handleCommandForward(msg);
        break;
      case 'ping':
        this.writeEncrypted<LinkPong>({ type: 'pong', t: msg.t });
        break;
      case 'pong':
        // 心跳回执,lastInboundAt 已在 handleData 里更新,这里无需额外动作
        break;
      case 'bye':
        logger.info('LinkServer', `客户端主动断开(${this.remoteAddress}):${msg.reason}`);
        this.destroy('client-bye');
        break;
      default:
        // 未知类型不算致命:同 major 版本内允许新增消息类型(向后兼容),
        // 老 Host 忽略掉新消息即可。
        logger.info('LinkServer', `忽略未知消息类型:${String((msg as { type: string }).type)}`);
    }
  }

  /**
   * 完成认证:校验内层 IPC 协议版本,注册虚拟窗口,恢复归属,回 auth-ok。
   *
   * 归属必须在 auth-ok 之前恢复:客户端收到 auth-ok 就会 reload 窗口并拉
   * snapshot,那一刻 session 必须已经归它所有,否则窗口会打开成空白页。
   */
  private async completeAuth(msg: LinkAuth): Promise<void> {
    if (msg.ipcProtocolVersion !== PROTOCOL_VERSION) {
      this.writeEncrypted<LinkAuthRejected>({
        type: 'auth-rejected',
        code: 'ipc-version-mismatch',
        message:
          `Host 的 IPC 协议版本是 ${PROTOCOL_VERSION},客户端是 ${msg.ipcProtocolVersion}。` +
          `两端 Ceteris 版本不一致,请升级到同一版本。`,
      });
      this.destroy('ipc-version-mismatch');
      return;
    }

    this.clientName = msg.clientName || 'unknown';
    this.clientVersion = msg.clientVersion || 'unknown';

    if (msg.preferredWindowId) this.hooks.releaseWindow(msg.preferredWindowId);

    let info;
    try {
      info = this.deps.windowManager.registerVirtualWindow((channel, envelope) => {
        this.pushEvent(channel, envelope);
      }, msg.preferredWindowId);
    } catch (err) {
      this.writeEncrypted<LinkAuthRejected>({
        type: 'auth-rejected',
        code: 'max-clients-reached',
        message: err instanceof Error ? err.message : '窗口数已达上限',
      });
      this.destroy('max-windows');
      return;
    }

    this.virtualWindowId = info.id;
    this.virtualWindowNumber = info.number;

    await this.restoreOwnership(info.id);
    if (this.isClosed()) return;
    this.state = 'ready';

    if (this.handshakeTimer) {
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = null;
    }

    this.writeEncrypted<LinkAuthOk>({
      type: 'auth-ok',
      virtualWindowId: info.id,
      virtualWindowNumber: info.number,
      hostName: hostname(),
      hostVersion: app.getVersion(),
    });

    this.startHeartbeat();

    logger.info(
      'LinkServer',
      `客户端认证通过:name="${this.clientName}" addr=${this.remoteAddress} ` +
        `虚拟窗口=${info.id} (Window ${info.number})`,
    );
  }

  /**
   * 重新接管这个客户端断线前持有的 session。
   *
   * 走 SESSION_CLAIM 而不是直接改 SessionManager,与普通接管同一条路径。
   * 接管失败是正常情况:session 可能已被 Host 本机接管或已经关闭,此时尊重现状。
   */
  private async restoreOwnership(windowId: string): Promise<void> {
    for (const sessionId of this.hooks.takeResumable(windowId)) {
      try {
        await dispatchLocalCommand(COMMAND_CHANNELS.SESSION_CLAIM, {
          windowId,
          requestId: randomUUID(),
          payload: { sessionId },
        });
        logger.info('LinkServer', `重连恢复归属:session=${sessionId} window=${windowId}`);
      } catch (err) {
        logger.info(
          'LinkServer',
          `未恢复 session=${sessionId} 的归属:` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  /**
   * 执行一条转发来的命令,把结果回给客户端。
   *
   * 注意 windowId 被强制重写为本连接的虚拟窗口 id:客户端本地的 windowId
   * 在 Host 的命名空间里没有意义,而且如果原样信任客户端传来的 windowId,
   * 一个恶意客户端就能冒充 Host 上的任意窗口去 claim / release session。
   * 这是本文件里最重要的一行安全约束。
   */
  private async handleCommandForward(msg: LinkCommandForward): Promise<void> {
    if (!this.virtualWindowId) return;
    const envelope: CommandEnvelope<unknown> = {
      windowId: this.virtualWindowId,
      requestId: randomUUID(),
      payload: msg.payload,
    };

    try {
      const result = await dispatchLocalCommand(msg.channel, envelope);
      this.writeEncrypted<LinkCommandResult>({
        type: 'cmd-result',
        id: msg.id,
        ok: true,
        result,
      });
    } catch (err) {
      const error = err as { code?: string; message?: string };
      logger.warn(
        'LinkServer',
        `命令执行失败:channel=${msg.channel} client=${this.remoteAddress} ` +
          `err=${error?.message ?? String(err)}`,
      );
      this.writeEncrypted<LinkCommandResult>({
        type: 'cmd-result',
        id: msg.id,
        ok: false,
        error: {
          code: typeof error?.code === 'string' ? error.code : 'Internal',
          message: error?.message ?? String(err),
        },
      });
    }
  }

  /** 把一条事件推给客户端。写失败静默(见 WindowManager.send 的约定)。 */
  private pushEvent(channel: string, envelope: unknown): void {
    if (this.state !== 'ready') return;
    this.writeEncrypted<LinkEventPush>({ type: 'evt', channel, envelope });
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      if (this.state !== 'ready') return;
      if (Date.now() - this.lastInboundAt > LINK_HEARTBEAT_TIMEOUT_MS) {
        logger.warn(
          'LinkServer',
          `心跳超时(${this.remoteAddress}),判定连接已死并断开。` +
            `常见原因:客户端主机休眠 / 网络中断 / NAT 表项过期。`,
        );
        this.destroy('heartbeat-timeout');
        return;
      }
      this.writeEncrypted({ type: 'ping', t: Date.now() });
    }, LINK_HEARTBEAT_INTERVAL_MS);
  }

  /** 写一个明文帧(仅握手阶段)。 */
  private writePlain<T>(msg: T): void {
    if (this.socket.destroyed) return;
    this.socket.write(encodeFrame(Buffer.from(JSON.stringify(msg), 'utf8')));
  }

  /** 写一个加密帧。 */
  private writeEncrypted<T>(msg: T): void {
    if (this.socket.destroyed || !this.send) return;
    const backlogLimit = this.deps.maxWriteBacklogBytes ?? LINK_MAX_WRITE_BACKLOG_BYTES;
    if (this.socket.writableLength > backlogLimit) {
      logger.warn(
        'LinkServer',
        `写缓冲积压 ${this.socket.writableLength} 字节超过上限 ${backlogLimit}(` +
          `${this.remoteAddress}),断开连接。客户端重连后会回放完整终端状态。`,
      );
      this.destroy('write-backlog');
      return;
    }
    try {
      const plaintext = Buffer.from(JSON.stringify(msg), 'utf8');
      this.socket.write(encodeFrame(this.send.encrypt(plaintext)));
    } catch (err) {
      // 写失败(socket 已断 / 帧超限)不能向上抛:调用方多半是事件广播,
      // 一个客户端出问题不该影响其他窗口。
      logger.warn(
        'LinkServer',
        `写帧失败(${this.remoteAddress}):${err instanceof Error ? err.message : String(err)}`,
      );
      this.destroy('write-failed');
    }
  }

  /**
   * 终止这条连接并清理一切。可重入(socket 的 error + close 会连着触发两次)。
   *
   * @副作用:
   * - 注销虚拟窗口 → 触发 onWindowClosed → SessionManager 把该客户端持有的
   *   session 全部转为无主(PTY 继续跑,Host 本机可立即接管)
   */
  destroy(reason: string): void {
    if (this.state === 'closed') return;
    this.state = 'closed';

    if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.handshakeTimer = null;
    this.heartbeatTimer = null;

    if (this.virtualWindowId) {
      logger.info(
        'LinkServer',
        `注销虚拟窗口 ${this.virtualWindowId}(reason=${reason}),` + `其持有的 session 将转为无主`,
      );
      // 必须在注销之前读:注销会触发 handleWindowClosed 清空归属
      if (!NON_RESUMABLE_REASONS.has(reason)) {
        this.hooks.rememberOwned(
          this.virtualWindowId,
          this.deps.getOwnedSessionIds(this.virtualWindowId),
        );
      }
      this.deps.windowManager.unregisterVirtualWindow(this.virtualWindowId);
      this.virtualWindowId = null;
    }

    if (!this.socket.destroyed) this.socket.destroy();
    this.hooks.onClosed(this);
  }
}

/**
 * Ceteris Link 的 Host 端服务。
 *
 * 生命周期由 LinkManager 驱动:设置里打开开关就 start,关掉就 stop,
 * 改端口 / 改绑定地址就 stop + start。
 */
export class LinkServer {
  private server: Server | null = null;
  private readonly connections = new Set<LinkConnection>();
  /** windowId → 断线时持有的 session。跨 stop/start 保留:换绑定地址也会断开客户端。 */
  private readonly resumable = new Map<string, { sessionIds: string[]; expiresAt: number }>();
  private boundAddress = '';
  private boundPort = 0;
  private lastError = '';

  constructor(private readonly deps: LinkServerDeps) {}

  /**
   * 开始监听。
   *
   * @returns 监听成功返回 true;失败返回 false 并把原因记在 lastError
   *   (不抛错:监听失败是用户配置问题,应当在设置页显示而不是崩掉主进程)
   */
  async start(options: LinkServerStartOptions): Promise<boolean> {
    await this.stop();
    this.lastError = '';

    return new Promise<boolean>((resolve) => {
      const server = createServer((socket) => this.handleConnection(socket));

      server.on('error', (err: NodeJS.ErrnoException) => {
        this.lastError = describeListenError(err, options);
        logger.error('LinkServer', `监听失败:${this.lastError}`);
        this.server = null;
        resolve(false);
      });

      server.listen(options.port, options.bindAddress, () => {
        this.server = server;
        const addr = server.address();
        if (addr && typeof addr === 'object') {
          this.boundAddress = addr.address;
          this.boundPort = addr.port;
        } else {
          this.boundAddress = options.bindAddress;
          this.boundPort = options.port;
        }
        logger.info(
          'LinkServer',
          `开始监听 ${this.boundAddress}:${this.boundPort}` +
            (options.bindAddress === '0.0.0.0'
              ? ' —— 注意:绑到 0.0.0.0 意味着同一局域网内任何人都能看到这个端口,' +
                '建议改绑 Tailscale 地址'
              : ''),
        );
        resolve(true);
      });
    });
  }

  /** 停止监听并断开所有客户端。 */
  async stop(): Promise<void> {
    for (const conn of [...this.connections]) {
      conn.destroy('server-stopping');
    }
    this.connections.clear();

    const server = this.server;
    if (!server) return;
    this.server = null;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    logger.info('LinkServer', '已停止监听');
  }

  /** 当前状态,供设置页展示。 */
  getStatus(): LinkHostStatus {
    const clients: LinkHostClientInfo[] = [];
    for (const conn of this.connections) {
      const info = conn.getInfo();
      if (info) clients.push(info);
    }
    return {
      listening: this.server !== null,
      boundAddress: this.boundAddress,
      port: this.boundPort,
      lastError: this.lastError,
      clients,
    };
  }

  /** 主动踢掉一个客户端(设置页的"断开"按钮)。 */
  disconnectClient(virtualWindowId: string): boolean {
    for (const conn of this.connections) {
      if (conn.getInfo()?.virtualWindowId === virtualWindowId) {
        conn.destroy('kicked-by-host');
        return true;
      }
    }
    return false;
  }

  private handleConnection(socket: Socket): void {
    if (this.connections.size >= LINK_MAX_CLIENTS) {
      logger.warn(
        'LinkServer',
        `拒绝来自 ${socket.remoteAddress} 的连接:已达客户端上限 ${LINK_MAX_CLIENTS}`,
      );
      socket.destroy();
      return;
    }
    logger.info('LinkServer', `新连接来自 ${socket.remoteAddress}`);
    const conn = new LinkConnection(socket, this.deps, {
      onClosed: (c) => this.connections.delete(c),
      releaseWindow: (windowId) => this.releaseWindow(windowId),
      rememberOwned: (windowId, sessionIds) => this.rememberOwned(windowId, sessionIds),
      takeResumable: (windowId) => this.takeResumable(windowId),
    });
    this.connections.add(conn);
  }

  private releaseWindow(windowId: string): void {
    for (const conn of [...this.connections]) {
      if (conn.holdsWindow(windowId)) {
        logger.info('LinkServer', `虚拟窗口 ${windowId} 的新连接取代旧连接`);
        conn.destroy('superseded');
      }
    }
  }

  private rememberOwned(windowId: string, sessionIds: string[]): void {
    const now = Date.now();
    for (const [id, entry] of this.resumable) {
      if (entry.expiresAt <= now) this.resumable.delete(id);
    }
    if (sessionIds.length === 0) {
      this.resumable.delete(windowId);
      return;
    }
    this.resumable.set(windowId, { sessionIds, expiresAt: now + LINK_RESUME_TTL_MS });
  }

  private takeResumable(windowId: string): string[] {
    const entry = this.resumable.get(windowId);
    this.resumable.delete(windowId);
    if (!entry || entry.expiresAt <= Date.now()) return [];
    return entry.sessionIds;
  }
}

/**
 * 把 node 的 listen 错误翻译成用户能据以行动的中文说明。
 *
 * 这几个 errno 是远程功能配置失败的绝大多数来源,泛泛地显示
 * "listen EADDRNOTAVAIL 100.64.1.2:38787" 对普通用户毫无帮助。
 */
function describeListenError(err: NodeJS.ErrnoException, options: LinkServerStartOptions): string {
  switch (err.code) {
    case 'EADDRINUSE':
      return (
        `端口 ${options.port} 已被占用。可能是另一个 Ceteris 实例正在监听,` +
        `或别的程序占了这个端口。换一个端口,或先关掉占用方。`
      );
    case 'EADDRNOTAVAIL':
      return (
        `本机没有 ${options.bindAddress} 这个地址。最常见的原因是填了 Tailscale 的 ` +
        `100.x.y.z 但 Tailscale 尚未连上。等 Tailscale 就绪后重新打开开关,` +
        `或先把绑定地址改成"自动"。`
      );
    case 'EACCES':
      return (
        `系统拒绝绑定端口 ${options.port}。在 Windows 上最常见的原因是这个端口落在` +
        `系统保留范围内(Hyper-V、WSL、Docker 常见),管理员权限也绑不上。` +
        `用 netsh int ipv4 show excludedportrange protocol=tcp 查看保留范围,` +
        `换一个范围外的端口(默认 ${LINK_DEFAULT_PORT})。`
      );
    default:
      return `监听 ${options.bindAddress}:${options.port} 失败:${err.message}`;
  }
}
