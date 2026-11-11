/**
 * @file types.ts
 * @purpose 跨进程共享的领域类型 (Bookmark / Session / PathNode / Settings 等)。
 *   这些类型对应 软件定义书.md 第 11 章 (数据模型) 的 schema。
 *
 * @关键设计:
 * - 类型按"持久化数据"和"内存数据"分组,与磁盘 JSON 文件一一对应
 * - 持久化结构带 version 字段用于版本迁移 (软件定义书 11.3)
 * - SessionState/PathCategory 是受限字符串字面量,与状态机定义对齐
 * - 不在这里定义任何带方法的 class,纯数据 (要 JSON 可序列化)
 *
 * @对应文档章节: 软件定义书.md 第 8 章 (状态机)、第 11 章 (数据模型)
 */
import type { FolderAgentDefault } from './agent-model';
import type { SessionRole } from './session-role';
import type { ShelfEntry } from './shelf';
import type { QuickLaunchItem } from './quick-launch';
import type { TagColors } from './path-tags';
import type { ColonCommand } from './colon-commands';

import type { BeamerThemeId } from './beamer-themes';
import type { CustomThemeId } from './custom-themes';
import type { LegadoThemeId } from './legado-themes';
import type { PiliThemeId } from './pili-themes';
import type {
  LegadoContrast,
  LegadoDynamicThemeId,
  LegadoPaletteStyle,
} from './legado-dynamic-ids';

// ──────────────────────────────────────────────────────────────────
// 枚举 / 字面量
// ──────────────────────────────────────────────────────────────────

/**
 * Path 在侧栏中的归属分类 (软件定义书 4 节)。
 *
 * 注:BETA-011 一度引入的 'system' 分类已在 2026-05-16 移除 — 桌面/主目录
 * 改为干净安装时种入收藏(见 PathManager.initialize + PlatformAdapter
 * .getDefaultBookmarkSeeds),不再是独立分组。
 */
export type PathCategory = 'bookmarked' | 'temporary';

/**
 * Path 的来源。local 是本机文件夹;ssh 是某个 SSH profile 下的远程目录。
 *
 * Phase 1(SSH 方案 v2.1 §II.1):本字段在所有 Path-bearing 类型(Bookmark /
 * RecentEntry / PathNode / PathRef)上都是 **required**,通过 discriminated
 * union 把"路径来源"做成类型层 invariant — 任何忘记处理 ssh 分支的代码
 * 立刻编译失败。
 *
 * 旧磁盘数据(beta.9 之前)没有 kind 字段,在持久化层(PathManager.initialize
 * / validateBookmarksArray / validateRecentArray)读取时统一 coerce 为
 * 'local',对类型层保持透明。
 */
export type PathKind = 'local' | 'ssh';

/**
 * Discriminated union helper — 编译期 exhaustiveness check 的兜底。
 * 在 switch on PathKind 的 default / 末尾调用一次,任何未覆盖的 kind 会
 * 让 TS 编译报错。
 *
 * @example
 *   switch (b.kind) {
 *     case 'local': return doLocal(b);
 *     case 'ssh':   return doRemote(b);
 *     default:      return assertNeverPathKind(b);
 *   }
 */
export function assertNeverPathKind(_value: never): never {
  throw new Error(`unhandled PathKind: ${JSON.stringify(_value)}`);
}

/**
 * Session 的运行时状态 (软件定义书 8.3 节状态机)。
 *
 * v1.2 起 (ADR-008):状态机砍掉了 tombstoned (5 分钟自动过期 + 重启)。
 * PTY 进程退出后直接进入 'exited',无时限等待用户主动关闭。
 *
 * - active:近 N 秒有 PTY 字节输出
 * - idle:活着但 N 秒无输出 (默认 N=2,见 settings.advanced.activeIdleThresholdSeconds)
 * - exited:PTY 进程已结束 (正常或异常),scrollback 仍持有,等待用户右键关闭
 */
export type SessionState = 'active' | 'idle' | 'exited';

/**
 * What an AI agent in a session is doing, read from its screen (ADR-021, agent-phase.ts).
 * Separate from SessionState: an agent at an approval prompt and one that finished are
 * both 'idle', and only this tells them apart.
 *
 * - working:the agent is running a turn
 * - blocked:the agent waits for the user to approve a command or edit
 * - done:the turn ended and the agent waits for the next prompt
 */
export type AgentPhase = 'working' | 'blocked' | 'done';

/**
 * What kind of work a working agent is doing, which picks the wave's shape (ADR-021).
 *
 * - generating:the model is producing tokens (thinking or writing)
 * - tool:a tool is running, such as a shell command
 * - waiting:the turn is on but nothing is generated, such as hooks or the API starting up
 */
export type AgentWork = 'generating' | 'tool' | 'waiting';

/**
 * What answering an option takes (ADR-035):
 * - none: pick it (arrow keys and Enter; in a multi-select list Enter ticks or unticks it)
 * - type: its row turns into a one-line text field when the pointer is on it ("Type
 *   something."); the typed text replaces the label and Enter sends it
 * - chat: picking it leaves the prompt ("Chat about this", "No, and tell Claude what to
 *   do"), and the user's message then goes to the agent's normal input
 */
export type ChoiceInput = 'none' | 'type' | 'chat';

