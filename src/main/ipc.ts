/**
 * @file src/main/ipc.ts
 * @purpose 集中注册所有 IPC handler,把 Manager 的事件桥接到 webContents
 *   广播。Main 进程的"对外接口层"。
 *
 * @关键设计:
 * - 严格遵守 ipc-protocol.md:仅用 invoke/handle (禁用 send/on)
 * - 每个 handler 都接收 CommandEnvelope,带 windowId / requestId
 * - 错误统一通过 throw 让 ipcMain.handle 在 renderer 端 reject promise
 *   (renderer 用 try/catch 捕获带 code 的错误)
 * - Manager 事件 → broadcast/sendTo:广播策略按 ipc-protocol 2.5
 *   (path/settings/window 列表广播全部窗口;session output 仅 owner)
 *
 * @对应文档章节: docs/ipc-protocol.md 全部
 *
 * @CP-2 范围:
 * - cmd:app:get-protocol-version / get-snapshot / quit
 * - cmd:window:create / close-self / close-all / focus
 * - cmd:bookmark:* / path:remove-from-recent / system:show-in-explorer
 * - cmd:settings:get / update
 * - cmd:session:create / close / claim / release / focus-owner / send-input / resize
 * - 所有 evt:* 广播
 */
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, clipboard, ipcMain, dialog, safeStorage, shell } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import { shouldForwardToHost } from '@shared/link-protocol';
import { getAppLabel, getBuildType } from './build-type';
import {
  getExplorerIntegrationStatus,
  setClassicIntegration,
  setModernIntegration,
  getPsCommands,
} from './explorer-integration';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { resolve, join as joinPath } from 'node:path';
import {
  COMMAND_CHANNELS,
  EVENT_CHANNELS,
  PROTOCOL_VERSION,
  type AddBookmarkPayload,
  type AddBookmarkResponse,
  type AddRemoteBookmarkPayload,
  type DataAgentStats,
  type DataBundleSummary,
  type DataExportPayload,
  type DataExportResponse,
  type DataImportPayload,
  type DataImportResponse,
  type SetPaneSessionsPayload,
  type SuggestNextPromptPayload,
  type SuggestNextPromptResponse,
  type ViewStateResponse,
  type ViewSwitchPayload,
  type AddSshProfilePayload,
  type AddSshProfileResponse,
  type AppStateChangedPayload,
  type BookmarksUpdatedPayload,
  type ClaimSessionPayload,
  type ClaimSessionResponse,
  type ClipboardReadTextResponse,
  type ClipboardWriteTextPayload,
  type ClipboardWriteTextResponse,
  type CloseSessionPayload,
  type CommandEnvelope,
  type CreateSessionPayload,
  type CreateSessionResponse,
  type CreateWindowPayload,
  type CreateWindowResponse,
  type EventEnvelope,
  type FocusSessionOwnerPayload,
  type FocusSessionOwnerResponse,
  type LinkConnectionStatePayload,
  type FocusWindowPayload,
  type AddTemplatePayload,
  type AddTemplateResponse,
  type DeleteTemplatePayload,
  type DeleteSshProfilePayload,
  type ExportSettingsResponse,
  type GetAutoStartResponse,
  type GetProtocolVersionResponse,
  type GetScrollbackPayload,
  type GetScrollbackResponse,
  type GetSettingsResponse,
  type GetSnapshotPayload,
  type ImportSettingsResponse,
  type KnownHostsRefreshResponse,
  type ListShellsResponse,
  type ListSshProfilesResponse,
  type SshAgentStatusResponse,
  type SshConfigListResponse,
  type OpenExternalPayload,
  type SetDefaultTemplatePayload,
  type SettingsArchiveV1,
  type UpdateTemplatePayload,
  type UpdateTemplateResponse,
  type GetSnapshotResponse,
  type PathTreeUpdatedPayload,
  type PickFolderPayload,
  type PickFolderResponse,
  type PickSshKeyFilePayload,
  type PickSshKeyFileResponse,
  type QuitPayload,
  type QuitResponse,
  type OpenSessionInNewWindowPayload,
  type OpenSessionInNewWindowResponse,
  type ReleaseSessionPayload,
  type RemoveBookmarkPayload,
  type RemoveFromRecentPayload,
  type RenameBookmarkPayload,
  type ReorderBookmarksPayload,
  type ResizeSessionPayload,
  type ResizeSessionResponse,
  type SendInputPayload,
  type SendInputResponse,
  type SessionCreatedPayload,
  type SessionDestroyedPayload,
  type SessionExitedPayload,
  type SessionOutputPayload,
  type SessionOwnerChangedPayload,
  type SessionStateChangedPayload,
  type SetDefaultTemplateForBookmarkPayload,
  type SettingsChangedPayload,
  type SshProfilesUpdatedPayload,
  type ShowInExplorerPayload,
  type TemplateListUpdatedPayload,
  type TestSshProfilePayload,
  type TestSshProfileResponse,
  type UpdateSettingsPayload,
  type UpdateSshProfilePayload,
  type UpdateSshProfileResponse,
  type WindowFocusRequestedPayload,
  type WindowListUpdatedPayload,
  type ImeProbeDumpPayload,
  type ImeProbeDumpResponse,
  type LinkConnectPayload,
  type LinkConnectResponse,
  type LinkDisconnectPayload,
  type LinkKickClientPayload,
  type LinkListBindCandidatesResponse,
  type LinkRegenerateTokenResponse,
  type LinkStatusChangedPayload,
  type LinkStatusResponse,
} from '@shared/protocol';
import type { AppSnapshot, Settings, Template, ThemeId } from '@shared/types';
import type { WindowManager } from './window-manager';
import type { PathManager } from './path-manager';
import { pathRefFromId } from './path-manager';
import type { SettingsManager } from './settings-manager';
import type { SessionManager } from './session-manager';
import type { SshProfileManager } from './ssh-profile-manager';
import type { TemplatesManager } from './templates-manager';
import type { AIClient } from './ai-client';
import type { KnownHostsManager } from './known-hosts-manager';
import { parseSshConfig } from './ssh-config-parser';
import { detectSshAgent } from './ssh-agent';
import type {
  ListDirPayload,
  ListDirResponse,
  ReadPdfPayload,
  ReadPdfResponse,
  RenameEntryPayload,
  RenameEntryResponse,
} from '@shared/file-tree';
import { listDirectory, renameEntry } from './file-tree';
import { isAppPageUrl } from './ipc-sender';
import { readPdfChunk, readRemotePdfChunk } from './pdf-reader';
import type { SftpPool } from './sftp-client';
import {
  applyLocalThemeToResult,
  splitThemeUpdate,
  withLocalTheme,
} from '@shared/link-theme';
import { logger } from './logger';
import { setQuitting } from './index';
import { generateLinkToken } from './link/link-crypto';
import { listBindCandidates, type LinkManager } from './link/link-manager';
import {
  importAgents,
  measureAgentChats,
  readArchive,
  readManifest,
  readTabs,
  withLocalSecrets,
  writeBundle,
} from './data-bundle';
import { detectAgent } from '@shared/next-prompt';
import { suggestNextPrompt } from './next-prompt-client';
import type { ViewSwitcher } from './view-switcher';

export interface IpcLayerDeps {
  windowManager: WindowManager;
  pathManager: PathManager;
  settingsManager: SettingsManager;
  sessionManager: SessionManager;
  sshProfileManager?: SshProfileManager;
  /** SSH 方案 §阶段 3.1:已知主机指纹历史,可选(无 SSH 用户不创建) */
  knownHostsManager?: KnownHostsManager;
  templatesManager: TemplatesManager;
  /** BETA-031:可选,未注入时 AI_TEST_CONNECTION 返回 ok:false */
  aiClient?: AIClient;
  /**
   * Ceteris Link:可选。未注入时 cmd:link:get-status 返回"未监听"的空状态,
   * 其余 link 命令抛错。单测里的 deps 不带它。
   */
  linkManager?: LinkManager;
  /** Ceteris Link Client side. Optional for the same reason as linkManager. */
  viewSwitcher?: ViewSwitcher;
  /** SSH 路径的文件树和文件夹选择。未注入时远端请求返回 no-client */
  sftpPool?: SftpPool;
}

let installed = false;
let aiClient: AIClient | undefined;

/**
 * Ceteris Link:事件广播需要感知虚拟窗口(Host 侧的远程客户端)与远程绑定
 * 窗口(Client 侧连到远端的本地窗口)。broadcastEvent / sendEventTo 是模块级
 * 函数,拿不到 deps,所以在 install 时把 WindowManager 存一份。
 *
 * installed 守卫保证只会被赋值一次,与既有的 aiClient 同一模式。
 */
let linkWindowManager: WindowManager | null = null;
let linkSettingsManager: SettingsManager | null = null;

/**
 * 注册全部 IPC handler 与事件桥接。整个应用只能调用一次。
 */
export function installIpcLayer(deps: IpcLayerDeps): void {
  if (installed) throw new Error('[ipc] installIpcLayer() already called');
  installed = true;
  aiClient = deps.aiClient;
  linkWindowManager = deps.windowManager;
  linkSettingsManager = deps.settingsManager;
  registerCommandHandlers(deps);
  wireEventBroadcasts(deps);
}

// ──────────────────────────────────────────────────────────────────
// 工具:事件广播
// ──────────────────────────────────────────────────────────────────

function wrapEvent<P>(payload: P): EventEnvelope<P> {
  return { eventId: randomUUID(), timestamp: Date.now(), payload };
}

/**
 * 广播一条事件给所有窗口。
 *
 * Ceteris Link 之后这里有两处偏离"发给所有 BrowserWindow"的直觉:
 *
 * 1. **跳过远程绑定窗口(Client 侧)**。这类窗口的 renderer 显示的是远端
 *    Host 的数据,它的 store 由 Host 推来的事件驱动。若本机守护进程也往里
 *    塞自己的 path 树 / session 列表,两份互不相干的状态会互相覆盖,表现
 *    为侧栏内容诡异闪烁、终端标签凭空出现又消失。
 *
 * 2. **补上虚拟窗口(Host 侧)**。远程客户端不是 BrowserWindow,
 *    getAllWindows() 看不到它们,必须显式遍历。
 */
function broadcastEvent<P>(channel: string, payload: P): void {
  const envelope = wrapEvent(payload);
  const wm = linkWindowManager;
  // list() 提到循环外:每条广播只构建一次映射。放在循环里会变成 O(n²) 次
  // 分配,而 path tree / settings 这类事件在用户拖动时可以打得很密。
  const remoteElectronIds = new Set<number>();
  if (wm) {
    for (const info of wm.list()) {
      if (wm.isWindowRemote(info.id)) remoteElectronIds.add(info.electronWindowId);
    }
  }
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    if (remoteElectronIds.has(win.webContents.id)) continue;
    win.webContents.send(channel, envelope);
  }
  wm?.forEachVirtualWindow((send) => send(channel, envelope));
}

