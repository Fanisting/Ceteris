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
 * - **压缩**(ADR-056)。auth 里声明 deflate;Host 在 auth-ok 里也声明了,就压缩发出的
 *   大消息。收到的帧两种格式都认,见 link-message-codec.ts。
 * - **连接测试**(ADR-055)。runNetworkTest 发 20 个 ping 量往返,再用 probe 消息量
 *   上下行速度;每个标签的输出量一直记在 outputStats 里,测试时一并报出。
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
import { randomBytes } from 'node:crypto';
import { connect, type Socket } from 'node:net';
import { hostname } from 'node:os';
import { app } from 'electron';
import {
  LINK_FEATURE_DEFLATE,
  LINK_FEATURE_PROBE,
  LINK_FEATURES,
  LINK_HANDSHAKE_TIMEOUT_MS,
  LINK_HEARTBEAT_INTERVAL_MS,
  LINK_PROBE_CHUNK_BYTES,
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
  type LinkProbe,
  type LinkProbeData,
  type LinkProbeEnd,
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
import {
  summarizeRtt,
  type LinkRttSummary,
  type LinkSpeedSkipReason,
  type LinkTabTraffic,
} from '@shared/link-test';
import { encodeFrame, FrameDecodeError, FrameDecoder } from './frame-codec';
import {
  createCipherPair,
  deriveSessionKeys,
  generateEphemeralKeyPair,
  generateHandshakeNonce,
  type LinkCipherStream,
} from './link-crypto';
import { computeReconnectDelay, evaluateLiveness, LinkLiveness } from './link-liveness';
import { decodeLinkMessage, encodeLinkMessage, peerHasFeature } from './link-message-codec';
import { LinkOutputStats } from './link-output-stats';
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

/** ADR-055:连接测试发几个 ping、间隔多久、最后一个发出后最多再等多久 */
const TEST_PING_COUNT = 20;
const TEST_PING_INTERVAL_MS = 100;
const TEST_PING_GRACE_MS = 2_000;
/**
 * ADR-055:每个方向测速用的随机字节数。base64 之后约 1 MB:中继上 0.3 MB/s 也只要
 * 三四秒,直连时又足够长,不会被一次往返的时间主导。
 */
const TEST_PROBE_BYTES = 768 * 1024;
/** ADR-055:单个方向测速的等待上限 */
const TEST_PROBE_TIMEOUT_MS = 15_000;

/** runNetworkTest 的结果:只含网络部分,路径和标签由 LinkManager 补。 */
export interface LinkNetworkTest {
  rtt: LinkRttSummary | null;
  downMBps: number | null;
  upMBps: number | null;
  speedSkipped: LinkSpeedSkipReason | null;
  compressed: boolean;
}

/**
 * ADR-050:窗口向 Host "报到"的命令。Host 把这类登记挂在窗口 id 上,断线注销虚拟
 * 窗口时一并清掉;以前靠 reload 让 renderer 重新报到,原地恢复不 reload,所以由这里
 * 在 resume 之后替窗口再发一次。只收无 payload、重复发送无害的命令。
 *
 * - AGENT_NOTICES_READY:agent 更新通知的监听已挂好(ipc.ts 的 noticeReadyWindows)。
 *   不重发的话,恢复后的窗口收不到更新通知,自动升级也会以为没有窗口开着。
 */
const RESUME_REANNOUNCE_CHANNELS: ReadonlySet<string> = new Set([
  COMMAND_CHANNELS.AGENT_NOTICES_READY,
]);

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
  /** livenessTimer 到点的绝对时刻 */
  private livenessTimerAt = 0;
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
  /** 窗口已经成功报到过的命令(RESUME_REANNOUNCE_CHANNELS 的子集),resume 后重发 */
  private readonly announced = new Set<string>();

  /** ADR-056:Host 在 auth-ok 里声明了 deflate,发出的大消息压缩 */
  private compressOut = false;
  /** ADR-055:Host 在 auth-ok 里声明的能力 */
  private hostFeatures: unknown = undefined;
  /** ADR-055:每个标签最近 5 分钟的输出量 */
  private readonly outputStats = new LinkOutputStats();
  /** ADR-055:测试进行中时接收 pong 的回调(参数是 ping 里的 t 和收到的时刻) */
  private pongListener: ((t: number, at: number) => void) | null = null;
  /** ADR-055:测速编号 → 等 probe-end / probe-ack 的回调 */
  private readonly probeWaiters = new Map<
    number,
    { resolve: (bytes: number) => void; reject: (err: Error) => void }
  >();
  private nextProbeId = 1;
  /** ADR-055:同一时刻只跑一个测试,第二次点直接拿同一个结果 */
  private runningTest: Promise<LinkNetworkTest> | null = null;

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
      features: [...LINK_FEATURES],
    });
  }

  private handleEncryptedFrame(frame: Buffer): void {
    if (!this.recv) return;
    const plaintext = this.recv.decrypt(frame);
    const msg = decodeLinkMessage(plaintext) as LinkMessage;

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
        this.pongListener?.(msg.t, Date.now());
        break;
      case 'probe-data':
        // 下行测速的数据,收到即可,按 probe-end 的时刻算速度
        break;
      case 'probe-end':
      case 'probe-ack': {
        const waiter = this.probeWaiters.get(msg.id);
        this.probeWaiters.delete(msg.id);
        waiter?.resolve(msg.bytes);
        break;
      }
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
    this.hostFeatures = msg.features;
    this.compressOut = peerHasFeature(msg.features, LINK_FEATURE_DEFLATE);
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
          `${msg.virtualWindowId}(Window ${msg.virtualWindowNumber}),` +
          `压缩=${this.compressOut ? '开' : '关(Host 不支持)'}`,
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
    for (const channel of this.announced) {
      this.forwardCommand(channel, undefined).catch((err: unknown) => {
        logger.warn(
          'LinkClient',
          `resume 后重新报到 ${channel} 失败,窗口可能收不到这类通知:` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }
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
      if (RESUME_REANNOUNCE_CHANNELS.has(entry.channel)) this.announced.add(entry.channel);
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
    this.noteTraffic(msg);
    if (!this.windowId) return;
    const win = this.deps.windowManager.getById(this.windowId);
    if (!win || win.isDestroyed()) return;
    win.webContents.send(msg.channel, applyLocalThemeToLinkEvent(msg.channel, msg.envelope));
    this.deps.onRemoteEvent?.(this.windowId, msg.channel, msg.envelope);
  }

  /**
   * ADR-055:给连接测试的"重标签"记账。只读 payload,不改。
   */
  private noteTraffic(msg: LinkEventPush): void {
    const payload = (msg.envelope as EventEnvelope<unknown> | null)?.payload as
      | { sessionId?: unknown; data?: unknown }
      | null
      | undefined;
    if (!payload || typeof payload.sessionId !== 'string') return;
    const now = Date.now();
    switch (msg.channel) {
      case EVENT_CHANNELS.SESSION_OUTPUT:
        if (typeof payload.data === 'string') {
          this.outputStats.noteOutput(payload.sessionId, payload.data, now);
        }
        break;
      case EVENT_CHANNELS.SESSION_OUTPUT_RESYNC:
        this.outputStats.noteResync(payload.sessionId, now);
        break;
      case EVENT_CHANNELS.SESSION_DESTROYED:
        this.outputStats.forget(payload.sessionId);
        break;
      case EVENT_CHANNELS.SESSION_OWNER_CHANGED:
        if ((payload as Partial<SessionOwnerChangedPayload>).newOwnerWindowId !== this.windowId) {
          this.outputStats.forget(payload.sessionId);
        }
        break;
      default:
        break;
    }
  }

  /**
   * ADR-055:测往返和上下行速度。只能在已连接时调用。
   *
   * 顺序是先 ping 再测速:测速时线路被大块数据占着,这时量的往返会偏大。
   * 测速期间终端输出会慢几秒,这是测试本身的代价,设置页的按钮旁写明了。
   *
   * @throws Error 未连接
   * @副作用 向 Host 发约 2 MB 的测速数据;同时发起的第二次调用拿到同一个结果
   */
  runNetworkTest(): Promise<LinkNetworkTest> {
    if (this.state !== 'connected') {
      return Promise.reject(
        new Error(
          `[LinkClient] 连接测试需要先连上 ${this.config.label}(${this.targetAddress}),` +
            `当前状态:${this.state}。建议:等它连上后再点测试。`,
        ),
      );
    }
    if (!this.runningTest) {
      this.runningTest = this.doNetworkTest().finally(() => {
        this.runningTest = null;
      });
    }
    return this.runningTest;
  }

  private async doNetworkTest(): Promise<LinkNetworkTest> {
    const { samples, sent } = await this.measureRtt();
    this.assertStillConnected();
    const rtt = summarizeRtt(samples, sent);
    const compressed = this.compressOut;
    if (!peerHasFeature(this.hostFeatures, LINK_FEATURE_PROBE)) {
      return { rtt, downMBps: null, upMBps: null, speedSkipped: 'host-too-old', compressed };
    }
    const floorMs = rtt?.minMs ?? 0;
    try {
      const downMBps = await this.measureDown(floorMs);
      this.assertStillConnected();
      const upMBps = await this.measureUp(floorMs);
      logger.info(
        'LinkClient',
        `连接测试 ${this.targetAddress}:往返中位 ${rtt?.medianMs ?? '-'} ms,` +
          `下行 ${downMBps.toFixed(2)} MB/s,上行 ${upMBps.toFixed(2)} MB/s`,
      );
      return { rtt, downMBps, upMBps, speedSkipped: null, compressed };
    } catch (err) {
      // 连接在测速途中断了:结果没有意义,向上抛,设置页显示错误
      this.assertStillConnected();
      const timedOut = err instanceof Error && err.message.includes('超时');
      logger.warn(
        'LinkClient',
        `连接测试测速失败(${this.targetAddress}):${err instanceof Error ? err.message : String(err)}`,
      );
      return {
        rtt,
        downMBps: null,
        upMBps: null,
        speedSkipped: timedOut ? 'timeout' : 'failed',
        compressed,
      };
    }
  }

  /**
   * 测试途中连接断开时抛错。断开后 writeEncrypted 什么也不做,继续测只会等到超时,
   * 再把断线误报成丢包或测速超时。
   *
   * @throws Error 当前不是 connected
   */
  private assertStillConnected(): void {
    if (this.state === 'connected') return;
    throw new Error(
      `[LinkClient] 连接测试途中与 ${this.config.label}(${this.targetAddress})的连接断开了` +
        `(状态:${this.state})。可能原因:(1) 网络中断;(2) Host 休眠或退出。建议:等它重连后再测。`,
    );
  }

  /**
   * 发 TEST_PING_COUNT 个 ping。
   *
   * @returns 收到回音的往返时间(ms,按发出顺序)和实际发出的个数(中途断开时少于 20)
   */
  private measureRtt(): Promise<{ samples: number[]; sent: number }> {
    return new Promise((resolve) => {
      const sentAt = new Map<number, number>();
      const rtts = new Map<number, number>();
      let sent = 0;
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        clearInterval(timer);
        clearTimeout(grace);
        this.pongListener = null;
        resolve({
          samples: [...sentAt.keys()].filter((t) => rtts.has(t)).map((t) => rtts.get(t) as number),
          sent,
        });
      };
      this.pongListener = (t, at) => {
        if (!sentAt.has(t)) return; // 平时的心跳 ping
        rtts.set(t, at - t);
        if (rtts.size === TEST_PING_COUNT) finish();
      };
      let grace: NodeJS.Timeout | undefined;
      const timer = setInterval(() => {
        if (this.state !== 'connected') return finish();
        // t 用作 ping 的编号:间隔 100 ms,不会两次取到同一毫秒
        const t = Date.now();
        sentAt.set(t, t);
        this.writeEncrypted<LinkPing>({ type: 'ping', t });
        sent++;
        if (sent === TEST_PING_COUNT) {
          clearInterval(timer);
          grace = setTimeout(finish, TEST_PING_GRACE_MS);
        }
      }, TEST_PING_INTERVAL_MS);
    });
  }

  /** 等 Host 对测速编号 id 的 probe-end / probe-ack,超时 reject。 */
  private waitProbe(id: number): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.probeWaiters.delete(id);
        reject(new Error(`测速 ${id} 等待 Host 超时(${TEST_PROBE_TIMEOUT_MS} ms)`));
      }, TEST_PROBE_TIMEOUT_MS);
      this.probeWaiters.set(id, {
        resolve: (bytes) => {
          clearTimeout(timer);
          resolve(bytes);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
    });
  }

  /**
   * 下行:请 Host 发 TEST_PROBE_BYTES,从发出请求到收到 probe-end 计时。
   *
   * @param floorMs 最小往返,从用时里扣掉(请求过去、probe-end 回来本身就要这么久)
   * @returns MB/s(10^6 字节每秒)
   */
  private async measureDown(floorMs: number): Promise<number> {
    this.assertStillConnected();
    const id = this.nextProbeId++;
    const start = Date.now();
    const done = this.waitProbe(id);
    this.writeEncrypted<LinkProbe>({ type: 'probe', id, bytes: TEST_PROBE_BYTES });
    const bytes = await done;
    return toMBps(bytes, Date.now() - start, floorMs);
  }

  /** 上行:发 TEST_PROBE_BYTES 的随机数据,从开始发到收到 probe-ack 计时。 */
  private async measureUp(floorMs: number): Promise<number> {
    this.assertStillConnected();
    const id = this.nextProbeId++;
    const start = Date.now();
    const done = this.waitProbe(id);
    let sent = 0;
    for (let remaining = TEST_PROBE_BYTES; remaining > 0; remaining -= LINK_PROBE_CHUNK_BYTES) {
      const data = randomBytes(Math.min(remaining, LINK_PROBE_CHUNK_BYTES)).toString('base64');
      this.writeEncrypted<LinkProbeData>({ type: 'probe-data', id, data }, false);
      sent += data.length;
    }
    this.writeEncrypted<LinkProbeEnd>({ type: 'probe-end', id, bytes: sent });
    const received = await done;
    return toMBps(received, Date.now() - start, floorMs);
  }

  /**
   * ADR-055:最近 5 分钟输出最多的几个标签,带 Host 上的标签名。
   *
   * 标签名从 Host 的快照里取(转发 cmd:app:get-snapshot,没有副作用)。取不到时用
   * sessionId 的前 8 位,不让整个测试因此失败。
   */
  async getTabTraffic(): Promise<LinkTabTraffic[]> {
    const traffic = this.outputStats.summarize(Date.now());
    if (traffic.length === 0) return [];
    const names = new Map<string, string>();
    try {
      const snapshot = (await this.forwardCommand(
        COMMAND_CHANNELS.APP_GET_SNAPSHOT,
        undefined,
      )) as AppSnapshot;
      for (const s of snapshot.sessions ?? []) names.set(s.id, s.displayName);
    } catch (err) {
      logger.warn(
        'LinkClient',
        `连接测试取标签名失败,改用 session id:${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return traffic.map((t) => ({ ...t, name: names.get(t.sessionId) || t.sessionId.slice(0, 8) }));
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
    const now = Date.now();
    this.armLivenessTimer(now, this.liveness.nextCheckAt(now));
  }

  /**
   * 排活性定时器。已有一个更早到点的定时器时保留它:它到点后会重新判断全部条件,
   * 换成更晚的反而可能跳过一个阈值。
   *
   * @param now 与 at 同一次时钟读数,见 evaluateLiveness
   */
  private armLivenessTimer(now: number, at: number): void {
    if (this.livenessTimer) {
      if (this.livenessTimerAt <= at) return;
      clearTimeout(this.livenessTimer);
    }
    this.livenessTimerAt = at;
    this.livenessTimer = setTimeout(
      () => {
        this.livenessTimer = null;
        this.checkLiveness();
      },
      Math.max(0, at - now),
    );
  }

  private checkLiveness(): void {
    if (!this.liveness || this.isClosed()) return;
    // 判定和下一次检查用同一个 now,否则跨毫秒时会漏掉一个阈值
    const step = evaluateLiveness(this.liveness, Date.now);
    if (step.verdict.dead) {
      this.fail('心跳超时,连接已失效(Host 可能休眠或网络中断)。正在重连…');
      return;
    }
    this.setLaggy(step.verdict.laggy);
    this.armLivenessTimer(step.now, step.nextCheckAt);
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

  /**
   * @param compress false 时不压缩(测速数据);默认按 Host 是否声明 deflate
   */
  private writeEncrypted<T>(msg: T, compress = true): void {
    if (!this.socket || this.socket.destroyed || !this.send) return;
    try {
      const plaintext = encodeLinkMessage(msg, { deflate: compress && this.compressOut });
      this.writeFrame(encodeFrame(this.send.encrypt(plaintext)));
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
    this.compressOut = false;
    this.pongListener = null;
    for (const [, waiter] of this.probeWaiters) {
      waiter.reject(new Error('连接已断开,测速中止'));
    }
    this.probeWaiters.clear();

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
 * 字节数换成 MB/s(10^6 字节每秒)。
 *
 * @param elapsedMs 从开始到收到确认的总用时
 * @param floorMs 最小往返。扣掉它,但最多扣到总用时的一半:往返样本偏大时(测往返时
 *   线路忙)直接相减会得到接近 0 甚至负的用时,速度被夸大成天文数字
 */
function toMBps(bytes: number, elapsedMs: number, floorMs: number): number {
  const ms = Math.max(elapsedMs - floorMs, elapsedMs / 2, 1);
  return bytes / ms / 1000;
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