/** One row of a prompt an agent stopped at (ADR-035): an approval box or an AskUserQuestion. */
export interface ChoiceOption {
  /** The number the agent printed before the label, 1-based. */
  index: number;
  /** The label without the agent's marks (the multi-select box, the ✔ of an earlier answer). */
  label: string;
  /**
   * Where the arrow keys stop on this row, 0-based. Not always index - 1: multi-select lists
   * have an unnumbered Submit row before "Chat about this".
   */
  pos: number;
  /**
   * The indented rows under the option: AskUserQuestion's option description, or the rest
   * of a long approval option that wrapped. Empty when there are none.
   */
  description: string;
  /** True on the row the agent's pointer sits on. */
  pointed: boolean;
  input: ChoiceInput;
  /** Multi-select: whether its box is ticked. Null in a single-select list. */
  checked: boolean | null;
  /** A paged prompt the user stepped back into: this was the answer given before. */
  chosen: boolean;
}

/** One page of a paged AskUserQuestion, from its tab strip. */
export interface ChoiceStep {
  label: string;
  /** Answered already (☒ on the strip). */
  done: boolean;
}

/** A prompt read from an agent's screen (ADR-035). */
export interface ChoicePrompt {
  /** The question line above the options, box characters stripped; empty when none reads. */
  question: string;
  options: ChoiceOption[];
  /** The arrow-key position the pointer is on: an option's pos, or multi-select's Submit row. */
  pointer: number;
  /** The options have boxes to tick; Enter toggles instead of answering. */
  multiSelect: boolean;
  /**
   * The pages of a paged AskUserQuestion (several questions, or a multi-select one), without
   * the final Submit page. Empty for a one-page prompt.
   */
  steps: ChoiceStep[];
  /** The final page: the answers so far, then "Submit answers" / "Cancel". */
  reviewing: boolean;
  /** That page's lines ("● Which colour?", "→ Red", "⚠ You have not answered all questions"). */
  review: string[];
}

/**
 * 应用整体生命周期状态 (软件定义书 8.1 节)。
 */
export type AppLifecycleState =
  | 'starting'
  | 'running-with-window'
  | 'running-tray-only'
  | 'exiting';

/**
 * 启动模板的退出后行为。
 */
export type PostExitAction = 'close_session' | 'keep_shell' | 'hold';

/**
 * 主题 ID (软件定义书 5.1.9):内置主题,或用户主题文件 `custom:<slug>`(ADR-026)。
 */
export type ThemeId = BuiltinThemeId | CustomThemeId;

/** 随应用发布的主题。只有它们在 TerminalView 的 XTERM_THEMES 里有固定配色。 */
export type BuiltinThemeId =
  // Material Design 3 主题,默认主题。配色由海青种子色 #006a6a 生成
  | 'ceteris-dark'
  | 'ceteris-light'
  | 'rose-pine'
  | 'rose-pine-dawn'
  | 'rose-pine-moon'
  | 'cutie'
  | 'business'
  | 'ubuntu'
  | 'windows-terminal'
  // BETA-033 起新增的 4 个深色主题
  | 'one-dark-pro'
  | 'dracula'
  | 'tokyo-night'
  | 'catppuccin-mocha'
  // UI-2 起新增的浅色 / 可爱主题
  | 'catppuccin-latte'
  | 'tokyo-night-day'
  | 'light-pink'
  | 'fairyfloss'
  // 珠光系列浅色主题,配色见 src/renderer/styles/pearl-themes.css
  | 'pearl-lapis'
  | 'pearl-sapphire'
  | 'pearl-rose'
  | 'pearl-ember'
  | 'pearl-jade'
  | 'pearl-moon'
  | 'pearl-frost'
  // 梅子,配色见 src/renderer/styles/meizi-theme.css
  | 'meizi'
  // 取自 LaTeX Beamer 模板配色,清单见 beamer-themes.ts
  | BeamerThemeId
  // 取自 legado-with-MD3 的 MD3 配色,清单见 legado-themes.ts
  | LegadoThemeId
  // Legado MD3 实时主题:种子色 / Windows 强调色生成(ADR-030)
  | LegadoDynamicThemeId
  // Pili 系列:照 PiliPlus 的种子色和默认算法生成的 MD3 配色(ADR-031),清单见 pili-themes.ts
  | PiliThemeId;

/**
 * 窗口外观风格 (M1-A 引入,Milestone 1)。
 *
 * - 'windows':传统 Windows 风格 — 控制按钮(最小化/最大化/关闭)在右,
 *   方形按钮 + lucide 图标。`titleBarOverlay` 由主题色驱动。
 * - 'macos':macOS 风格 — 三色 traffic light 按钮在左(红黄绿),圆形,
 *   悬浮渲染于内容之上;右侧让位给标题与窗口编号。整个 chrome 更紧凑。
 *
 * 该字段控制布局 + 控件位置,**不**控制配色(配色仍走 theme)。
 */
export type WindowStyle = 'windows' | 'macos';

/**
 * 终端右键行为 (软件定义书 6.6.2 行为)。
 */
export type TerminalRightClick = 'menu' | 'paste';

/**
 * 启动时行为。
 */
export type StartupBehavior = 'open-window' | 'tray-only';

/**
 * 新终端使用的 shell 策略。
 */
export type NewTerminalShellPolicy = 'default' | 'last-used';