function sendEventTo<P>(win: BrowserWindow, channel: string, payload: P): void {
  if (win.isDestroyed()) return;
  win.webContents.send(channel, wrapEvent(payload));
}

/**
 * 按 windowId 定向推送一条事件。目标可以是本机窗口,也可以是 Ceteris Link
 * 的远程客户端(虚拟窗口),调用方不需要区分。
 *
 * 用于 owner-only 的推送(evt:session:output)—— 远程客户端 claim 了某个
 * session 之后,PTY 字节流就要顺着 socket 流到它那里,而不是留在 Host。
 *
 * @returns 是否找到投递目标
 */
function sendEventToWindowId<P>(windowId: string, channel: string, payload: P): boolean {
  const wm = linkWindowManager;
  if (!wm) return false;
  return wm.deliverEvent(windowId, channel, wrapEvent(payload));
}

// ──────────────────────────────────────────────────────────────────
// Ceteris Link:命令转发
// ──────────────────────────────────────────────────────────────────

/**
 * 把一条命令转发给远端 Host 并等待结果。由 link-client.ts 在建立连接时注入。
 *
 * 为什么用注入而不是直接 import LinkClient:ipc.ts 是被 link-client.ts 依赖的
 * 下游(转发回来的命令最终要落到这里注册的 handler 上),直接 import 会形成
 * 循环依赖。注入让依赖方向保持单向。
 */
type LinkCommandForwarder = (
  windowId: string,
  channel: string,
  payload: unknown,
) => Promise<unknown>;

let linkCommandForwarder: LinkCommandForwarder | null = null;

/**
 * 注册 / 注销命令转发器。传 null 表示不再有任何远程连接。
 */
export function setLinkCommandForwarder(fn: LinkCommandForwarder | null): void {
  linkCommandForwarder = fn;
}

/**
 * 广播一次 Link 状态给所有窗口(设置页据此刷新状态条)。
 *
 * 由 LinkManager 在连接状态变化时调用。放在 ipc.ts 而不是 LinkManager 里,
 * 是为了让"往 renderer 推事件"这件事只有 ipc.ts 一个出口。
 */
export function broadcastLinkStatus(payload: LinkStatusChangedPayload): void {
  broadcastEvent<LinkStatusChangedPayload>(EVENT_CHANNELS.LINK_STATUS_CHANGED, payload);
}

/**
 * 注册一条命令 handler,并在最外层插入 Ceteris Link 的路由判断。
 *
 * 路由规则(见 @shared/link-protocol 的 LINK_LOCAL_ONLY_CHANNELS):
 * - 发起窗口不是远程窗口 → 本地执行,行为与 Link 出现之前完全一致
 * - 是远程窗口 + 该命令属于"操作远端数据" → 转发给 Host,返回 Host 的结果
 * - 是远程窗口 + 该命令属于"操作本机这块玻璃"(窗口控制 / 剪贴板 / 退出)
 *   → 仍在本地执行
 *
 * 为什么统一包一层而不是在 65 个 handler 里各写各的:漏掉任何一条都会造成
 * 难以察觉的错误行为(比如漏了 cmd:session:close,远程用户点关闭会去关掉
 * 本机一个同 id 的 session,而本机根本没有那个 id,于是静默无反应)。
 * 集中一处 + 一张显式白名单,才能保证"新增 channel 时默认是安全的转发"。
 */
/**
 * Ceteris Link(Host 侧):channel → 本地 handler 的直呼表。
 *
 * 为什么需要它:Electron 只允许 renderer 通过 ipcRenderer.invoke 触发
 * ipcMain.handle 注册的 handler,主进程内部没有"自己调用自己 handler"的
 * 官方 API。远程客户端的命令是从 TCP 进来的,不经过任何 renderer,所以
 * 必须有一张自己的表。
 *
 * handleCommand 在注册 ipcMain.handle 的同时往这里存一份,保证两条入口
 * (本地 renderer / 远程客户端)执行的**是同一个函数**,不存在实现漂移。
 */
const localCommandHandlers = new Map<
  string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (event: IpcMainInvokeEvent, ...args: any[]) => unknown
>();

/**
 * 这些命令会弹 Electron 原生对话框,必须挂在一个真实窗口上。
 *
 * 远程客户端触发它们时,对话框会出现在 **Host 的屏幕**上(路径属于 Host,
 * 这是唯一语义正确的行为)。但如果 Host 此刻处于纯托盘模式、一个窗口都没有,
 * 就没有可挂载的父窗口,Electron 会抛一个很难懂的错。这里提前拦下并给出
 * 一条远程用户看得懂的提示。
 */
const DIALOG_PARENT_REQUIRED_CHANNELS: ReadonlySet<string> = new Set([
  COMMAND_CHANNELS.BOOKMARK_PICK_FOLDER,
  COMMAND_CHANNELS.SSH_PROFILE_PICK_KEY_FILE,
  COMMAND_CHANNELS.SETTINGS_EXPORT,
  COMMAND_CHANNELS.SETTINGS_IMPORT,
]);

/**
 * Host 侧:执行一条来自远程客户端的命令。
 *
 * @param channel IPC channel 名
 * @param envelope 已把 windowId 重写为虚拟窗口 id 的信封
 * @returns handler 的返回值
 *
 * @throws Error 未知 channel(客户端版本比 Host 新)、需要对话框父窗口但
 *   Host 无窗口、或 handler 本身抛出的业务错误
 */
export async function dispatchLocalCommand(
  channel: string,
  envelope: CommandEnvelope<unknown>,
): Promise<unknown> {
  const listener = localCommandHandlers.get(channel);
  if (!listener) {
    throw new Error(
      `[ipc] dispatchLocalCommand: 未知 channel "${channel}"。` +
        `可能原因:(1) 客户端版本比 Host 新,用到了 Host 还没有的命令;` +
        `(2) channel 名拼错。建议:把两端 Ceteris 升级到同一版本。`,
    );
  }

  let parentWebContents: IpcMainInvokeEvent['sender'] | null = null;
  const hostWindow = linkWindowManager?.getMostRecentlyActive() ?? null;
  if (hostWindow && !hostWindow.isDestroyed()) {
    parentWebContents = hostWindow.webContents;
  }

  if (DIALOG_PARENT_REQUIRED_CHANNELS.has(channel) && !parentWebContents) {
    throw new Error(
      `[ipc] "${channel}" 需要在 Host 上弹出原生对话框,但 Host 当前没有打开任何窗口` +
        `(纯托盘模式)。请在 Host 机器上先打开一个 Ceteris 窗口,或改为直接手动输入路径。`,
    );
  }

  // 合成一个最小的 IpcMainInvokeEvent。只有 sender 字段会被少数几个需要
  // 对话框父窗口的 handler 读到(已在上面校验非空),其余字段没有 handler
  // 使用 —— 这一点由 ipc.ts 里"first param 一律写作 _e"的约定保证。
  const syntheticEvent = { sender: parentWebContents } as unknown as IpcMainInvokeEvent;
  return listener(syntheticEvent, envelope);
}

/**
 * 转发一条远程窗口的命令,并应用"主题跟随本机"的规则 (见 @shared/link-theme)。
 * 主题写到本机设置,其余部分照常转发;读设置的结果覆盖成本机主题。
 */
async function forwardWithLocalTheme(
  forward: LinkCommandForwarder,
  windowId: string,
  channel: string,
  payload: unknown,
): Promise<unknown> {
  if (channel === COMMAND_CHANNELS.SETTINGS_UPDATE) {
    const { partial } = payload as UpdateSettingsPayload;
    const { theme, rest } = splitThemeUpdate(partial);
    if (theme) linkSettingsManager?.update({ appearance: { theme } });
    return rest ? forward(windowId, channel, { partial: rest }) : undefined;
  }
  const result = await forward(windowId, channel, payload);
  const theme = linkSettingsManager?.get().appearance.theme;
  return theme ? applyLocalThemeToResult(channel, result, theme) : result;
}

/**
 * Client 侧:Host 推来的 settings 事件也要覆盖主题,否则 Host 改任何一项设置
 * 都会把远程窗口的主题换回 Host 的。由 link-client.ts 在注入事件前调用。
 *
 * @param channel 事件 channel
 * @param envelope Host 包好的事件信封
 * @returns 要发给 renderer 的信封
 */
export function applyLocalThemeToLinkEvent(channel: string, envelope: unknown): unknown {
  const theme = linkSettingsManager?.get().appearance.theme;
  if (channel !== EVENT_CHANNELS.SETTINGS_CHANGED || !theme) return envelope;
  const typed = envelope as EventEnvelope<SettingsChangedPayload>;
  return {
    ...typed,
    payload: { ...typed.payload, settings: withLocalTheme(typed.payload.settings, theme) },
  };
}

/**
 * 本机主题变化后推给所有远程窗口。broadcastEvent 故意跳过它们,而且它们的
 * settings 来自 Host,所以要先取 Host 的最新设置再覆盖主题。单个窗口失败
 * (连接正断开) 只记日志,重连后 renderer 重新拉 snapshot 就会拿到正确主题。
 */
async function syncThemeToRemoteWindows(theme: ThemeId): Promise<void> {
  const wm = linkWindowManager;
  const forward = linkCommandForwarder;
  if (!wm || !forward) return;
  // 并行:一台 Host 卡住时不能拖慢连到其它 Host 的窗口
  const remoteWindows = wm.list().filter((info) => wm.isWindowRemote(info.id));
  await Promise.allSettled(
    remoteWindows.map(async (info) => {
      try {
        const res = (await forward(
          info.id,
          COMMAND_CHANNELS.SETTINGS_GET,
          undefined,
        )) as GetSettingsResponse;
        sendEventToWindowId<SettingsChangedPayload>(info.id, EVENT_CHANNELS.SETTINGS_CHANGED, {
          settings: withLocalTheme(res.settings, theme),
          changedKeys: ['appearance.theme'],
        });
      } catch (err) {
        logger.warn('ipc', `syncThemeToRemoteWindows failed: window=${info.id}`, err);
      }
    }),
  );
}

/** 与 window-manager.ts 加载的页面是同一个文件。 */
const APP_PAGE_URL = pathToFileURL(resolve(__dirname, '../renderer/index.html')).href;

