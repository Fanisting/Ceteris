/**
 * @file src/shared/link-protocol.ts
 * @purpose Marina Link(远程挂载)的线路协议定义。Host 端与 Client 端
 *   都从这里 import,保证两端对帧格式、握手消息、命令路由策略的理解一致。
 *
 * @关键设计:
 * - Marina Link 不发明新的应用层协议。它把已有的 `cmd:*` / `evt:*` 信封
 *   原样搬到 TCP 上。Host 收到 forward 帧后直接丢进本地 ipcMain 的同一批
 *   handler,renderer 完全感知不到自己连的是远端。
 * - 传输层零新增依赖:node 内置 net + crypto。不引入 ws / socket.io
 *   (AGENTS.md 1.2 边界 2:超出技术栈的依赖必须先问开发者)。
 * - 认证与加密合一:预共享 token 参与 HKDF 派生会话密钥,没有 token 的
 *   一方连第一个 AUTH 帧都解不开。token 本身永不上线路。详见 link-crypto.ts。
 * - 本文件是纯类型 + 常量,不含运行时逻辑,renderer 侧也可安全 import。
 *
 * @对应文档章节: docs/marina-link-protocol.md;docs/ipc-protocol.md(被搬运的内层协议)
 *
 * @不要在这里做的事:
 * - 不要 import 'node:net' / 'node:crypto'(本文件会被 renderer bundle 引用)
 * - 不要放 socket 生命周期逻辑(那是 link-server.ts / link-client.ts 的职责)
 * - 不要放密钥派生实现(那是 link-crypto.ts 的职责)
 */

/**
 * Link 线路协议版本。与 docs/ipc-protocol.md 的 PROTOCOL_VERSION 相互独立:
 * 前者管"两台机器之间怎么说话",后者管"main 与 renderer 之间怎么说话"。
 *
 * 握手时双方比对,不一致直接断开并告知用户升级。理由:Link 承载的是加密
 * 帧,版本错配下的行为无法优雅降级(密钥派生的 info 串就带版本号)。
 */
export const LINK_PROTOCOL_VERSION = 1 as const;

/**
 * 默认监听端口,用户可在设置里改。
 *
 * 选 38787 是为了避开 Windows 的动态端口范围:Hyper-V / WinNAT 会在这个范围里
 * 保留成段的端口,被保留的端口连管理员也绑不上,而且重启后位置会变。原默认值
 * 8787 就在一台实机上落进了 8765-8864 的保留段。动态范围的系统默认从 49152 开始,
 * 个别机器被改成从 1024 开始的 13977 个端口(到 15000),38787 两种情况都在外面。
 */
export const LINK_DEFAULT_PORT = 38787;

/**
 * 单帧密文的上限(字节)。超过即判定为恶意 / 损坏并断开,防止一个伪造的
 * 长度前缀让我们 allocate 一块巨大 buffer(经典的 length-prefix DoS)。
 *
 * 8 MiB 的来源:evt:session:output 的 payload 是 16ms 聚合后的 PTY 字节流
 * 经 base64(膨胀 4/3)。即使终端在疯狂刷屏,16ms 内也远达不到 6 MB 原始
 * 字节。留这么大的余量是为了 cmd:session:get-scrollback 的响应 —— 它一次
 * 性返回整个 ring buffer 的状态重建流(上限 2MB 原始 → ~2.7MB base64)。
 */
export const LINK_MAX_FRAME_BYTES = 8 * 1024 * 1024;

/**
 * 握手阶段(尚未建立加密)的明文帧上限。握手消息只有两个公钥加几个短
 * 字符串,4 KiB 绰绰有余。收紧上限是因为这个阶段对端尚未通过认证,
 * 能让未认证的一方分配的内存越少越好。
 */
export const LINK_MAX_HANDSHAKE_BYTES = 4 * 1024;

/**
 * 帧长度前缀的字节数(uint32 BE)。
 */
export const LINK_LENGTH_PREFIX_BYTES = 4;

/**
 * AES-256-GCM 认证标签长度。
 */
export const LINK_AUTH_TAG_BYTES = 16;

/**
 * 握手随机数长度。Client 与 Server 各出一个,拼起来做 HKDF 的 salt。
 */
export const LINK_HANDSHAKE_NONCE_BYTES = 16;