/**
 * SSH 远端 tmux 启动策略。
 *
 * 这是 SSH 启动链路的轻量增强,不是 Ceteris 的 tmux session 管理模型:
 * Ceteris 仍只管理本地 ssh.exe PTY;远端 tmux 仅用于断线后 attach 回同一个
 * 远端会话。
 */
export type SshTmuxMode = 'disabled' | 'attach-or-create';

/**
 * 远端没有 tmux 命令时的行为。
 */
export type SshTmuxOnMissing = 'fallback-shell' | 'fail';

/**
 * SSH tmux session 命名策略。
 *
 * - reuse:按远程目录末级派生基名,远端已有同名 session 时按数量智能选择
 * - new-per-launch:每次从 Ceteris 新建 session 都创建新的 tmux session,适合强制多开
 */
export type SshTmuxSessionPolicy = 'reuse' | 'new-per-launch';

// ──────────────────────────────────────────────────────────────────
// 内存数据 (Window / Session / Path)
// ──────────────────────────────────────────────────────────────────

/**
 * Window 信息 — 由 Main 维护,广播给所有 Renderer 用于显示窗口列表。
 * Renderer 不直接持有 BrowserWindow 引用,只通过 windowId 引用。
 */
export interface WindowInfo {
  /** UUID,持久且不复用 */
  id: string;
  /**
   * 显示给用户的编号,从 1 开始单调递增,关闭后不复用。
   * 应用每次启动时从 1 重新开始 (软件定义书 6.7 节)。
   */
  number: number;
  /** Electron BrowserWindow 的内部 ID,Main 用它定位 webContents */
  electronWindowId: number;
}

/**
 * Session 的可序列化外观 (用于 IPC 与 snapshot)。
 * 实际的 PTY 实例 / scrollback buffer 留在 Main,不传到 renderer。
 */
export interface SessionInfo {
  id: string;
  /**
   * Session 创建时确定的 path id,**生命周期内永不变** (ADR-008)。
   * cd 等 cwd 变化不会让 session 在 UI 上换 path,只触发 currentCwd ⚠️ 提示。
   */
  pathId: string;
  templateId: string;
  /**
   * Session 创建时的 cwd,等于该 session 所属 path 的 path 字段,
   * 生命周期内永不变 (ADR-008)。
   */
  originalCwd: string;
  /**
   * Session 内 OSC 1337 实时报告的工作目录。
   * 启动时初值 = originalCwd;之后随 OSC 1337 序列更新。
   * 仅用于 UI:currentCwd ≠ originalCwd 时 tab 显示 ⚠️ + tooltip。
   */
  currentCwd: string;
  /** 终端尺寸,renderer fit 后通过 cmd:session:resize 同步 */
  cols: number;
  rows: number;
  /** PTY 子进程 PID,用于诊断;-1 表示尚未 spawn 或已退出 */
  pid: number;
  /** 显示名,默认 templateId 对应模板的 name */
  displayName: string;
  /** 当前持有该 session 的 owner window;null 表示无主 */
  ownerWindowId: string | null;
  state: SessionState;
  /**
   * The agent's phase, or null / absent when the screen shows no agent (ADR-021).
   * Absent in sessions from a main process older than this field.
   */
  agentPhase?: AgentPhase | null;
  /** While agentPhase is 'working': the kind of work, or null when the screen does not say. */
  agentWork?: AgentWork | null;
  /** While generating: how fast, 0.25 to 1 in quarter steps, from the token counter. */
  agentPace?: number | null;
  /**
   * A shell command is running: true from the Enter the user sends until the shell hook
   * reports the next prompt (OSC 1337 CurrentDir), false while the shell sits at its prompt
   * (ADR-023). null or absent until the first prompt report, so a shell without the hook
   * keeps the output-driven rule.
   */
  shellBusy?: boolean | null;
  /**
   * The user marked this session as a coordinator: its tab sits in a row of its own above
   * the folder's tabs, whichever folder is open (ADR-023). Lives as long as the session.
   */
  coordinator?: boolean;
  /**
   * The role given from the tab menu (ADR-024, @shared/session-role): 'coordinator' or
   * 'fintuner'. Either one also sets `coordinator`, so both sit in the row above the tabs.
   * null or absent means a Worker, a normal tab.
   */
  role?: SessionRole | null;
  /** 退出码 (state === 'exited' 时有值) */
  exitCode?: number;
  /** PTY 进程退出时间 (Unix ms,state === 'exited' 时有值) */
  exitedAt?: number;
  /** 创建时间 (Unix ms) */
  createdAt: number;
  /**
   * ADR-038, Claude Code and Codex tabs only: the model and effort Ceteris started the agent
   * with or last switched it to. '' or absent = the agent's own default, unknown to Ceteris.
   */
  agentModel?: string;
  agentEffort?: string;
  /** ADR-038: the `--session-id` given to Claude Code at launch, so its transcript is found */
  agentLaunchId?: string;
}

/**
 * 路径节点公共字段(本地 / SSH 共用)。具体类型必须从 PathNode discriminated
 * union 选用对应变体。
 */