function handleCommand(
  channel: string,
  // `any[]` 是刻意的:它与 Electron 自己的 ipcMain.handle 签名一致。改成
  // unknown[] 会在 strictFunctionTypes 下让全部 65 个带具体 envelope 类型的
  // handler 报逆变错误 —— 那不是类型更安全,只是把 65 处都逼着加断言。
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  listener: (event: IpcMainInvokeEvent, ...args: any[]) => unknown,
): void {
  localCommandHandlers.set(channel, listener);
  ipcMain.handle(channel, async (event, ...args: unknown[]) => {
    // 拿不到 frame 也要拒绝:frame 已销毁时 Electron 31 给的是 undefined,不是 null
    const frame = event.senderFrame;
    if (!(frame && isAppPageUrl(frame.url, APP_PAGE_URL, process.env['ELECTRON_RENDERER_URL']))) {
      logger.error('ipc', `refused ${channel} from "${frame?.url ?? 'destroyed frame'}"`);
      throw makeIpcError('ForbiddenSender', `channel="${channel}"`);
    }
    const envelope = args[0] as CommandEnvelope<unknown> | undefined;
    const windowId = envelope?.windowId;
    if (
      windowId &&
      linkWindowManager?.isWindowRemote(windowId) &&
      shouldForwardToHost(channel)
    ) {
      if (!linkCommandForwarder) {
        throw new Error(
          `[ipc] ${channel}: 窗口 ${windowId} 标记为远程窗口,但没有可用的转发器。` +
            `可能原因:(1) 连接已断开但窗口未被清理;(2) setLinkCommandForwarder 未被调用。` +
            `建议:关闭该远程窗口重开;若反复出现请看日志里 LinkClient 的连接状态。`,
        );
      }
      return forwardWithLocalTheme(linkCommandForwarder, windowId, channel, envelope?.payload);
    }
    return listener(event, ...args);
  });
}

// ──────────────────────────────────────────────────────────────────
// Command handlers
// ──────────────────────────────────────────────────────────────────