/**
 * 预共享 token 的字节数(生成时)。32 字节 = 256 bit,base64url 后 43 字符。
 * 用户需要手动把它从 Host 抄到 Client,所以不能太长;256 bit 对抗离线
 * 暴力破解已远超必要(token 只在本地 HKDF 里用,攻击者拿不到可离线验证的
 * oracle,唯一路径是在线猜测,而每次猜错都是一次 TCP 断开)。
 */
export const LINK_TOKEN_BYTES = 32;

// ──────────────────────────────────────────────────────────────────
// 握手消息(明文 JSON,长度前缀分帧)
// ──────────────────────────────────────────────────────────────────

/**
 * Client → Host,连接后的第一条消息。
 *
 * 此时双方都还没有会话密钥,内容是明文。这里只暴露一个临时 X25519 公钥
 * 和一个随机数,不含任何身份信息 —— 未认证的对端不该拿到"这台机器是谁"。
 */
export interface LinkHello {
  type: 'hello';
  /** 必须等于 LINK_PROTOCOL_VERSION,否则 Host 直接断开 */
  linkVersion: number;
  /** base64 的 X25519 raw 公钥(32 字节) */
  clientPublicKey: string;
  /** base64 的随机数(LINK_HANDSHAKE_NONCE_BYTES 字节) */
  clientNonce: string;
}

/**
 * Host → Client,对 hello 的应答。
 *
 * 同样是明文。Host 在这一步仍未验证 Client 身份(验证发生在第一个加密帧),
 * 所以这里也不放主机名等可识别信息,只放协议协商必需的材料。
 */
export interface LinkHelloAck {
  type: 'hello-ack';
  linkVersion: number;
  /** base64 的 X25519 raw 公钥(32 字节) */
  serverPublicKey: string;
  /** base64 的随机数(LINK_HANDSHAKE_NONCE_BYTES 字节) */
  serverNonce: string;
}

/**
 * 握手失败时对端发回的明文错误,发完即断。
 *
 * 只在"版本不匹配"这类与凭据无关的失败上使用。凭据错误**不**发这个:
 * token 不对时我们静默断开,不告诉攻击者"你的 token 错了"还是"这里根本
 * 没开 Host 模式"。
 */
export interface LinkHandshakeError {
  type: 'handshake-error';
  code: 'version-mismatch' | 'server-busy';
  message: string;
}

export type LinkHandshakeMessage = LinkHello | LinkHelloAck | LinkHandshakeError;

// ──────────────────────────────────────────────────────────────────
// 加密帧内的消息(握手之后的所有通信)
// ──────────────────────────────────────────────────────────────────

/**
 * Client → Host,第一个加密帧。能被 Host 成功解密本身就是认证通过的证明
 * (token 参与了密钥派生),所以这条消息里没有 token 字段。
 */
export interface LinkAuth {
  type: 'auth';
  /** 展示用的客户端名,Host 在设置页的"已连接客户端"里显示 */
  clientName: string;
  /** Client 端 Marina 的 app 版本,用于诊断 */
  clientVersion: string;
  /** Client 端 renderer 编译时的 IPC PROTOCOL_VERSION,不匹配时 Host 拒绝 */
  ipcProtocolVersion: number;
  /**
   * 重连时希望复用的虚拟 windowId(首次连接时省略)。
   *
   * 为什么需要:renderer 从 URL query 拿到自己的 windowId,并用它与
   * session.ownerWindowId 比对来判断"这个终端是不是我持有的"。如果每次重连
   * Host 都分配一个新 id,重连后 renderer 会认为自己一个 session 都不持有,
   * 于是去 claim 那些**其实还是它自己的** session,拿到一堆
   * SessionAlreadyOwned 报错。复用 id 让重连对 renderer 完全透明,只要
   * reload 一次就回到原状。
   *
   * Host 拒绝 Host 本地真实窗口的 id,防止客户端冒充本地窗口抢走它的 session。
   * 如果该 id 被另一条 Link 连接占着,说明那是本客户端尚未超时的旧连接(Wi-Fi
   * 切换、休眠唤醒后常见),Host 会断开旧连接并把 id 交给新连接。
   */
  preferredWindowId?: string;
}

/**
 * Host → Client,认证成功。
 */