interface PathNodeBase {
  /** 稳定 path id(本地 = normalizePath 结果;SSH = ssh:profileId:remotePath) */
  id: string;
  /** 本地文件系统绝对路径,或 SSH 远程目录路径 */
  path: string;
  /** 用户自定义显示名,无则取路径最后一段 */
  displayName?: string;
  category: PathCategory;
  /** 该 path 下的所有 session id */
  sessionIds: string[];
  /** 收藏路径才有: 双击新建终端的默认模板 */
  defaultTemplateId?: string;
  /** Labels for filtering the sidebar, see path-tags.ts. */
  tags?: string[];
  /**
   * BETA-043:启动期扫描发现该路径已不可访问(被外部删除 / 权限变化等)。
   * 仅做 UI 标记(置灰 + ⚠️ icon),不自动从列表里清除,留给用户决定。
   */
  invalid?: boolean;
}

export interface LocalPathNode extends PathNodeBase {
  kind: 'local';
}

export interface RemotePathNode extends PathNodeBase {
  kind: 'ssh';
  /** 必填:指向 SshProfile.id。本地节点不应出现此字段。 */
  sshProfileId: string;
}

/**
 * 路径节点(用于侧栏渲染),按 kind discriminated union。
 *
 * v2.1 起 kind 必填。switch on `node.kind` 让 TS exhaustiveness check 强制
 * 处理所有分支,sshProfileId 在 ssh 分支自动 narrow 为 required。
 */
export type PathNode = LocalPathNode | RemotePathNode;

/**
 * 完整路径树 (snapshot / 广播用)。
 */
export interface PathTree {
  bookmarks: PathNode[];
  temporary: PathNode[];
  /** Colours picked for tags. A tag not listed here takes one from its name. */
  tagColors: TagColors;
}

// ──────────────────────────────────────────────────────────────────
// Ceteris Link(远程挂载)
// ──────────────────────────────────────────────────────────────────

/**
 * 一台已保存的远端 Host。
 *
 * token 明文存 settings.json,与 ai.apiKey 的处理一致。这是一个**有意识的
 * 折衷**:safeStorage 加密后的密文无法随配置导出到第二台机器,而 Ceteris Link
 * 的典型用法恰恰是"在两台机器上填同一个 token"。相应地,配置导出会剥掉
 * token 字段(见 cmd:settings:export),避免用户把归档发给别人时连带把自己
 * 终端的访问权一起送出去。
 */
export interface LinkHostEntry {
  id: string;
  /** 用户起的名字,如"家里台式机" */
  label: string;
  /** 建议填 Tailscale 的 100.x.y.z */
  host: string;
  port: number;
  /** 与对端 Host 的 hostToken 必须逐字符相同 */
  token: string;
  /** 应用启动时是否自动连接 */
  autoConnect: boolean;
}

/**
 * Ceteris Link 设置。
 *
 * 一个实例可以同时是 Host(让别人连进来)和 Client(连到别人那里),
 * 所以这里不是模式二选一,而是两组互相独立的配置。
 */
export interface LinkSettings {
  /** 是否监听、允许远程客户端连入 */
  hostEnabled: boolean;
  /**
   * 绑定地址。'auto' = 优先选本机的 Tailscale 地址,没有则退回 127.0.0.1。
   *
   * 默认不绑 0.0.0.0 是刻意的安全默认:绑到 tailnet 地址意味着这个端口只对
   * 你自己的设备可见。用户想要局域网访问必须显式选择。
   */
  hostBindAddress: string;
  hostPort: number;
  /**
   * 预共享 token。首次打开 Host 开关时自动生成 32 字节(base64url,43 字符)。
   *
   * 它从不在网络上传输:两端各自把它拌进 HKDF 派生会话密钥,"能解开对方的
   * 帧"就是认证通过的证明。详见 src/main/link/link-crypto.ts。
   */
  hostToken: string;
  /** 已保存的远端 Host 列表(Client 侧) */
  savedHosts: LinkHostEntry[];
}

// ──────────────────────────────────────────────────────────────────
// 持久化数据 schema (与磁盘 JSON 文件一一对应)
// ──────────────────────────────────────────────────────────────────

/**
 * settings.json 顶级结构 (软件定义书 11.1 settings.json)。
 *
 * CP-2 阶段所有字段都已定义,但只有 appearance.theme 真正在 UI 生效;
 * 其它字段在 CP-4 设置完整化时接通。
 */
export interface Settings {
  version: 1;