function registerCommandHandlers(deps: IpcLayerDeps): void {
  const {
    windowManager,
    pathManager,
    settingsManager,
    sessionManager,
    sshProfileManager,
    knownHostsManager,
    templatesManager,
  } = deps;

  // App
  handleCommand(
    COMMAND_CHANNELS.APP_GET_PROTOCOL_VERSION,
    (): GetProtocolVersionResponse => ({
      protocolVersion: PROTOCOL_VERSION,
      buildVersion: app.getVersion(),
      buildType: getBuildType(),
      appLabel: getAppLabel(),
    }),
  );

  handleCommand(
    COMMAND_CHANNELS.APP_GET_SNAPSHOT,
    (_e, envelope: CommandEnvelope<GetSnapshotPayload>): GetSnapshotResponse => {
      return buildSnapshot(deps, envelope.windowId);
    },
  );

  handleCommand(
    COMMAND_CHANNELS.APP_QUIT,
    async (_e, _envelope: CommandEnvelope<QuitPayload>): Promise<QuitResponse> => {
      // CP-2 简化:无 session 在跑时的二次确认 (CP-3 加入)
      setQuitting();
      app.quit();
      return { cancelled: false };
    },
  );

  // Window
  handleCommand(
    COMMAND_CHANNELS.WINDOW_CREATE,
    (_e, _envelope: CommandEnvelope<CreateWindowPayload>): CreateWindowResponse => {
      const info = windowManager.createWindowFromFactory();
      return { windowId: info.id, windowNumber: info.number };
    },
  );

  handleCommand(
    COMMAND_CHANNELS.WINDOW_CLOSE_SELF,
    (_e, envelope: CommandEnvelope<undefined>): void => {
      windowManager.closeWindow(envelope.windowId);
    },
  );

  handleCommand(
    COMMAND_CHANNELS.WINDOW_CLOSE_ALL,
    (_e, _envelope: CommandEnvelope<undefined>): void => {
      windowManager.closeAll();
    },
  );

  // M1-A:自绘标题栏配套的窗口控制
  handleCommand(
    COMMAND_CHANNELS.WINDOW_MINIMIZE,
    (_e, envelope: CommandEnvelope<undefined>): void => {
      windowManager.minimizeWindow(envelope.windowId);
    },
  );

  handleCommand(
    COMMAND_CHANNELS.WINDOW_TOGGLE_MAXIMIZE,
    (_e, envelope: CommandEnvelope<undefined>): void => {
      windowManager.toggleMaximizeWindow(envelope.windowId);
    },
  );

  handleCommand(
    COMMAND_CHANNELS.WINDOW_GET_MAX_STATE,
    (_e, envelope: CommandEnvelope<undefined>) => {
      return { maximized: windowManager.isMaximized(envelope.windowId) };
    },
  );

  handleCommand(
    COMMAND_CHANNELS.WINDOW_FOCUS,
    (_e, envelope: CommandEnvelope<FocusWindowPayload>): void => {
      const ok = windowManager.focus(envelope.payload.windowId);
      if (!ok) {
        throw makeIpcError('WindowNotFound', `windowId="${envelope.payload.windowId}"`);
      }
      const win = windowManager.getById(envelope.payload.windowId);
      if (win) {
        sendEventTo<WindowFocusRequestedPayload>(
          win,
          EVENT_CHANNELS.WINDOW_FOCUS_REQUESTED,
          { reason: 'manual' },
        );
      }
    },
  );

  // Session
  handleCommand(
    COMMAND_CHANNELS.SESSION_CREATE,
    async (
      _e,
      envelope: CommandEnvelope<CreateSessionPayload>,
    ): Promise<CreateSessionResponse> => {
      const {
        pathId,
        templateId,
        shellId,
        takeOwnership = true,
        cols,
        rows,
        sshTmuxMode,
      } = envelope.payload;
      const oldTreeJson = JSON.stringify(pathManager.getTree());
      const effectiveTemplateId =
        templateId ?? templatesManager.getDefaultTemplateId();
      const pathRef = pathId ? pathRefFromId(pathId) : null;
      const sshProfile =
        pathRef?.kind === 'ssh' && pathRef.sshProfileId
          ? sshProfileManager?.getInternal(pathRef.sshProfileId)
          : null;
      if (pathRef?.kind === 'ssh' && !sshProfile) {
        throw makeIpcError('SshProfileNotFound', `sshProfileId="${pathRef.sshProfileId}"`);
      }
      // takeOwnership=false 时直接传空 owner — createSession 内部
      // `input.ownerWindowId || null` 会落到 info.ownerWindowId = null。
      // 不要先创建带 owner 再 releaseOwner:那条路径在 owner=='' 时已被
      // 折叠为 null,后续 releaseOwner 会因 null !== envelope.windowId 抛 NotOwner。
      const sshProfileForLaunch = sshProfile
        ? {
            ...sshProfile,
            // tmux 是首页按钮表达的"本次启动意图",不是 SSH profile 状态。
            // 这样即使旧 profile 里残留 tmuxMode,首页"连接"仍稳定是纯 SSH。
            tmuxMode:
              sshTmuxMode === 'attach-or-create'
                ? 'attach-or-create' as const
                : 'disabled' as const,
            tmuxOnMissing: 'fallback-shell' as const,
            // 在 main 进程里立刻解密;session-manager 只看到明文,不持有
            // safeStorage 句柄。解密失败(profile 文件来自另一台机器 / 用户)
            // 时悄悄丢弃,会自动回退到交互式密码提示。
            ...(sshProfile.passwordEncrypted
              ? decryptStoredPassword(sshProfile.passwordEncrypted)
              : {}),
          }
        : null;
      if (sshProfileForLaunch) {
        delete (sshProfileForLaunch as { passwordEncrypted?: string }).passwordEncrypted;
      }
      const session = await sessionManager.createSession({
        pathId: pathId ?? '',
        templateId: effectiveTemplateId,
        ownerWindowId: takeOwnership ? envelope.windowId : '',
        cols,
        rows,
        ...(shellId ? { shellIdOverride: shellId } : {}),
        ...(sshProfileForLaunch ? { sshProfile: sshProfileForLaunch } : {}),
      });
      const pathTreeChanged =
        JSON.stringify(pathManager.getTree()) !== oldTreeJson;
      const warning = sessionManager.lastLaunchWarning ?? undefined;
      return warning ? { session, pathTreeChanged, warning } : { session, pathTreeChanged };
    },
  );

  handleCommand(
    COMMAND_CHANNELS.SESSION_CLOSE,
    (_e, envelope: CommandEnvelope<CloseSessionPayload>): void => {
      sessionManager.closeSession(envelope.payload.sessionId);
    },
  );

  // M1-C
  handleCommand(
    COMMAND_CHANNELS.SESSION_RENAME,
    (_e, envelope: CommandEnvelope<{ sessionId: string; newDisplayName: string }>): void => {
      sessionManager.renameSession(envelope.payload.sessionId, envelope.payload.newDisplayName);
    },
  );

  // STM-3:清除手动重命名标记
  handleCommand(
    COMMAND_CHANNELS.SESSION_CLEAR_MANUAL_RENAME,
    (_e, envelope: CommandEnvelope<{ sessionId: string }>): void => {
      sessionManager.clearManualRename(envelope.payload.sessionId);
    },
  );

  handleCommand(
    COMMAND_CHANNELS.SESSION_CLAIM,
    async (
      _e,
      envelope: CommandEnvelope<ClaimSessionPayload>,
    ): Promise<ClaimSessionResponse> => {
      sessionManager.claimOwner(envelope.payload.sessionId, envelope.windowId);
      // CP-2 勘误后:scrollback ring buffer 已实现。带回历史以保协议自洽,
      // 但 renderer 通常用 cmd:session:get-scrollback 单独拉,以避免 claim
      // 动作和 history-replay 时序耦合 (TerminalView 重新挂载场景非 claim 触发)
      // CURSOR-1 后:替换路径 = getScrollbackForReplay(state-replay 架构,
      // 返回完整终端状态 ANSI 流),需 async + await。
      const sb = await sessionManager.getScrollbackForReplay(
        envelope.payload.sessionId,
      );
      return { scrollback: sb.data, lastSeq: sb.lastSeq };
    },
  );

  handleCommand(
    COMMAND_CHANNELS.SESSION_SET_PANE_SESSIONS,
    (_e, envelope: CommandEnvelope<SetPaneSessionsPayload>): void => {
      sessionManager.setPaneSessions(envelope.windowId, envelope.payload.sessionIds);
    },
  );

  handleCommand(
    COMMAND_CHANNELS.SESSION_GET_SCROLLBACK,
    async (
      _e,
      envelope: CommandEnvelope<GetScrollbackPayload>,
    ): Promise<GetScrollbackResponse> => {
      // CURSOR-1:走 state-replay 路径(SerializeAddon),不再返回裸字节。
      // 详见 SessionManager.getScrollbackForReplay 与 docs/issues/cursor-1-...
      return sessionManager.getScrollbackForReplay(envelope.payload.sessionId);
    },
  );

  handleCommand(
    COMMAND_CHANNELS.SESSION_EXPORT_SCROLLBACK,
    async (
      _e,
      envelope: CommandEnvelope<{ sessionId: string }>,
    ): Promise<{ text: string }> => {
      // BETA-028:工具栏"复制全部"按钮 → 返回 UTF-8 字符串。
      // CURSOR-1 后 exportScrollback 改 async(读 headless 前需 drain parser)。
      return sessionManager.exportScrollback(envelope.payload.sessionId);
    },
  );

  handleCommand(
    COMMAND_CHANNELS.SESSION_CLEAR_SCROLLBACK,
    (
      _e,
      envelope: CommandEnvelope<{ sessionId: string }>,
    ): void => {
      // BETA-028:工具栏"清屏"按钮配合 term.clear() 使用
      sessionManager.clearScrollback(envelope.payload.sessionId);
    },
  );

  handleCommand(
    COMMAND_CHANNELS.SESSION_RELEASE,
    (_e, envelope: CommandEnvelope<ReleaseSessionPayload>): void => {
      sessionManager.releaseOwner(envelope.payload.sessionId, envelope.windowId);
    },
  );

  handleCommand(
    COMMAND_CHANNELS.SESSION_OPEN_IN_NEW_WINDOW,
    (
      _e,
      envelope: CommandEnvelope<OpenSessionInNewWindowPayload>,
    ): OpenSessionInNewWindowResponse => {
      const { sessionId } = envelope.payload;
      const session = sessionManager.get(sessionId);
      if (!session) {
        throw makeIpcError('SessionNotFound', `sessionId="${sessionId}"`);
      }
      // 允许两种情况:
      //   1) 当前 owner 就是调用方 → 先释放再 claim 给新窗口(经典"移到新窗口")
      //   2) session 是 orphan(无主) → 不需要释放,直接 claim 给新窗口
      // 拒绝:其他窗口正持有 — 跨窗口偷会话不在本协议允许范围。
      if (
        session.ownerWindowId !== null &&
        session.ownerWindowId !== envelope.windowId
      ) {
        throw makeIpcError(
          'NotOwner',
          `sessionId="${sessionId}" 由其他窗口持有(${session.ownerWindowId}),不能从此窗口移动`,
        );
      }
      // 同步:若是调用方持有则先 release,然后造新窗口 + claim — 新窗口拉
      // snapshot 时已经是它持有的状态,renderer 从 URL ?selectSessionId 读到
      // 目标后直接 dispatch 选中,没有跨进程时序竞争。
      if (session.ownerWindowId === envelope.windowId) {
        sessionManager.releaseOwner(sessionId, envelope.windowId);
      }
      // 从调用方窗口的当前 bounds 计算级联偏移,避免新窗口完全盖在旧窗口上。
      // getNormalBounds 排除最大化/全屏的扩展尺寸,所以即使调用方是 maximized,
      // 新窗口也会落到"该窗口被还原后的位置 + 偏移",不会撑满屏幕。
      const callerWin = windowManager.getById(envelope.windowId);
      const cascadeBounds = (() => {
        if (!callerWin || callerWin.isDestroyed()) return undefined;
        const b = callerWin.getNormalBounds();
        const CASCADE = 32;
        return {
          width: b.width,
          height: b.height,
          x: b.x + CASCADE,
          y: b.y + CASCADE,
          maximized: false,
        };
      })();
      const info = windowManager.createWindowFromFactory({
        selectSessionId: sessionId,
        ...(envelope.payload.simpleMode ? { simpleMode: true } : {}),
        ...(cascadeBounds ? { initialBounds: cascadeBounds } : {}),
      });
      try {
        sessionManager.claimOwner(sessionId, info.id);
      } catch (err) {
        // 极小概率:在 release 与 claim 之间另一个窗口抢先 claim。session 留
        // 在那里(orphan 或被抢),新窗口仍开出来,只是不会自动 select。
      }
      return { windowId: info.id, windowNumber: info.number };
    },
  );

  handleCommand(
    COMMAND_CHANNELS.SESSION_FOCUS_OWNER,
    (
      _e,
      envelope: CommandEnvelope<FocusSessionOwnerPayload>,
    ): FocusSessionOwnerResponse => {
      const session = sessionManager.get(envelope.payload.sessionId);
      if (!session) {
        throw makeIpcError(
          'SessionNotFound',
          `sessionId="${envelope.payload.sessionId}"`,
        );
      }
      if (!session.ownerWindowId) return { transferred: false }; // 无主无可聚焦
      // 虚拟窗口代表另一台机器。任一方是虚拟窗口,都没有一个能浮到用户面前的
      // 窗口,所以改为交接。两个本地窗口之间仍是聚焦,所有权不变。
      if (
        windowManager.isVirtualWindow(session.ownerWindowId) ||
        windowManager.isVirtualWindow(envelope.windowId)
      ) {
        sessionManager.transferOwner(session.id, envelope.windowId);
        return { transferred: true };
      }
      const ok = windowManager.focus(session.ownerWindowId);
      if (!ok) return { transferred: false }; // owner 窗口已不存在,静默
      const ownerWin = windowManager.getById(session.ownerWindowId);
      if (ownerWin) {
        sendEventTo<WindowFocusRequestedPayload>(
          ownerWin,
          EVENT_CHANNELS.WINDOW_FOCUS_REQUESTED,
          { reason: 'session-click', selectSessionId: session.id },
        );
      }
      return { transferred: false };
    },
  );

  handleCommand(
    COMMAND_CHANNELS.SESSION_SEND_INPUT,
    (
      _e,
      envelope: CommandEnvelope<SendInputPayload>,
    ): SendInputResponse => {
      // IPC-3:ownership 校验 — 防止 renderer 状态短暂落后于 main 时,
      // 一个已不归本窗口的 session 仍接受写入(用户视觉上"打字了但没回显",
      // 因为 sessionOutput 推给了真 owner)。
      //
      // 允许放行的情况:
      //   - 调用方就是 owner — 正常情况
      //   - session.ownerWindowId === null(orphan)— renderer 即将 claim,
      //     允许写入避免乱码丢字符;一旦 claim 成功 sessionOutput 自然推回
      //
      // 拒绝的情况:
      //   - session.ownerWindowId 是其他窗口 — 真的不该写,返回 not-owner
      const sess = sessionManager.get(envelope.payload.sessionId);
      if (
        sess &&
        sess.ownerWindowId !== null &&
        sess.ownerWindowId !== envelope.windowId
      ) {
        return { accepted: false, reason: 'not-owner' };
      }
      return sessionManager.sendInput(
        envelope.payload.sessionId,
        envelope.payload.data,
      );
    },
  );

  handleCommand(
    COMMAND_CHANNELS.SESSION_RESIZE,
    (
      _e,
      envelope: CommandEnvelope<ResizeSessionPayload>,
    ): ResizeSessionResponse => {
      return sessionManager.resize(
        envelope.payload.sessionId,
        envelope.payload.cols,
        envelope.payload.rows,
      );
    },
  );

  // Bookmark / Path
  handleCommand(
    COMMAND_CHANNELS.BOOKMARK_ADD,
    async (
      _e,
      envelope: CommandEnvelope<AddBookmarkPayload>,
    ): Promise<AddBookmarkResponse> => {
      // 校验路径是目录 (软件定义书 5.1.1 要求文件夹选择器/拖拽路径,
      // ipc-protocol PathNotDirectory / PathNotExist 错误码)
      await assertDirectory(envelope.payload.path);
      const bookmark = pathManager.addBookmark({
        path: envelope.payload.path,
        ...(envelope.payload.displayName ? { displayName: envelope.payload.displayName } : {}),
        ...(envelope.payload.defaultTemplateId
          ? { defaultTemplateId: envelope.payload.defaultTemplateId }
          : {}),
      });
      return { bookmark };
    },
  );

  handleCommand(
    COMMAND_CHANNELS.BOOKMARK_REMOVE,
    (_e, envelope: CommandEnvelope<RemoveBookmarkPayload>): void => {
      pathManager.removeBookmark(envelope.payload.pathId);
    },
  );

  handleCommand(
    COMMAND_CHANNELS.BOOKMARK_RENAME,
    (_e, envelope: CommandEnvelope<RenameBookmarkPayload>): void => {
      pathManager.renameBookmark(envelope.payload.pathId, envelope.payload.newDisplayName);
    },
  );

  handleCommand(
    COMMAND_CHANNELS.BOOKMARK_REORDER,
    (_e, envelope: CommandEnvelope<ReorderBookmarksPayload>): void => {
      pathManager.reorderBookmarks(envelope.payload.orderedPathIds);
    },
  );

  handleCommand(
    COMMAND_CHANNELS.BOOKMARK_SET_DEFAULT_TEMPLATE,
    (
      _e,
      envelope: CommandEnvelope<SetDefaultTemplateForBookmarkPayload>,
    ): void => {
      pathManager.setDefaultTemplate(
        envelope.payload.pathId,
        envelope.payload.templateId,
      );
    },
  );

  handleCommand(
    COMMAND_CHANNELS.BOOKMARK_PICK_FOLDER,
    async (
      _e,
      envelope: CommandEnvelope<PickFolderPayload>,
    ): Promise<PickFolderResponse> => {
      const fromWindow = BrowserWindow.fromWebContents(_e.sender);
      const result = await dialog.showOpenDialog(fromWindow ?? BrowserWindow.getFocusedWindow()!, {
        title: '选择文件夹',
        properties: ['openDirectory'],
        ...(envelope.payload.defaultPath ? { defaultPath: envelope.payload.defaultPath } : {}),
      });
      if (result.canceled || result.filePaths.length === 0) {
        return { path: null };
      }
      return { path: result.filePaths[0]! };
    },
  );

  handleCommand(
    COMMAND_CHANNELS.PATH_REMOVE_FROM_RECENT,
    (_e, envelope: CommandEnvelope<RemoveFromRecentPayload>): void => {
      pathManager.removeFromRecent(envelope.payload.path);
    },
  );

  // SSH profiles / remote bookmarks
  handleCommand(
    COMMAND_CHANNELS.SSH_PROFILE_LIST,
    (_e, _envelope: CommandEnvelope<undefined>): ListSshProfilesResponse => {
      return { profiles: sshProfileManager?.list() ?? [] };
    },
  );

  handleCommand(
    COMMAND_CHANNELS.SSH_PROFILE_ADD,
    (_e, envelope: CommandEnvelope<AddSshProfilePayload>): AddSshProfileResponse => {
      if (!sshProfileManager) {
        throw makeIpcError('SshProfileUnavailable', 'SSH profile manager 未初始化');
      }
      const { password, ...rest } = envelope.payload;
      const addInput: Omit<typeof rest, never> & { passwordEncrypted?: string } = { ...rest };
      if (typeof password === 'string' && password.length > 0) {
        addInput.passwordEncrypted = encryptPasswordOrThrow(password);
      }
      const profile = sshProfileManager.add(addInput);
      return { profile };
    },
  );

  handleCommand(
    COMMAND_CHANNELS.SSH_PROFILE_UPDATE,
    (_e, envelope: CommandEnvelope<UpdateSshProfilePayload>): UpdateSshProfileResponse => {
      if (!sshProfileManager) {
        throw makeIpcError('SshProfileUnavailable', 'SSH profile manager 未初始化');
      }
      const { password, ...partialRest } = envelope.payload.partial;
      const partial: typeof partialRest & { passwordEncrypted?: string } = { ...partialRest };
      if (typeof password === 'string') {
        // '' 表示清除已保存密码;非空字符串则加密落盘。
        partial.passwordEncrypted = password.length > 0 ? encryptPasswordOrThrow(password) : '';
      }
      const profile = sshProfileManager.update(envelope.payload.id, partial);
      return { profile };
    },
  );

  handleCommand(
    COMMAND_CHANNELS.SSH_PROFILE_PICK_KEY_FILE,
    async (
      _e,
      envelope: CommandEnvelope<PickSshKeyFilePayload>,
    ): Promise<PickSshKeyFileResponse> => {
      const fromWindow = BrowserWindow.fromWebContents(_e.sender);
      const result = await dialog.showOpenDialog(
        fromWindow ?? BrowserWindow.getFocusedWindow()!,
        {
          title: '选择 SSH 私钥文件',
          properties: ['openFile', 'showHiddenFiles'],
          ...(envelope.payload.defaultPath
            ? { defaultPath: envelope.payload.defaultPath }
            : {}),
        },
      );
      if (result.canceled || result.filePaths.length === 0) {
        return { path: null };
      }
      return { path: result.filePaths[0]! };
    },
  );

  handleCommand(
    COMMAND_CHANNELS.SSH_PROFILE_DELETE,
    (_e, envelope: CommandEnvelope<DeleteSshProfilePayload>): void => {
      if (!sshProfileManager) {
        throw makeIpcError('SshProfileUnavailable', 'SSH profile manager 未初始化');
      }
      if (pathManager.hasSshProfileReferences(envelope.payload.id)) {
        throw makeIpcError(
          'SshProfileInUse',
          '该 SSH 服务器仍被收藏 / 最近 / 运行中的会话引用,请先移除这些远程路径。',
        );
      }
      sshProfileManager.delete(envelope.payload.id);
    },
  );

  handleCommand(
    COMMAND_CHANNELS.SSH_PROFILE_TEST,
    async (
      _e,
      envelope: CommandEnvelope<TestSshProfilePayload>,
    ): Promise<TestSshProfileResponse> => {
      const profile = sshProfileManager?.get(envelope.payload.id);
      if (!profile) return { ok: false, message: 'SSH 配置不存在' };
      // MVP:不主动建立后台连接,避免无交互密码/host key prompt 卡死。
      // 真正连接由 session 启动时的 ssh CLI 处理;这里做可执行输入校验。
      return {
        ok: true,
        message: `${profile.username}@${profile.host}:${profile.port}`,
      };
    },
  );

  handleCommand(
    COMMAND_CHANNELS.REMOTE_BOOKMARK_ADD,
    (_e, envelope: CommandEnvelope<AddRemoteBookmarkPayload>): AddBookmarkResponse => {
      const profile = sshProfileManager?.get(envelope.payload.sshProfileId);
      if (!profile) {
        throw makeIpcError(
          'SshProfileNotFound',
          `sshProfileId="${envelope.payload.sshProfileId}"`,
        );
      }
      const bookmark = pathManager.addBookmark({
        kind: 'ssh',
        sshProfileId: profile.id,
        path: envelope.payload.remotePath,
        ...(envelope.payload.displayName ? { displayName: envelope.payload.displayName } : {}),
        ...(envelope.payload.defaultTemplateId
          ? { defaultTemplateId: envelope.payload.defaultTemplateId }
          : {}),
      });
      return { bookmark };
    },
  );

  // SSH 方案 §阶段 2.1:ssh_config 集成 — 只在 advanced.includeSshConfig 开
  // 时读 ~/.ssh/config。关时返回 enabled=false + entries=[],renderer 自动
  // 不渲染 ssh_config 区。
  handleCommand(
    COMMAND_CHANNELS.SSH_CONFIG_LIST,
    (_e, _envelope: CommandEnvelope<undefined>): SshConfigListResponse => {
      const enabled = settingsManager.get().advanced.includeSshConfig === true;
      if (!enabled) return { enabled: false, entries: [] };
      const entries = parseSshConfig().map((e) => ({
        alias: e.alias,
        hostName: e.hostName,
        ...(e.user ? { user: e.user } : {}),
        port: e.port,
        identityFiles: e.identityFiles,
        proxyJump: e.proxyJump,
        sourceFile: e.sourceFile,
      }));
      return { enabled: true, entries };
    },
  );

  // SSH 方案 §阶段 2.2:同步探测 ssh-agent。耗时 ~100ms 以内,不进 worker。
  handleCommand(
    COMMAND_CHANNELS.SSH_AGENT_STATUS,
    (_e, _envelope: CommandEnvelope<undefined>): SshAgentStatusResponse => {
      const r = detectSshAgent();
      if (r.status === 'agent-running') {
        return { status: 'agent-running', keys: r.keys };
      }
      return { status: 'agent-missing', reason: r.reason, message: r.message };
    },
  );

  // SSH 方案 §阶段 3.1:列 ~/.ssh/known_hosts 并 diff history。
  // knownHostsManager 不在 deps 时返回空,避免 renderer 出错。
  handleCommand(
    COMMAND_CHANNELS.KNOWN_HOSTS_REFRESH,
    (_e, _envelope: CommandEnvelope<undefined>): KnownHostsRefreshResponse => {
      if (!knownHostsManager) return { entries: [], changes: [] };
      const r = knownHostsManager.refresh();
      return {
        entries: r.entries.map((e) => ({
          hosts: e.hosts,
          keyType: e.keyType,
          fingerprint: e.fingerprint,
          sourceFile: e.sourceFile,
          isHashed: e.isHashed,
        })),
        changes: r.changes,
      };
    },
  );

  // Settings
  handleCommand(
    COMMAND_CHANNELS.SETTINGS_GET,
    (_e, _envelope: CommandEnvelope<undefined>): GetSettingsResponse => {
      return { settings: settingsManager.get() };
    },
  );

  handleCommand(
    COMMAND_CHANNELS.SETTINGS_UPDATE,
    (_e, envelope: CommandEnvelope<UpdateSettingsPayload>): void => {
      settingsManager.update(envelope.payload.partial);
    },
  );

  handleCommand(
    COMMAND_CHANNELS.SETTINGS_RESET,
    (_e, _envelope: CommandEnvelope<undefined>): void => {
      settingsManager.reset();
    },
  );

  handleCommand(
    COMMAND_CHANNELS.SETTINGS_LIST_SHELLS,
    async (_e, _envelope: CommandEnvelope<undefined>): Promise<ListShellsResponse> => {
      const shells = await sessionManager.listAvailableShells();
      return {
        shells: shells.map((s) => ({
          id: s.id,
          displayName: s.displayName,
          executablePath: s.executablePath,
        })),
      };
    },
  );

  handleCommand(
    COMMAND_CHANNELS.SETTINGS_GET_AUTO_START,
    (_e, _envelope: CommandEnvelope<undefined>): GetAutoStartResponse => {
      // Electron 跨平台 API,Windows 上读 Run 注册表
      return { enabled: app.getLoginItemSettings().openAtLogin };
    },
  );

  // System
  handleCommand(
    COMMAND_CHANNELS.SYSTEM_SHOW_IN_EXPLORER,
    async (
      _e,
      envelope: CommandEnvelope<ShowInExplorerPayload>,
    ): Promise<void> => {
      shell.showItemInFolder(envelope.payload.path);
    },
  );

  handleCommand(
    COMMAND_CHANNELS.FS_LIST_DIR,
    async (_e, envelope: CommandEnvelope<ListDirPayload>): Promise<ListDirResponse> => {
      const { path, sshProfileId, fresh } = envelope.payload;
      if (!sshProfileId) return listDirectory(path);
      return deps.sftpPool
        ? deps.sftpPool.list(sshProfileId, path, fresh)
        : { ok: false, reason: 'no-client' };
    },
  );

  handleCommand(
    COMMAND_CHANNELS.FS_READ_PDF,
    async (_e, envelope: CommandEnvelope<ReadPdfPayload>): Promise<ReadPdfResponse> => {
      const { path, sshProfileId, offset } = envelope.payload;
      if (!sshProfileId) return readPdfChunk(path, offset);
      return deps.sftpPool
        ? readRemotePdfChunk(deps.sftpPool, sshProfileId, path, offset)
        : { ok: false, reason: 'no-client' };
    },
  );

  handleCommand(
    COMMAND_CHANNELS.FS_RENAME,
    (_e, envelope: CommandEnvelope<RenameEntryPayload>): Promise<RenameEntryResponse> =>
      renameEntry(envelope.payload.path, envelope.payload.newName),
  );

  handleCommand(
    COMMAND_CHANNELS.SYSTEM_OPEN_DATA_DIR,
    async (_e, _envelope: CommandEnvelope<undefined>): Promise<void> => {
      // app.getPath('userData') = %APPDATA%\Ceteris
      await shell.openPath(app.getPath('userData'));
    },
  );

  handleCommand(
    COMMAND_CHANNELS.SYSTEM_OPEN_LOGS_DIR,
    async (_e, _envelope: CommandEnvelope<undefined>): Promise<void> => {
      // logs 目录:%APPDATA%\Ceteris\logs (M1-D 起 logger.ts 实际会写;空目录也可打开)
      // 还没接通日志框架,但目录能打开,空就空)。
      const logsDir = joinPath(app.getPath('userData'), 'logs');
      try {
        await fs.mkdir(logsDir, { recursive: true });
      } catch {
        /* 已存在或创建失败都直接尝试打开,反正用户能看到 */
      }
      await shell.openPath(logsDir);
    },
  );

  handleCommand(
    COMMAND_CHANNELS.SYSTEM_GET_BUILD_TYPE,
    (_e, _envelope: CommandEnvelope<undefined>) => {
      return { buildType: getBuildType() };
    },
  );

  handleCommand(
    COMMAND_CHANNELS.SYSTEM_GET_DATA_DIR,
    (_e, _envelope: CommandEnvelope<undefined>): { dataDir: string } => {
      // BETA-039:UI 设置页用真实绝对路径替代硬编码 %APPDATA%\Ceteris,
      // 在 portable / dev / 自定义 userData 场景下也保持准确。
      return { dataDir: app.getPath('userData') };
    },
  );

  // Not local-only on purpose: a remote view sends this to the Host, whose settings
  // hold the key, so the laptop needs no key of its own.
  handleCommand(
    COMMAND_CHANNELS.AI_SUGGEST_NEXT_PROMPT,
    async (
      _e,
      envelope: CommandEnvelope<SuggestNextPromptPayload>,
    ): Promise<SuggestNextPromptResponse> => {
      const config = settingsManager.get().ai.nextPrompt;
      return { suggestion: await suggestNextPrompt(config, envelope.payload.screen) };
    },
  );

  handleCommand(
    COMMAND_CHANNELS.AI_TEST_CONNECTION,
    async (_e, _envelope: CommandEnvelope<undefined>) => {
      // BETA-031:AI 助手设置页"测试连接"按钮调用。失败信息透传 UI。
      if (!aiClient) return { ok: false, message: 'AI client 未初始化' };
      return aiClient.testConnection();
    },
  );

  // IME-1 探针 dump — renderer 端 ring buffer 触发 LEAK 时一次性送过来。
  // 不依赖 DevTools 打开,事后可通过 `cmd:system:open-logs-dir` 按钮直达
  // `%APPDATA%/Ceteris/logs/ime-YYYY-MM-DD.log` 查看。
  // 设计:无 throw、无大规模 stringify(已在 logger.format 内做 JSON.stringify
  // 兜底),让 renderer 的 fire-and-forget 调用永不影响主链路。
  handleCommand(
    COMMAND_CHANNELS.LOGGER_IME_DUMP,
    (
      _e,
      envelope: CommandEnvelope<ImeProbeDumpPayload>,
    ): ImeProbeDumpResponse => {
      const { meta, entries } = envelope.payload;
      logger.ime(
        'ime-probe',
        `leak dump session=${meta.sessionId} t=${meta.t} entries=${entries.length}`,
        { meta, entries },
      );
      return { ok: true };
    },
  );

  // Explorer 集成 —— 不读 settings,现场查 + 操作系统状态
  handleCommand(
    COMMAND_CHANNELS.EXPLORER_INTEGRATION_GET_STATUS,
    async (_e, _envelope: CommandEnvelope<undefined>) => {
      return await getExplorerIntegrationStatus();
    },
  );

  handleCommand(
    COMMAND_CHANNELS.EXPLORER_INTEGRATION_SET_CLASSIC,
    async (
      _e,
      envelope: CommandEnvelope<{ enabled: boolean }>,
    ) => {
      const result = await setClassicIntegration(
        envelope.payload.enabled,
        app.getPath('exe'),
      );
      const status = await getExplorerIntegrationStatus();
      return { ok: result.ok, message: result.message, status };
    },
  );

  handleCommand(
    COMMAND_CHANNELS.EXPLORER_INTEGRATION_SET_MODERN,
    async (
      _e,
      envelope: CommandEnvelope<{ enabled: boolean }>,
    ) => {
      const result = await setModernIntegration(envelope.payload.enabled);
      const status = await getExplorerIntegrationStatus();
      return { ok: result.ok, message: result.message, status };
    },
  );

  handleCommand(
    COMMAND_CHANNELS.EXPLORER_INTEGRATION_GET_PS_COMMANDS,
    (_e, _envelope: CommandEnvelope<undefined>) => {
      return getPsCommands(app.getPath('exe'));
    },
  );

  handleCommand(
    COMMAND_CHANNELS.SYSTEM_OPEN_EXTERNAL,
    async (
      _e,
      envelope: CommandEnvelope<OpenExternalPayload>,
    ): Promise<void> => {
      const url = envelope.payload.url;
      // 安全:仅允许 http / https / mailto,拒绝 file:// 等本地协议
      if (!/^(https?|mailto):/i.test(url)) {
        throw makeIpcError('InvalidUrl', `不允许的 URL 协议: "${url}"`);
      }
      await shell.openExternal(url);
    },
  );

  // 勘误第二轮:剪贴板 — main 端直接调 Electron clipboard。
  // 不走 navigator.clipboard.* (web Permission API 拒掉 clipboard-write,
  // 表现为选中即复制 / Ctrl+Shift+C / 右键粘贴全部静默失败,见 prelease 前
  // 勘误第二轮工作记录)。Electron clipboard 模块没有权限层。
  handleCommand(
    COMMAND_CHANNELS.SYSTEM_CLIPBOARD_READ_TEXT,
    (
      _e,
      _envelope: CommandEnvelope<undefined>,
    ): ClipboardReadTextResponse => {
      try {
        return { text: clipboard.readText() };
      } catch {
        return { text: '' };
      }
    },
  );

  handleCommand(
    COMMAND_CHANNELS.SYSTEM_CLIPBOARD_WRITE_TEXT,
    (
      _e,
      envelope: CommandEnvelope<ClipboardWriteTextPayload>,
    ): ClipboardWriteTextResponse => {
      try {
        clipboard.writeText(envelope.payload.text);
        return { ok: true };
      } catch {
        return { ok: false };
      }
    },
  );

  // Templates CRUD (CP-4 chunk 4)
  handleCommand(
    COMMAND_CHANNELS.TEMPLATE_ADD,
    (_e, envelope: CommandEnvelope<AddTemplatePayload>): AddTemplateResponse => {
      const t = templatesManager.add(envelope.payload);
      return { template: t };
    },
  );

  handleCommand(
    COMMAND_CHANNELS.TEMPLATE_UPDATE,
    (
      _e,
      envelope: CommandEnvelope<UpdateTemplatePayload>,
    ): UpdateTemplateResponse => {
      const t = templatesManager.update(envelope.payload.id, envelope.payload.partial);
      return { template: t };
    },
  );

  handleCommand(
    COMMAND_CHANNELS.TEMPLATE_DELETE,
    (_e, envelope: CommandEnvelope<DeleteTemplatePayload>): void => {
      templatesManager.delete(envelope.payload.id);
    },
  );

  handleCommand(
    COMMAND_CHANNELS.TEMPLATE_SET_DEFAULT,
    (_e, envelope: CommandEnvelope<SetDefaultTemplatePayload>): void => {
      templatesManager.setDefault(envelope.payload.id);
    },
  );

  // Settings export / import (CP-4 chunk 4)
  //
  // V1 折衷:导出/导入用单 JSON 文件而非 zip,避免引入 zip 库依赖。
  // 文档 6.6.2 描述为 zip,未来加 archiver 包可平滑升级。
  handleCommand(
    COMMAND_CHANNELS.SETTINGS_EXPORT,
    async (
      _e,
      _envelope: CommandEnvelope<undefined>,
    ): Promise<ExportSettingsResponse> => {
      const fromWindow = BrowserWindow.fromWebContents(_e.sender);
      const owner = fromWindow ?? BrowserWindow.getFocusedWindow()!;

      // M1-F:先弹隐私警告 — 模板可能含 API key (env);用户三选一:
      // 取消 / 仅导出公开字段(env 清空) / 完整导出(含敏感凭据)
      const tmpls = deps.templatesManager.list();
      const hasEnvKeys = tmpls.some(
        (t) => t.env && Object.keys(t.env).length > 0,
      );
      let includeSecrets = false;
      if (hasEnvKeys) {
        const askRes = await dialog.showMessageBox(owner, {
          type: 'warning',
          title: '导出敏感凭据?',
          message: '归档将包含启动模板里的环境变量,可能含 API key、token 等敏感凭据。',
          detail:
            '"仅公开字段":导出时清空所有模板的环境变量,适合分享。\n' +
            '"包含敏感凭据":完整导出,只在你信任的设备间转移时再用。',
          buttons: ['取消', '仅公开字段', '包含敏感凭据'],
          defaultId: 1,
          cancelId: 0,
        });
        if (askRes.response === 0) return { filePath: null };
        includeSecrets = askRes.response === 2;
      } else {
        // 无敏感字段时不打扰
        includeSecrets = true;
      }

      const suffix = hasEnvKeys
        ? includeSecrets
          ? '-with-secrets'
          : '-public'
        : '';
      const result = await dialog.showSaveDialog(owner, {
        title: '导出 Ceteris 配置',
        defaultPath: `ceteris-config-${formatDateForFilename(new Date())}${suffix}.json`,
        filters: [{ name: 'Ceteris Archive (JSON)', extensions: ['json'] }],
      });
      if (result.canceled || !result.filePath) {
        return { filePath: null };
      }
      const archive = await buildArchive(deps);
      if (!includeSecrets) {
        // 清空所有模板的 env(M1-F 公开模式)
        for (const t of archive.templates.templates) {
          t.env = {};
        }
      }
      await fs.writeFile(result.filePath, JSON.stringify(archive, null, 2), 'utf-8');
      return { filePath: result.filePath };
    },
  );

  const parentWindow = (e: IpcMainInvokeEvent): BrowserWindow =>
    (BrowserWindow.fromWebContents(e.sender) ?? BrowserWindow.getFocusedWindow())!;

  handleCommand(
    COMMAND_CHANNELS.DATA_MEASURE_AGENTS,
    async (): Promise<{ claude: DataAgentStats; codex: DataAgentStats }> => {
      const home = homedir();
      return {
        claude: await measureAgentChats(home, 'claude'),
        codex: await measureAgentChats(home, 'codex'),
      };
    },
  );

  handleCommand(
    COMMAND_CHANNELS.DATA_EXPORT_BUNDLE,
    async (e, envelope: CommandEnvelope<DataExportPayload>): Promise<DataExportResponse> => {
      const picked = await dialog.showOpenDialog(parentWindow(e), {
        title: '选择导出位置',
        properties: ['openDirectory', 'createDirectory'],
      });
      const parent = picked.filePaths[0];
      if (picked.canceled || !parent) return { dir: null, tabs: 0 };

      const tabs = sessionManager
        .list()
        .filter((s) => s.state !== 'exited' && pathRefFromId(s.pathId).kind !== 'ssh')
        .map((s) => ({
          pathId: s.pathId,
          templateId: s.templateId,
          displayName: s.displayName,
          currentCwd: s.currentCwd ?? null,
          agent: detectAgent(s.templateId, sessionManager.getScreenTail(s.id, 40)),
        }));
      const dir = joinPath(parent, `Ceteris-Export-${formatDateForFilename(new Date())}`);
      const { claude, codex } = envelope.payload;
      const manifest = await writeBundle({
        dir,
        home: homedir(),
        hostname: hostname(),
        now: Date.now(),
        archive: await buildArchive(deps),
        tabs,
        agents: [...(claude ? (['claude'] as const) : []), ...(codex ? (['codex'] as const) : [])],
      });
      return { dir, tabs: tabs.length, ...manifest.agents };
    },
  );

  handleCommand(
    COMMAND_CHANNELS.DATA_PICK_BUNDLE,
    async (e): Promise<DataBundleSummary | null> => {
      const picked = await dialog.showOpenDialog(parentWindow(e), {
        title: '选择 Ceteris 导出文件夹',
        properties: ['openDirectory'],
      });
      const dir = picked.filePaths[0];
      if (picked.canceled || !dir) return null;
      const manifest = await readManifest(dir);
      return {
        dir,
        hostname: manifest.hostname,
        createdAt: manifest.createdAt,
        tabs: manifest.tabs,
        ...manifest.agents,
      };
    },
  );

  handleCommand(
    COMMAND_CHANNELS.DATA_IMPORT_BUNDLE,
    async (_e, envelope: CommandEnvelope<DataImportPayload>): Promise<DataImportResponse> => {
      const { dir } = envelope.payload;
      const home = homedir();
      const manifest = await readManifest(dir);
      const archive = withLocalSecrets(await readArchive(dir), deps.settingsManager.get());
      await applyArchiveInMemory(deps, archive);
      const agents = await importAgents(dir, home, manifest);
      const { tabs, missing } = await readTabs(dir, home, manifest.home);
      return { ...agents, tabs, missingTabs: missing };
    },
  );

  handleCommand(
    COMMAND_CHANNELS.SETTINGS_IMPORT,
    async (
      _e,
      _envelope: CommandEnvelope<undefined>,
    ): Promise<ImportSettingsResponse> => {
      const fromWindow = BrowserWindow.fromWebContents(_e.sender);
      const result = await dialog.showOpenDialog(
        fromWindow ?? BrowserWindow.getFocusedWindow()!,
        {
          title: '导入 Ceteris 配置',
          properties: ['openFile'],
          filters: [{ name: 'Ceteris Archive (JSON)', extensions: ['json'] }],
        },
      );
      if (result.canceled || result.filePaths.length === 0) {
        return { status: 'cancelled' };
      }
      const filePath = result.filePaths[0]!;
      let archive: SettingsArchiveV1;
      try {
        const raw = await fs.readFile(filePath, 'utf-8');
        archive = JSON.parse(raw) as SettingsArchiveV1;
        validateArchive(archive);
      } catch (err) {
        return {
          status: 'error',
          errorMessage: err instanceof Error ? err.message : String(err),
        };
      }
      // 二次确认 — 不再重启应用 (CP-4 勘误 #12)。
      const confirmRes = await dialog.showMessageBox(
        fromWindow ?? BrowserWindow.getFocusedWindow()!,
        {
          type: 'warning',
          title: '确认导入',
          message: '导入将完全覆盖现有配置(收藏 / 最近 / 模板 / 设置)。',
          detail: '运行中的终端不会被关,继续后所有窗口立即看到新配置。是否继续?',
          buttons: ['取消', '继续导入'],
          defaultId: 0,
          cancelId: 0,
        },
      );
      if (confirmRes.response !== 1) {
        return { status: 'cancelled' };
      }
      try {
        await applyArchiveInMemory(deps, archive);
      } catch (err) {
        return {
          status: 'error',
          errorMessage: err instanceof Error ? err.message : String(err),
        };
      }
      return { status: 'imported' };
    },
  );

  // ────────────────────────────────────────────────────────────────
  // Ceteris Link(远程挂载)
  //
  // 这些命令全部操作**本机**的 Link 配置,已列入 LINK_LOCAL_ONLY_CHANNELS,
  // 因此即使在远程窗口里调用也不会被转发出去。
  // ────────────────────────────────────────────────────────────────

  handleCommand(
    COMMAND_CHANNELS.LINK_GET_STATUS,
    (): LinkStatusResponse => {
      const lm = deps.linkManager;
      if (!lm) {
        return {
          host: { listening: false, boundAddress: '', port: 0, lastError: '', clients: [] },
          clients: [],
        };
      }
      return { host: lm.getHostStatus(), clients: lm.getClientStatuses() };
    },
  );

  handleCommand(
    COMMAND_CHANNELS.LINK_REGENERATE_TOKEN,
    (): LinkRegenerateTokenResponse => {
      const token = generateLinkToken();
      // 立即写进 settings。旧 token 从这一刻起失效:已建立的连接因为用的是
      // 早先派生的会话密钥,不会立刻掉线,但它们重连时会被拒 —— 这正是
      // "重新生成令牌"应有的语义(踢掉未来的访问,不粗暴打断当前会话)。
      settingsManager.update({ link: { hostToken: token } });
      return { token };
    },
  );

  handleCommand(
    COMMAND_CHANNELS.LINK_CONNECT,
    (_e, envelope: CommandEnvelope<LinkConnectPayload>): LinkConnectResponse => {
      const lm = requireLinkManager(deps);
      const p = envelope.payload;
      if (!p.host || !p.token) {
        throw new Error(
          '[ipc] cmd:link:connect: host 与 token 都不能为空。' +
            'token 需要与目标机器"设置 → 远程访问"里显示的访问令牌逐字符相同。',
        );
      }
      return {
        linkId: lm.connectTo(
          {
            label: p.label || p.host,
            host: p.host,
            port: p.port,
            token: p.token,
          },
          { reveal: true },
        ),
      };
    },
  );

  handleCommand(
    COMMAND_CHANNELS.LINK_DISCONNECT,
    (_e, envelope: CommandEnvelope<LinkDisconnectPayload>): void => {
      requireLinkManager(deps).disconnect(envelope.payload.linkId);
    },
  );

  handleCommand(
    COMMAND_CHANNELS.LINK_KICK_CLIENT,
    (_e, envelope: CommandEnvelope<LinkKickClientPayload>): void => {
      requireLinkManager(deps).disconnectHostClient(envelope.payload.virtualWindowId);
    },
  );

  handleCommand(
    COMMAND_CHANNELS.LINK_LIST_BIND_CANDIDATES,
    (): LinkListBindCandidatesResponse => ({ candidates: listBindCandidates() }),
  );

  handleCommand(
    COMMAND_CHANNELS.LINK_GET_WINDOW_STATE,
    (_e, envelope: CommandEnvelope<undefined>): LinkConnectionStatePayload | null =>
      deps.linkManager?.getWindowConnectionState(envelope.windowId) ?? null,
  );

  handleCommand(
    COMMAND_CHANNELS.VIEW_GET_STATE,
    (_e, envelope: CommandEnvelope<undefined>): ViewStateResponse =>
      deps.viewSwitcher?.getState(envelope.windowId) ?? { targets: [] },
  );

  handleCommand(
    COMMAND_CHANNELS.VIEW_SWITCH,
    (_e, envelope: CommandEnvelope<ViewSwitchPayload>): void => {
      deps.viewSwitcher?.switchTo(envelope.windowId, envelope.payload.targetId);
    },
  );

  handleCommand(
    COMMAND_CHANNELS.LINK_ACK_UNCONFIRMED,
    (_e, envelope: CommandEnvelope<undefined>): void => {
      deps.linkManager?.acknowledgeUnconfirmed(envelope.windowId);
    },
  );
}