export interface LinkAuthOk {
  type: 'auth-ok';
  /**
   * Host 为这个 Client 分配的虚拟 windowId。
   *
   * 关键:Host 把远程客户端注册成 WindowManager 里的一个"虚拟窗口",于是
   * session ownership、事件广播、owner-only 的字节流路由全都不需要为远程
   * 情况写特例代码 —— 远程客户端在 Host 眼里就是又一个窗口。
   */
  virtualWindowId: string;
  /** Host 分配的窗口编号(Window N),renderer 标题栏显示用 */
  virtualWindowNumber: number;
  /** Host 的机器名,Client 端标题栏 / 状态条显示 */
  hostName: string;
  /** Host 端 Marina 的 app 版本 */
  hostVersion: string;
}

/**
 * Host → Client,认证后被拒。发完即断。
 */
export interface LinkAuthRejected {
  type: 'auth-rejected';
  code: 'ipc-version-mismatch' | 'max-clients-reached';
  message: string;
}

/**
 * Client → Host,转发一条 renderer 发起的命令。
 *
 * envelope 是原封不动的 CommandEnvelope(见 docs/ipc-protocol.md 2.3),
 * 但 windowId 字段会被 Host 端重写为该连接的 virtualWindowId —— Client
 * 本地的 windowId 在 Host 的 WindowManager 里没有意义。
 */
export interface LinkCommandForward {
  type: 'cmd';
  /** 本连接内单调递增,用于把响应配回请求 */
  id: number;
  /** IPC channel 名,如 'cmd:session:create' */
  channel: string;
  /** CommandEnvelope 的 payload 部分 */
  payload: unknown;
}

/**
 * Host → Client,命令的返回值或错误。
 */
export interface LinkCommandResult {
  type: 'cmd-result';
  /** 对应 LinkCommandForward.id */
  id: number;
  /** ok=false 时 result 为 undefined,error 有值 */
  ok: boolean;
  result?: unknown;
  error?: {
    /** 尽量沿用 docs/ipc-protocol.md 第 7 章的错误码 */
    code: string;
    message: string;
  };
}

/**
 * Host → Client,推送一条事件。
 *
 * 对应 Host 端 ipc.ts 里 broadcastEvent / sendEventTo 的输出。Client 收到后
 * 原样 webContents.send 进绑定的那个 BrowserWindow,renderer 的事件监听器
 * 完全不需要改。
 */
export interface LinkEventPush {
  type: 'evt';
  /** IPC channel 名,如 'evt:session:output' */
  channel: string;
  /** EventEnvelope 整体(含 eventId / timestamp / payload) */
  envelope: unknown;
}

/**
 * 双向心跳。
 *
 * 为什么需要:TCP 的半开连接(对端主机崩溃 / 网线拔了 / NAT 表项过期)
 * 在没有数据流动时可以静默存在几十分钟。终端会话常常长时间无输出,正是
 * 最容易踩到这个坑的场景。应用层心跳让两端在 LINK_HEARTBEAT_TIMEOUT_MS
 * 内就能发现问题并触发重连。
 */
export interface LinkPing {
  type: 'ping';
  /** 发送方的时间戳(Unix ms),对端原样回显,用于测 RTT */
  t: number;
}

export interface LinkPong {
  type: 'pong';
  t: number;
}

/**
 * 任一端主动通告即将断开(优雅关闭)。收到后不要触发重连退避,直接按
 * "用户主动断开"处理。
 */
export interface LinkBye {
  type: 'bye';
  reason: string;
}

export type LinkMessage =
  | LinkAuth
  | LinkAuthOk
  | LinkAuthRejected
  | LinkCommandForward
  | LinkCommandResult
  | LinkEventPush
  | LinkPing
  | LinkPong
  | LinkBye;

/** 心跳间隔:每 15 秒发一次 ping。 */
export const LINK_HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * 超过这个时长没收到对端任何字节(包括 pong)就判定连接已死。
 *
 * 取 3 倍心跳间隔 + 余量:允许丢两个心跳周期,避免网络抖动导致误断。
 */
export const LINK_HEARTBEAT_TIMEOUT_MS = 50_000;

/**
 * 握手必须在这个时长内完成,否则断开。防止有人开一堆连接占着不说话
 * (slowloris 式的资源耗尽)。
 */