  appearance: {
    theme: ThemeId;
    windowStyle: WindowStyle; // M1-A:窗口风格 (windows / macos)
    /**
     * BETA-004 UI 语言。'system' 表示跟随系统 locale(app.getLocale()):
     * zh-* 默认中文,其他默认英文。固定 'zh-CN' / 'en-US' 强制使用对应语言。
     */
    language: 'system' | 'zh-CN' | 'en-US';
    terminalFontFamily: string;
    terminalFontSize: number;
    terminalLineHeight: number;
    uiFontFamily: string;
    uiZoom: number;
    /**
     * BETA-023:macOS 风格红绿灯按钮在 hover 时是否显示 ×/−/+ 悬浮符号。
     * 默认 false(保持 Ceteris 极简风,与 CP-4 勘误第二轮的决策一致);
     * 设为 true 可恢复原生 macOS 观感。
     */
    macOSTrafficLightHoverSymbols: boolean;
    /**
     * issue #4:隐藏顶部 TabBar。侧边栏已按路径分组显示所有 session,
     * TabBar 内容重复且占纵向空间。开启后:
     * - MainPane 不渲染 TabBar
     * - 点 PathItem 永远进 EmptyPathState 新建页(不再自动选第一个持有的 session)
     * - 切到已有 session 必须从 Sidebar 点 SessionItem
     * 与 simpleMode 正交:simpleMode 优先(它连 Sidebar 一起藏)。
     */
    hideTopTabBar: boolean;
    /**
     * ADR-027:agent 跑完一轮时的小庆祝(圆点上飞出几颗小星星,样式随主题)。
     * 默认开;关掉后标题栏小石子也一起不显示。
     */
    celebrations: boolean;
    /**
     * ADR-027:标题栏里 16px 的小石子。全部空闲时打盹,agent 干活时睁眼,
     * 跑完时笑两秒。它一直可见,所以默认关;celebrations 关时也不显示。
     */
    pebble: boolean;
    /**
     * ADR-030:Legado MD3 "Custom" 主题的种子色,'#rrggbb'。
     * 只在 theme 是 legado-md3-seed[-dark] 时用到。
     */
    legadoSeedColor: string;
    /** ADR-030:Legado MD3 实时主题(Custom 和 Windows 强调色)的调色风格。 */
    legadoPaletteStyle: LegadoPaletteStyle;
    /** ADR-030:Legado MD3 实时主题的对比度档位。 */
    legadoContrast: LegadoContrast;
  };

  /**
   * 窗口位置/尺寸记忆 (M1-G)。
   * V1 全局单一组,不区分 windowId — 新窗口都按这组开,关窗时把"最后一个"窗口的 bounds 写回。
   * 不存在 = 第一次启动 / 上次窗口都被外部干掉,fallback 1200x800 居中。
   */
  windowDefaults?: {
    width: number;
    height: number;
    x?: number;
    y?: number;
    maximized?: boolean;
  };

  shell: {
    /** 启动检测到的某个 shell id;空字符串表示用 PlatformAdapter 默认 */
    defaultShellId: string;
    newTerminalShellPolicy: NewTerminalShellPolicy;
  };

  behavior: {
    startupBehavior: StartupBehavior;
    autoStart: boolean;
    confirmOnQuit: boolean;
    selectOnCopy: boolean;
    terminalRightClick: TerminalRightClick;
    /** 右键 + 号时环绕显示的快捷启动选项,在 设置 → 行为 里编辑 */
    quickLaunch: QuickLaunchItem[];
    /**
     * 首次使用引导 "右键 + 号快速启动 agent" 是否已看过。默认 false;
     * 用户点 "知道了" 或第一次右键 + 号后写 true,之后不再弹。
     */
    quickLaunchTipSeen: boolean;
    /**
     * 远程设置引导 (ADR-032) 是否已回答过。默认 false:没配置任何远端时点标题栏的 Local
     * 会问一次"要不要让 AI 带你配置";用户选"不用了"或开始引导后写 true,之后只在菜单和
     * 设置 → 远程 里留一个入口。老设置文件 deep merge 补 false。
     */
    remoteSetupGuideSeen: boolean;
    /**
     * bracketed paste 协议 (fix/robustness-pass-20260513, CPB-P8)。
     * 启用时 handlePaste 包裹 \x1b[200~ ... \x1b[201~,支持的 shell
     * (PowerShell 7+, bash 5+, zsh, fish, Claude Code REPL)把粘贴
     * 内容当 literal,用户可编辑后再 Enter;不再被 shell 立即执行。
     *
     * 不支持的 shell(cmd.exe 无 readline / 老版 bash)会把 marker
     * 显示成 ^[[200~ 字面乱码。建议用 cmd 的用户关闭此项。
     *
     * 默认 true 因为 Ceteris 默认 shell 是 PowerShell,大多数用户用 pwsh。
     */
    bracketedPaste: boolean;
    /**
     * Check GitHub Releases for a newer version every few hours (ADR-018). Default true.
     * Only the stable channel checks on its own; beta and dev only check when asked.
     * Ceteris never downloads or installs by itself; it shows a direct download link.
     */
    autoCheckUpdates: boolean;
    /**
     * 后台检查 agent CLI (Claude Code / Codex ...) 有没有新版本:启动后和每 6 小时一次,
     * 有新版本时弹一条通知。默认 true。只在 stable 渠道自动跑。
     */
    autoCheckAgents: boolean;
    /**
     * 发现新版本后自动升级 agent。升级前先弹通知倒计时,用户可以"立即升级"或"跳过此版本";
     * 该 agent 有终端开着时等它关掉再升级。默认 false。需要 autoCheckAgents 开着。
     */
    autoUpdateAgents: boolean;
    /**
     * ADR-036:put a tab in the shelf after this many hours without output, key presses or an
     * exit. 0 (default) never shelves on its own; the tab menu can still shelve by hand.
     * Choices in Settings are SHELVE_AFTER_HOURS_CHOICES (shelf.ts). Tabs with a role and the
     * tab a window is showing are never shelved.
     */
    shelveIdleAfterHours: number;
    /**
     * ADR-039:reopen the tabs that were open when Ceteris last stopped (quit, update, crash).
     * Shells and built-in agents start again, Claude Code and Codex in their own conversation;
     * custom commands, SSH and the Admin Shell wait in the shelf. Default true.
     */
    restoreTabsOnLaunch: boolean;
  };