/**
 * 取 LinkManager,未注入时抛一条用户看得懂的错。
 *
 * LinkManager 是可选依赖(测试里的 IpcLayerDeps 不带它),所以每个用到它的
 * handler 都需要这一步。抛错而不是静默返回,是因为用户点了"连接"按钮却
 * 什么都没发生比一条错误提示更难排查。
 */
function requireLinkManager(deps: IpcLayerDeps): LinkManager {
  if (!deps.linkManager) {
    throw new Error(
      '[ipc] Ceteris Link 未初始化。可能原因:主进程启动时 LinkManager 构造失败。' +
        '建议:查看日志目录下 main.log 里 LinkManager / LinkServer 的错误。',
    );
  }
  return deps.linkManager;
}

function formatDateForFilename(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}` +
    `${pad(d.getMonth() + 1)}` +
    `${pad(d.getDate())}-` +
    `${pad(d.getHours())}` +
    `${pad(d.getMinutes())}`
  );
}

async function buildArchive(deps: IpcLayerDeps): Promise<SettingsArchiveV1> {
  const dataDir = app.getPath('userData');
  const readJson = async <T>(filename: string, fallback: T): Promise<T> => {
    try {
      const raw = await fs.readFile(joinPath(dataDir, filename), 'utf-8');
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  };
  // 强制先 flush,以保证读盘时拿到最新写入
  await flushAllStores(deps);
  // Ceteris Link:导出的归档里剥掉远程访问凭据。
  //
  // 理由:归档的典型用途是"发给别人"或"备份到网盘",而 link.hostToken 等价于
  // 这台机器上所有终端的完全访问权,savedHosts[].token 则是别人机器的访问权。
  // 把它们打进归档,一次善意的配置分享就变成了一次凭据泄露。
  //
  // 导入方看到的是空 token:Host 开关会因为 validateLinkSettings 的规则保持
  // 关闭状态,用户需要重新生成 —— 这正是我们想要的默认行为。
  const settings = deps.settingsManager.get();
  //
  // hostEnabled 必须一并置 false:validateLinkSettings 禁止 "开启但无 token",
  // 若只清 token 不关开关,导入方会因为归档自相矛盾而整个导入失败。
  settings.link = {
    ...settings.link,
    hostEnabled: false,
    hostToken: '',
    savedHosts: settings.link.savedHosts.map((h) => ({ ...h, token: '' })),
  };
  const bookmarks = await readJson<{ paths: unknown[] }>('bookmarks.json', { paths: [] });
  const recent = await readJson<{ paths: unknown[] }>('recent.json', { paths: [] });
  const templates = {
    defaultTemplateId: deps.templatesManager.getDefaultTemplateId(),
    templates: deps.templatesManager.list(),
  };
  return {
    // v1.5 起统一用 'ceteris-archive';读侧同时接受 'easyterm-archive' 旧值(向后兼容)。
    format: 'ceteris-archive',
    version: 1,
    exportedAt: Date.now(),
    exportedFrom: app.getVersion(),
    settings,
    // 类型断言:JSON 上读出来已经是合法 schema (持久化文件不通过 IPC 不需要严格 schema 校验)
    bookmarks: bookmarks as SettingsArchiveV1['bookmarks'],
    recent: recent as SettingsArchiveV1['recent'],
    sshProfiles: { profiles: deps.sshProfileManager?.list() ?? [] },
    templates,
  };
}

function validateArchive(input: unknown): asserts input is SettingsArchiveV1 {
  // 接受新名 'ceteris-archive' 和旧名 'easyterm-archive'(v1.5 改名前的归档)。
  // 都是同一 schema,只是 format 标签不同。
  const fmt = (input as SettingsArchiveV1 | null)?.format;
  if (
    !input ||
    typeof input !== 'object' ||
    (fmt !== 'ceteris-archive' && fmt !== 'easyterm-archive') ||
    (input as SettingsArchiveV1).version !== 1
  ) {
    throw new Error(
      '不是合法的归档:format/version 不匹配 (期望 ceteris-archive v1,旧 easyterm-archive v1 也接受)',
    );
  }
  const i = input as SettingsArchiveV1;
  if (!i.settings || !i.bookmarks?.paths || !i.recent?.paths || !i.templates?.templates) {
    throw new Error('归档缺少必需字段 (settings / bookmarks / recent / templates)');
  }
}

/**
 * CP-4 勘误 #12:不再 fs.writeFile + app.relaunch (dev 模式下 relaunch 与
 * Vite HMR daemon 协作不稳,导致用户看到"导入后无法正常渲染")。改成走每个
 * Manager 暴露的 replaceAll() 方法 — 内存替换 + JsonStore 持久化 + emit 事件
 * → 所有窗口通过 evt:settings:changed / evt:templates:updated /
 *   evt:path:tree-updated / evt:bookmarks:updated 实时刷新 UI。
 *
 * 优点:
 * - 不重启应用,运行中的 PTY session 不被关 (符合软件定义书"窗口零成本开关",
 *   而 session 持久化是设计上不允许的,所以 import 不应当杀已活的 session)
 * - 不依赖 app.relaunch 在 dev 模式工作
 * - settings.appearance.theme 等"即改即生效"路径自然走通
 */
async function applyArchiveInMemory(
  deps: IpcLayerDeps,
  archive: SettingsArchiveV1,
): Promise<void> {
  // M1-L:事务化 — 先 dry-run validate(都走各 Manager 的 validate),全部通过
  // 才正式 commit。否则中途 settings 已替换但 templates 失败,会出现一边新
  // 一边旧的"半应用"状态。
  //
  // Manager 暴露的 replaceAll 已经内置 validate;无法在不 commit 的前提下
  // 单独 validate(它们直接 emit)。折衷:用 validateSettings / validateTemplate
  // 等独立函数预检 — 但 PathManager 没有公开 validate,bookmarks/recent 的
  // 校验在 IPC 层做(原 archive validateArchive 已确认 schema)。
  //
  // 风险层面:即使分步 commit,失败也只是中间状态可见(reducer 已 emit),
  // 用户看到的是部分应用而不是数据损坏 — 重新导入或重置即可恢复。所以
  // 这一层事务化主要是"日志清楚 + 错误信息能定位失败点",而不是真原子。

  // 1) settings replaceAll(包含 deepMerge + validate)
  try {
    deps.settingsManager.replaceAll(archive.settings);
  } catch (err) {
    throw new Error(`settings: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 2) templates replaceAll(mergeBuiltins + 自带校验)
  try {
    deps.templatesManager.replaceAll({
      defaultTemplateId: archive.templates.defaultTemplateId,
      templates: archive.templates.templates,
    });
  } catch (err) {
    throw new Error(`templates: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 3) bookmarks + recent
  try {
    deps.pathManager.replaceAll({
      bookmarks: archive.bookmarks.paths,
      recent: archive.recent.paths,
    });
  } catch (err) {
    throw new Error(`paths: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (archive.sshProfiles?.profiles && deps.sshProfileManager) {
    try {
      deps.sshProfileManager.replaceAll(archive.sshProfiles.profiles);
    } catch (err) {
      throw new Error(`sshProfiles: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 等待所有 store debounce 落盘
  await flushAllStores(deps);
}

async function flushAllStores(deps: IpcLayerDeps): Promise<void> {
  await Promise.all([
    deps.settingsManager.flush(),
    deps.pathManager.flush(),
    deps.sshProfileManager?.flush() ?? Promise.resolve(),
    deps.templatesManager.flush(),
  ]);
}

// ──────────────────────────────────────────────────────────────────
// 事件桥接
// ──────────────────────────────────────────────────────────────────

function wireEventBroadcasts(deps: IpcLayerDeps): void {
  const {
    windowManager,
    pathManager,
    settingsManager,
    sessionManager,
    sshProfileManager,
    templatesManager,
  } = deps;

  // Path 树变化 → 广播 evt:path:tree-updated
  pathManager.on('pathTreeUpdated', () => {
    const tree = pathManager.getTree();
    broadcastEvent<PathTreeUpdatedPayload>(EVENT_CHANNELS.PATH_TREE_UPDATED, { tree });
    broadcastAppState(deps);
  });

  pathManager.on('bookmarksUpdated', () => {
    broadcastEvent<BookmarksUpdatedPayload>(EVENT_CHANNELS.BOOKMARKS_UPDATED, {
      bookmarks: pathManager.listBookmarks(),
    });
  });

  sshProfileManager?.on('sshProfilesUpdated', (e: SshProfilesUpdatedPayload) => {
    broadcastEvent<SshProfilesUpdatedPayload>(
      EVENT_CHANNELS.SSH_PROFILES_UPDATED,
      e,
    );
  });

  // 设置变化 → 广播 evt:settings:changed
  settingsManager.on(
    'settingsChanged',
    (e: { settings: Settings; changedKeys: string[] }) => {
      broadcastEvent<SettingsChangedPayload>(EVENT_CHANNELS.SETTINGS_CHANGED, {
        settings: e.settings,
        changedKeys: e.changedKeys,
      });
      if (e.changedKeys.includes('appearance.theme')) {
        void syncThemeToRemoteWindows(e.settings.appearance.theme);
      }
    },
  );

  // Session 事件
  sessionManager.on('sessionCreated', (session) => {
    broadcastEvent<SessionCreatedPayload>(EVENT_CHANNELS.SESSION_CREATED, { session });
    broadcastAppState(deps);
  });

  sessionManager.on('sessionOwnerChanged', (e) => {
    broadcastEvent<SessionOwnerChangedPayload>(EVENT_CHANNELS.SESSION_OWNER_CHANGED, e);
  });

  // CP-3: state-changed 涵盖 active/idle 转移、currentCwd 更新、exited 状态。
  // SessionExitedPayload 仍单独发,因为它带 exitCode 等额外信息。
  sessionManager.on('sessionStateChanged', (e: SessionStateChangedPayload) => {
    broadcastEvent<SessionStateChangedPayload>(
      EVENT_CHANNELS.SESSION_STATE_CHANGED,
      e,
    );
    // active/idle 转移可能影响 trayManager 的图标 (V1.1),广播 app state
    broadcastAppState(deps);
  });

  sessionManager.on('sessionExited', (e: SessionExitedPayload) => {
    broadcastEvent<SessionExitedPayload>(EVENT_CHANNELS.SESSION_EXITED, e);
  });

  // 模板变化 (CP-3: 用户改默认模板 / CP-4: CRUD 自定义模板)
  templatesManager.on(
    'templatesUpdated',
    (e: { templates: Template[]; defaultTemplateId: string }) => {
      broadcastEvent<TemplateListUpdatedPayload>(
        EVENT_CHANNELS.TEMPLATES_UPDATED,
        e,
      );
    },
  );

  sessionManager.on('sessionDestroyed', (e: SessionDestroyedPayload) => {
    broadcastEvent<SessionDestroyedPayload>(EVENT_CHANNELS.SESSION_DESTROYED, e);
    broadcastAppState(deps);
  });

  // Session output → 仅推 owner
  //
  // Ceteris Link 之后 owner 可能是一个远程客户端(虚拟窗口)。走
  // sendEventToWindowId 而非 getById + sendEventTo:前者会自动区分
  // "本机 webContents" 与 "TCP 连接",后者对虚拟窗口返回 null,字节流会
  // 被静默丢掉 —— 表现就是远程终端里敲了命令但屏幕永远不更新。
  sessionManager.on('sessionOutput', (payload: SessionOutputPayload) => {
    const session = sessionManager.get(payload.sessionId);
    if (!session?.ownerWindowId) return; // 无 owner 不推 (CP-3 写 scrollback)
    sendEventToWindowId<SessionOutputPayload>(
      session.ownerWindowId,
      EVENT_CHANNELS.SESSION_OUTPUT,
      payload,
    );
  });

  // 窗口列表变化 → 广播 evt:window:list-updated
  // 窗口关闭时:让 SessionManager 把该窗口持有的 sessions 转为无主
  windowManager.onWindowCreated(() => {
    broadcastEvent<WindowListUpdatedPayload>(EVENT_CHANNELS.WINDOW_LIST_UPDATED, {
      windows: windowManager.list(),
    });
    broadcastAppState(deps);
  });

  windowManager.onWindowClosed((windowId) => {
    sessionManager.handleWindowClosed(windowId);
    broadcastEvent<WindowListUpdatedPayload>(EVENT_CHANNELS.WINDOW_LIST_UPDATED, {
      windows: windowManager.list(),
    });
    broadcastAppState(deps);
  });
}

function broadcastAppState(deps: IpcLayerDeps): void {
  const sessions = deps.sessionManager.list();
  broadcastEvent<AppStateChangedPayload>(EVENT_CHANNELS.APP_STATE_CHANGED, {
    hasWindows: deps.windowManager.count() > 0,
    totalSessions: sessions.length,
    activeSessions: sessions.filter((s) => s.state === 'active').length,
  });
}

// ──────────────────────────────────────────────────────────────────
// Snapshot 构建
// ──────────────────────────────────────────────────────────────────

function buildSnapshot(deps: IpcLayerDeps, myWindowId: string): AppSnapshot {
  return {
    windows: deps.windowManager.list(),
    sessions: deps.sessionManager.list(),
    pathTree: deps.pathManager.getTree(),
    sshProfiles: deps.sshProfileManager?.list() ?? [],
    templates: deps.templatesManager.list(),
    defaultTemplateId: deps.templatesManager.getDefaultTemplateId(),
    settings: deps.settingsManager.get(),
    myWindowId,
  };
}

// ──────────────────────────────────────────────────────────────────
// 错误工具
// ──────────────────────────────────────────────────────────────────

interface IpcError extends Error {
  code: string;
  details?: Record<string, unknown>;
}

function makeIpcError(
  code: string,
  message: string,
  details?: Record<string, unknown>,
): IpcError {
  const err = new Error(`[ipc] ${code}: ${message}`) as IpcError;
  err.code = code;
  if (details) err.details = details;
  return err;
}

function encryptPasswordOrThrow(plaintext: string): string {
  if (!safeStorage.isEncryptionAvailable()) {
    throw makeIpcError(
      'SafeStorageUnavailable',
      '当前系统未启用 OS 凭据加密(Linux 上可能缺少 libsecret/GNOME Keyring)。无法安全保存密码。',
    );
  }
  return safeStorage.encryptString(plaintext).toString('base64');
}

export function decryptStoredPassword(blob: string): { password?: string } {
  if (!safeStorage.isEncryptionAvailable()) return {};
  try {
    const buf = Buffer.from(blob, 'base64');
    return { password: safeStorage.decryptString(buf) };
  } catch {
    return {};
  }
}

async function assertDirectory(path: string): Promise<void> {
  let stat;
  try {
    stat = await fs.stat(path);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw makeIpcError('PathNotExist', `path="${path}" 不存在`);
    }
    throw makeIpcError(
      'Internal',
      `stat 失败 path="${path}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!stat.isDirectory()) {
    throw makeIpcError('PathNotDirectory', `path="${path}" 不是目录`);
  }
}