export const LINK_HANDSHAKE_TIMEOUT_MS = 10_000;

/**
 * 单个 Host 允许同时连入的远程客户端数上限。
 *
 * 与 WindowManager 的 MAX_WINDOWS(20)呼应:每个客户端占一个虚拟窗口,
 * 留 8 个给远程、其余给本地真实窗口,避免远程连接把本地开窗能力挤爆。
 */
export const LINK_MAX_CLIENTS = 8;

/**
 * Host 记住"断线客户端持有哪些 session"的时长。
 *
 * 取 24 小时是为了覆盖笔记本合盖过夜。过期或记录错误都不会造成抢占:恢复时
 * 只接管当时仍然无主的 session。
 */
export const LINK_RESUME_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * 单条连接允许积压在 socket 写缓冲里的字节数,超过就断开。
 *
 * 客户端休眠后要等最多 50 秒才判定心跳超时,这期间 agent 的输出全部堆在 Host
 * 内存里。断开是安全的:客户端重连后从 Host 的 headless 终端回放完整状态,
 * 不依赖这些字节。
 */
export const LINK_MAX_WRITE_BACKLOG_BYTES = 64 * 1024 * 1024;

/**
 * Host 复查绑定地址的间隔。
 *
 * Marina 随系统启动时 Tailscale 往往还没连上,"自动"只能先绑 127.0.0.1。
 * 复查让它在 Tailscale 就绪后自己换到 100.x.y.z,无人值守的机器才能重启后恢复。
 */
export const LINK_BIND_RECHECK_MS = 30_000;

// ──────────────────────────────────────────────────────────────────
// 命令路由策略
// ──────────────────────────────────────────────────────────────────

/**
 * 在远程窗口里**不转发**、必须由 Client 本机执行的命令。
 *
 * 判断标准是一句话:**这条命令操作的是"我面前这块玻璃"还是"那台机器上的
 * 数据"?** 操作本地窗口装饰、本地剪贴板、本地浏览器的,留在本地;操作
 * session / path / 设置等 Host 侧状态的,一律转发。
 *
 * 每一条的理由:
 * - APP_GET_PROTOCOL_VERSION · 本地 handshake 用。Host 的版本在 auth-ok 里
 *   单独带回并比对,不走这条。
 * - APP_QUIT · 退出的是**本机** Marina。转发出去会把 Host 上跑着的所有
 *   agent 全杀掉,是灾难性的误操作。
 * - WINDOW_* · 最小化 / 最大化 / 关闭 / 新建窗口全是本机 BrowserWindow 的
 *   操作。特别注意 WINDOW_CLOSE_SELF:关的是本地这个远程窗口,Host 侧对应
 *   的虚拟窗口由 socket 断开时清理。
 * - SYSTEM_CLIPBOARD_* · 用户按 Ctrl+Shift+C 想要的是**自己面前**这台机器的
 *   剪贴板。转发到 Host 会写进一块用户根本访问不到的剪贴板。
 * - SYSTEM_OPEN_EXTERNAL · 终端里的 URL 应该在用户面前的浏览器打开。
 * - SYSTEM_GET_BUILD_TYPE / SYSTEM_OPEN_LOGS_DIR · 诊断本机安装形态与本机
 *   日志,转发无意义。
 * - LOGGER_IME_DUMP · IME 探针诊断的是本机 renderer 的输入法行为。
 *
 * 反过来,**故意转发**的几条容易犹豫的命令:
 * - SYSTEM_SHOW_IN_EXPLORER / SYSTEM_OPEN_DATA_DIR · 路径是 Host 的路径,
 *   在本机打开必然找不到。转发后在 Host 的 Explorer 里弹出来 —— 用户当下
 *   看不见,但这是唯一语义正确的行为。
 * - BOOKMARK_PICK_FOLDER · 要选的是 Host 上的目录。Host 会在自己屏幕上弹
 *   原生文件夹选择器。这在 Host 无人值守时体验不好,已在 docs 里记为已知
 *   限制(远程建议直接手输路径)。
 * - SETTINGS_* · Host 是设置的唯一可信源,这样远程窗口的主题 / 字体 / 模板
 *   与 Host 完全一致,符合"在另一台机器上得到一模一样的访问"这个目标。
 *
 * 注意:这里存的是 channel 字符串字面量。ipc-protocol.md 附录 A 要求业务
 * 代码通过 COMMAND_CHANNELS 常量引用,本文件是**协议定义**而非业务代码,
 * 且 shared 层不宜反向依赖;link-routing.test.ts 会断言这个集合里的每一项
 * 都真实存在于 COMMAND_CHANNELS,防止改名后这里静默失配。
 */