  systemIntegration: {
    /**
     * 从 Explorer 右键菜单触发 "在 Ceteris 终端中打开" 时,新 session 起在哪里。
     * - 'new-window': 始终开新窗口承载(默认,符合"右键 = 干净环境"直觉)
     * - 'recent-window-tab': 在最近活动窗口里新开 tab
     * 冷启动一律走 new-window 行为(没有可复用窗口),设置只在已开应用时生效。
     *
     * 注:**Explorer 右键集成是否已注册** 是系统状态,不是用户偏好,因此不在 settings 里。
     * 通过 IPC `cmd:explorer-integration:get-status` 现场查 HKCU 注册表 + MSIX 包获得,
     * 通过 `cmd:explorer-integration:set-{classic,modern}` 修改。导入导出归档时
     * 不携带注册状态,跨机器导入只复用 explorerOpenIn 等纯偏好。
     */
    explorerOpenIn: 'new-window' | 'recent-window-tab';
  };

  advanced: {
    logLevel: 'INFO' | 'DEBUG';
    activeIdleThresholdSeconds: number;
    // 注:v1.2 起 sessionTombstoneMinutes 已删除 (砍墓地,见 ADR-008)
    /**
     * SSH 方案 v2.1 §阶段 2.1:读取 ~/.ssh/config 合并到 profile 列表。
     *
     * - true:Ceteris 自管 SshProfile + ssh_config 的 Host 块在 sidebar /
     *   设置页"远程"分类合并显示;ssh_config 来源的条目带"ssh_config" 标签,
     *   只读不能编辑/删除(改请直接编辑 ~/.ssh/config)。
     * - false(默认):只显示 Ceteris 自管 profile。
     *
     * 设置入口在 RemotePanel。
     */
    includeSshConfig: boolean;

    /**
     * SSH 方案 v2.1 §阶段 3.5:启用 OpenSSH ControlMaster。
     *
     * true(默认):同一 host:port:user 的多个 session 复用第一个连接,
     * 启动后 ControlPersist=10m,期间新 session 0 握手(从 ~3s 降到 <100ms)。
     * 只在 Linux / macOS 生效:Windows 版 OpenSSH 不支持,开着也不会传这组参数。
     *
     * false:每个 session 独立握手(beta.9 行为)。
     *
     * 设置入口在 RemotePanel。
     */
    enableControlMaster: boolean;

    /**
     * 终端渲染器选择(影响 xterm.js 渲染层)。
     * - 'auto' = 平台默认:Windows / macOS 用 WebGL(性能 10-50× DOM),Linux
     *           强制 DOM(Chromium Mesa/EGL 软渲会让 xterm 滚动秒级响应)。
     *           **当前默认行为**。
     * - 'webgl' = 强制 WebGL。**警告**:Linux 上几乎必然慢得不可用。
     * - 'dom' = 强制 DOM renderer。性能差但稳定;某些应用(如 Codex)在
     *           WebGL 下光标渲染异常时是有效的回退手段。
     *
     * 设置变更对**已打开 tab 不生效**,需关 tab 重开(xterm 实例的 renderer
     * 在 mount 时决定,运行时切换需重建)。
     */
    terminalRenderer: 'auto' | 'webgl' | 'dom';
  };

  /**
   * 可选扩展。每项默认关,用户在 设置 → 扩展 里打开;只影响打开之后新建的终端。
   */
  extensions: {
    /**
     * Claude Code 公式图片 (ADR-019):终端按 iTerm2 内联图片协议画图,XTVERSION
     * 回 "iTerm2 3.5.0",Windows 上 PTY 改用 node-pty 自带的 ConPTY,Claude Code
     * 图片占位格画成空白,并把主题色与格子宽高比传给 latex-math 插件
     * (LATEX_MATH_* 环境变量)。需要另装仓库里 extensions/claude-latex-math 插件。
     */
    claudeMathImages: boolean;
    /**
     * Codex 公式渲染 (ADR-022):在终端里找以文本形式出现的 LaTeX (`$$...$$`、`\(...\)`、
     * `\[...\]`),用 KaTeX 在原处画出来。Codex 没有渲染钩子,所以由 Ceteris 在显示层做;
     * 设置页按钮可以把"公式写进行内代码"这条指示加进 ~/.codex/AGENTS.md。
     */
    terminalMath: boolean;
    /**
     * Coordinator tab control (ADR-024): Claude Code in a coordinator tab may list, open,
     * close, type into and read the other tabs of its folder through the ceteris-tabs
     * plugin (extensions/ceteris-tabs). Checked on every request, so it applies at once.
     */
    tabControl: boolean;
    /**
     * Whether the user closed the coordinator guide with Got it (ADR-024). Default false, and
     * older settings files get false too, so everyone sees the guide once after the update:
     * on the next launch, and again the first time they tick Coordinator until they close it.
     */
    tabControlGuideSeen: boolean;
    /**
     * Whether the one-time agent extension setup card (ADR-034) was answered with Set up or
     * Later. Default false, and older settings files get false too, so everyone sees it once.
     */
    setupSeen: boolean;
    /**
     * `name:` 命令 (ADR-020):在 Claude Code / Codex 终端里,单词开头敲已保存的名称
     * 加冒号,Ceteris 把它换成对应命令(默认 `/name`),不按 Enter。规则见
     * shared/colon-commands.ts。
     */
    colonCommands: {
      enabled: boolean;
      commands: ColonCommand[];
    };
  };

  /**
   * BETA-031 AI 助手 — 第一个 LLM 集成点。默认全 disabled,用户在设置页主动
   * 开启并填 API key 才生效。当前唯一 consumer 是 BETA-006(active→idle 跃迁
   * LLM 复核,避免 Vite 等长输出工具被误判 idle)。
   *
   * API key 走 settings.json 持久化;不做加密(与其它持久化字段一致)。
   * 备份导出导入会带这个字段,跨机器复制时需要小心 — README 已提示。
   */
  ai: {
    /** null = 未启用;选 anthropic / openai 后激活 ai-client */
    provider: 'anthropic' | 'openai' | null;
    /** 任意明文,UI 显示时遮罩;空串视为未填 */
    apiKey: string;
    /**
     * F6(beta 勘误2):自定义 Base URL。空串 = 走官方默认地址
     * (api.anthropic.com / api.openai.com/v1)。含义沿用官方 SDK 的 baseURL:
     * Anthropic 填到域名为止,OpenAI 填到 /v1 为止,ai-client.ts 补齐其余路径。
     * 覆盖场景:代理网关、自托管 LLM、企业内网镜像。
     */
    baseURL: string;
    /** 例如 'claude-haiku-5-5' / 'gpt-4o-mini',空串走 provider 默认 */
    model: string;
    /**
     * Guess the next prompt for Claude Code and Codex. Off by default,
     * because the end of the terminal screen leaves the machine. Separate from apiKey
     * above: this one works with no provider selected.
     */
    nextPrompt: {
      enabled: boolean;
      /**
       * An OpenRouter key is saved, encrypted, in secrets.json (ADR-025). Set only by the
       * main process. The key itself never appears in settings.
       */
      keySaved: boolean;
      /** Any OpenAI compatible API. Empty uses OpenRouter. */
      baseURL: string;
      /** Empty uses NEXT_PROMPT_DEFAULT_MODEL */
      model: string;
    };
    /**
     * ADR-029: short tab titles for agent tabs. The agent's own title is always shortened
     * to maxChars; with enabled on and an API connected (nextPrompt above), a model also
     * writes a title after each finished turn, following guide.
     */
    tabTitles: {
      enabled: boolean;
      /** The user's rules for titles, sent to the model. Empty uses the default guide. */
      guide: string;
      /** Longest title in characters, 8 to 60 */
      maxChars: number;
    };
    /** BETA-006:active→idle 跃迁前调 LLM 复核,默认关。开启需 apiKey 非空。 */
    statusRecheckEnabled: boolean;
    /**
     * BETA-006 v2:喂给 LLM 的输入源。
     * - 'headless' = main 端 @xterm/headless 维护的"已渲染"字符矩阵尾部 N 行,
     *                无 ANSI / 无重绘残影,唯一可用选项
     * - 'screenshot' = 多模态视觉,枚举值预留,UI 暂不暴露
     *
     * CURSOR-1 后:原 'raw'(裸字节 ring 末 2KB)选项已删除,裸字节 scrollback
     * 存储被 state-replay 架构(SerializeAddon)取代,不再保留。settings.json
     * 里残留的 'raw' 值在 SettingsManager 读取时会被 coerce 到 'headless'。
     */
    statusRecheckSource: 'headless' | 'screenshot';
  };

  /**
   * Ceteris Link:远程挂载。默认全关,用户在设置 → 远程访问里主动开启。
   *
   * 注意与 sshProfiles 的区别:SSH 是"在远端机器上跑一个 shell",终端会话
   * 仍然属于本机 Ceteris;Link 是"接管远端 Ceteris 的全部会话",连的是那台
   * 机器上已经在跑的 AI agent 标签页。两者互不替代。
   */
  link: LinkSettings;

  /**
   * ADR-038: per folder, the model and effort new Claude Code and Codex tabs start with.
   * A list (not a map) so an update replaces it whole; see @shared/agent-model.
   */
  agents: {
    folderDefaults: FolderAgentDefault[];
  };
}

/**
 * bookmarks.json 磁盘 schema(宽松版本)。kind 可选,kind === 'ssh' 时
 * sshProfileId 可缺(进程内 PathManager.initialize → migrateBookmarkOnLoad
 * 会丢弃损坏条目)。所有写盘前的内存 Bookmark 都是严格 discriminated union,
 * 通过 buildBookmark 构造。
 */
export interface BookmarksFile {
  version: 1;
  paths: PersistedBookmark[];
  tagColors?: TagColors;
}

/**
 * 磁盘层 Bookmark 形状:跟 beta.9 之前的旧 schema 兼容(无 kind / 缺
 * sshProfileId)。新代码请用严格类型 Bookmark(discriminated union)。
 */
export interface PersistedBookmark {
  id: string;
  path: string;
  kind?: PathKind;
  sshProfileId?: string;
  tags?: string[];
  displayName?: string;
  defaultTemplateId?: string;
  addedAt: number;
}

interface BookmarkBase {
  id: string;
  path: string;
  displayName?: string;
  defaultTemplateId?: string;
  tags?: string[];
  /** Unix ms */
  addedAt: number;
}

export interface LocalBookmark extends BookmarkBase {
  kind: 'local';
}