export const LINK_LOCAL_ONLY_CHANNELS: ReadonlySet<string> = new Set([
  'cmd:app:get-protocol-version',
  'cmd:app:quit',
  'cmd:window:create',
  'cmd:window:close-self',
  'cmd:window:close-all',
  'cmd:window:focus',
  'cmd:window:minimize',
  'cmd:window:toggle-maximize',
  'cmd:window:get-max-state',
  'cmd:system:clipboard-read-text',
  'cmd:system:clipboard-write-text',
  'cmd:system:open-external',
  'cmd:system:get-build-type',
  'cmd:system:open-logs-dir',
  'cmd:logger:ime-dump',
  // Link 自身的管理命令全部本地执行。在远程窗口里点"断开",断的必须是
  // 本机这条连接;转发给 Host 会变成"让 Host 断开它自己的某条连接",
  // 语义完全错误。
  'cmd:link:get-status',
  'cmd:link:regenerate-token',
  'cmd:link:connect',
  'cmd:link:disconnect',
  'cmd:link:kick-client',
  'cmd:link:list-bind-candidates',
  'cmd:link:get-window-state',
  'cmd:link:ack-unconfirmed',
]);

/**
 * 判断某条命令在远程窗口里是否应转发给 Host。
 *
 * @param channel IPC channel 名
 * @returns true = 转发到 Host;false = 由 Client 本地 handler 执行
 */
export function shouldForwardToHost(channel: string): boolean {
  return !LINK_LOCAL_ONLY_CHANNELS.has(channel);
}

// ──────────────────────────────────────────────────────────────────
// 连接状态(供 renderer 显示状态条)
// ──────────────────────────────────────────────────────────────────

/**
 * Client 侧的连接状态机。
 *
 *   idle ──connect()──> connecting ──握手成功──> connected
 *                            │                        │
 *                            │ 失败                    │ socket 断
 *                            ▼                        ▼
 *                       reconnecting <───────────── reconnecting
 *                            │
 *                            │ 用户主动断开 / 不可重试的错误
 *                            ▼
 *                          closed
 *
 * 'reconnecting' 与 'connecting' 分开是为了 UI:首次连接失败要立刻把错误
 * 摊给用户看,而重连中只需要一个不打扰人的黄色状态点。
 */
export type LinkConnectionState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'closed';

/**
 * Client 侧连接状态,推给 renderer 渲染状态条。
 */
export interface LinkClientStatus {
  state: LinkConnectionState;
  /** 已连接时的 Host 机器名,未连接为空串 */
  hostName: string;
  /** 目标地址,形如 "100.101.102.103:38787" */
  address: string;
  /** 最近一次心跳往返(ms);未测得为 null */
  rttMs: number | null;
  /** 最近一次失败的可读原因;正常时为空串 */
  lastError: string;
  /** 处于 reconnecting 时,距下次重试的毫秒数 */
  nextRetryInMs: number | null;
}

/**
 * Host 侧的一个已连接客户端,供设置页展示与"踢掉"操作。
 */
export interface LinkHostClientInfo {
  /** 该客户端在 Host 的 WindowManager 里的虚拟 windowId */
  virtualWindowId: string;
  virtualWindowNumber: number;
  clientName: string;
  clientVersion: string;
  /** 对端 IP(不含端口) */
  remoteAddress: string;
  /** 连接建立时刻 Unix ms */
  connectedAt: number;
}

/**
 * Host 侧监听状态,供设置页展示。
 */
export interface LinkHostStatus {
  /** 是否正在监听 */
  listening: boolean;
  /** 实际绑定的地址(用户填 'auto' 时这里是解析后的结果) */
  boundAddress: string;
  port: number;
  /** 监听失败时的可读原因(端口占用 / 地址不存在),正常为空串 */
  lastError: string;
  clients: LinkHostClientInfo[];
}