export interface RemoteBookmark extends BookmarkBase {
  kind: 'ssh';
  /** 必填:指向 SshProfile.id。本地 bookmark 不应出现此字段。 */
  sshProfileId: string;
}

/**
 * 收藏路径,按 kind discriminated union。v2.1 起 kind 必填。
 *
 * 旧磁盘数据(无 kind 字段或 kind === undefined)在 PathManager.initialize /
 * validateBookmarksArray 读取时统一 coerce 为 LocalBookmark。
 */
export type Bookmark = LocalBookmark | RemoteBookmark;

/**
 * recent.json 磁盘 schema(宽松版本)。同 BookmarksFile,kind/sshProfileId
 * 可选,启动期 migrateRecentOnLoad 丢弃损坏条目。
 */
export interface RecentFile {
  version: 1;
  paths: PersistedRecentEntry[];
}

export interface PersistedRecentEntry {
  path: string;
  kind?: PathKind;
  sshProfileId?: string;
  lastUsedAt: number;
  useCount: number;
}

interface RecentEntryBase {
  path: string;
  /** Unix ms,降序排序的依据 */
  lastUsedAt: number;
  useCount: number;
}

export interface LocalRecentEntry extends RecentEntryBase {
  kind: 'local';
}

export interface RemoteRecentEntry extends RecentEntryBase {
  kind: 'ssh';
  /** 必填:指向 SshProfile.id。本地 recent 不应出现此字段。 */
  sshProfileId: string;
}

/**
 * 最近列表项,按 kind discriminated union。v2.1 起 kind 必填。
 * 旧数据缺 kind 时由持久化层 coerce 为 LocalRecentEntry。
 */
export type RecentEntry = LocalRecentEntry | RemoteRecentEntry;

/**
 * SSH 服务器连接配置。可选保存密码:passwordEncrypted 是 Electron
 * safeStorage 加密后的 base64 文本,仅 main 进程能解密。送到 renderer
 * 的副本始终剥去 passwordEncrypted,仅保留 hasSavedPassword 标志。
 */
export interface SshProfile {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authType: 'agent' | 'keyFile' | 'password';
  keyFilePath?: string;
  /** safeStorage.encryptString 结果的 base64;只在 main 内部保留 */
  passwordEncrypted?: string;
  /** 仅 renderer 副本带:是否已保存密码 */
  hasSavedPassword?: boolean;
  defaultRemoteCwd?: string;
  /**
   * SSH 方案 v2.1 §阶段 2.3:ProxyJump 多级跳板。
   *
   * 数组形式:`['bastion.example.com', 'inner.example.com']` → `ssh -J bastion.example.com,inner.example.com`。
   * 每段可写 `user@host:port` 形式(与 OpenSSH -J 相同);空数组或缺失 = 不跳板。
   * Ceteris 不校验跳板格式,完整转发给 OpenSSH,跳板鉴权由 OpenSSH 自己处理
   * (复用主机已配的 SSH agent / key)。
   */
  proxyJump?: string[];
  tmuxMode?: SshTmuxMode;
  tmuxSessionName?: string;
  tmuxSessionPolicy?: SshTmuxSessionPolicy;
  tmuxOnMissing?: SshTmuxOnMissing;
  addedAt: number;
}

export interface SshProfilesFile {
  version: 1;
  profiles: SshProfile[];
}

/**
 * templates.json (CP-3 完整化,CP-2 不持久化模板)
 */
export interface TemplatesFile {
  version: 1;
  defaultTemplateId: string;
  templates: Template[];
}

export interface Template {
  /** 内置模板 id 固定,自定义为 UUID */
  id: string;
  name: string;
  /** emoji 或简单图标 */
  icon: string;
  isBuiltin: boolean;
  command: string;
  args: string[];
  env: Record<string, string>;
  shellFirst: boolean;
  postExitAction: PostExitAction;
  /** Left off the new tab page. It stays in Settings and still works where it is in use. */
  hidden?: boolean;
}

// ──────────────────────────────────────────────────────────────────
// IPC snapshot
// ──────────────────────────────────────────────────────────────────

/**
 * cmd:app:get-snapshot 的返回结构 (ipc-protocol 4.3)。
 */
export interface AppSnapshot {
  windows: WindowInfo[];
  sessions: SessionInfo[];
  pathTree: PathTree;
  sshProfiles: SshProfile[];
  templates: Template[];
  defaultTemplateId: string;
  settings: Settings;
  /** Shelved tabs, newest first (ADR-036). Empty from a main without a shelf. */
  shelf: ShelfEntry[];
  /** 回显发起方的 windowId,renderer 用来校验 */
  myWindowId: string;
}

// ──────────────────────────────────────────────────────────────────
// 内存中的 Session 句柄 (Main 内部用,不导出到 renderer)
// 这里只声明类型作为参考,真实定义在 src/main/session-manager.ts
// ──────────────────────────────────────────────────────────────────

/**
 * Session 与 PTY 的内存结构 (Main 内部使用,不通过 IPC 传)。
 * 真实定义在 SessionManager,这里只为文档化暴露 schema。
 */
export interface SessionRuntimeShape {
  info: SessionInfo;
  /** 环形 scrollback buffer,2MB 上限,CP-3 接入 (CP-2 留空) */
  scrollback: Buffer | null;
}
