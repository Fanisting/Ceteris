/**
 * @file src/renderer/components/Sidebar.tsx
 * @purpose 三栏侧栏 (收藏 / 临时 / 最近),路径节点 + 子 session 节点。
 *   含 + 按钮调文件夹选择器、拖文件夹到收藏区加入收藏 (drag-drop)、
 *   单击折叠展开、右侧终端图标新建 session、右键菜单 (CP-2 简化菜单)。
 *
 * @关键设计:
 * - 三栏始终显示,即使空 (软件定义书 6.2.1: 默认全部展开)
 * - 同 path 在三栏不重叠;每个 path 节点可展开看 sessions
 * - sessions 显示状态点 (active 绿 / idle 黄 / exited 灰)、
 *   是否被其他窗口持有 (灰显 + ↗ 图标)
 * - 拖 Explorer 文件夹到 .sidebar-bookmarks-dropzone (CP-2 完成标志):
 *   先校验 file:// path 是否存在且是目录,然后调 cmd:bookmark:add
 * - The list shows local folders or SSH folders, chosen from the title bar badge.
 * - Folders show as rows or as pebbles, switched from the Folders header. Rows fold open in
 *   place. Pebbles are packed like words, as wide as their names, not a grid; a click opens
 *   that folder's sessions with a back button, so they stay compact however many sessions
 *   a folder has. Both layouts are PathItem,
 *   so the context menu, rename, tags and the terminal button behave the same.
 * - 设置入口固定在底部 (CP-2 占位,CP-4 接入完整设置)
 *
 * @对应文档章节: 软件定义书.md 6.2 (左侧栏)、7.3 (拖拽规格)
 */
import {
  memo,
  useEffect,
  useState,
  useMemo,
  useRef,
  type DragEvent,
  type MouseEvent,
} from 'react';
import type { SidebarSegment } from '@shared/view-menu';
import { PATH_DRAG_TYPE } from './path-drag';
import { PICK_REMOTE_FOLDER_EVENT } from './ViewSwitchButton';
import {
  AccountTree,
  ArrowBack,
  CheckBold,
  ChevronRight,
  CloseBold,
  Terminal,
  Warning,
  Folder,
  GridView,
  ViewList,
} from './material-symbols';
import { FileTreePanel } from './FileTreePanel';
import { TagDot, TagEditor, TagSettings } from './TagEditor';
import { RemoteFolderPicker } from './RemoteFolderPicker';
import { focusTerminalDom } from '../focus';
import {
  COMMAND_CHANNELS,
  type AddBookmarkResponse,
  type CreateSessionResponse,
  type PickFolderResponse,
  type FocusSessionOwnerResponse,
} from '@shared/protocol';
import type {
  SshProfile, PathNode, SessionInfo } from '@shared/types';
import { disambiguatePathNames } from '@shared/path-display';
import { countTags, matchesTags } from '@shared/path-tags';
import {
  SESSION_STATUS_FILTERS,
  sessionStatus,
  type SessionStatusFilter,
} from '@shared/session-status';
import { useTranslation } from './LanguageProvider';
import {
  findMyOwnedSessionId,
  useAppDispatch,
  useAppState,
  useAppStateRef,
  saveSidebarSegment,
} from '../store';
import { Icon } from './icons';
import { useContextMenuApi, type ContextMenuItem } from './ContextMenu';
import { useModal } from './Modal';
import { useToast } from './Toast';
import { useCopyToClipboard } from '../hooks/useCopyToClipboard';
import { useUpdateStatus } from '../hooks/useUpdateStatus';
import { buildSessionContextMenu } from './sessionContextMenu';
import { CelebrationBurst } from './CelebrationBurst';

/**
 * 状态点颜色 (软件定义书 6.2.4 状态指示):
 * - active 🟢:近期有 PTY 输出
 * - idle  🟡:活着但 N 秒无输出
 * - exited ⚫:进程已退出 (ADR-008 取代旧 'tombstoned')
 *
 * 用 CSS variables 走主题切换 (CP-4 接通);#f0f fallback 是 stylelint 兜底
 * 防止变量缺失渲染成黑色 (软件定义书 5.1.9)。
 */
const STATE_DOT_COLOR: Record<SessionInfo['state'], string> = {
  active: 'var(--color-success, #f0f)',
  idle: 'var(--color-warning, #f0f)',
  exited: 'var(--color-text-muted, #f0f)',
};

// ──────────────────────────────────────────────────────────────────
// M1-C:全局 ContextMenuProvider 提到 App.tsx,这里只 useContextMenuApi。
// 旧版内嵌 provider 已删除,文件因此短了 100+ 行。
// ──────────────────────────────────────────────────────────────────

/**
 * What the list shows, chosen from the title bar badge (ViewSwitchButton.tsx).
 * 'local' = 本机 + 所有 WSL 发行版,'remote' = 所有 SSH profile。
 * 持久化到 localStorage,跨重启保留。
 */
const FILE_TREE_OPEN_LS_KEY = 'ceteris.sidebar.fileTreeOpen';

function readFileTreeOpenFromStorage(): boolean {
  try {
    return window.localStorage?.getItem(FILE_TREE_OPEN_LS_KEY) === 'true';
  } catch {
    return false;
  }
}

/**
 * Rows or blocks, remembered per machine in localStorage like the file tree toggle. It is a
 * viewing preference, not a setting, so other open windows keep their own layout.
 */
type FolderLayout = 'list' | 'blocks';
const FOLDER_LAYOUT_LS_KEY = 'ceteris.sidebar.folderLayout';

function readFolderLayoutFromStorage(): FolderLayout {
  try {
    return window.localStorage?.getItem(FOLDER_LAYOUT_LS_KEY) === 'blocks' ? 'blocks' : 'list';
  } catch {
    return 'list';
  }
}

/**
 * Sidebar 宽度持久化(localStorage)。右侧 resize handle 拖动调整,松开时落盘。
 *
 * 范围 [SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH]:小于 min 路径名挤成省略号,大于
 * max 抢占终端区视觉权重。中间档默认 280px 与历史 CSS 一致,无 sidebarWidth
 * 时回落到该值(旧用户首次升级看不出变化)。
 */
const SIDEBAR_WIDTH_LS_KEY = 'ceteris.sidebar.width';
const SIDEBAR_DEFAULT_WIDTH = 280;
const SIDEBAR_MIN_WIDTH = 180;
const SIDEBAR_MAX_WIDTH = 600;

function clampSidebarWidth(n: number): number {
  if (!Number.isFinite(n)) return SIDEBAR_DEFAULT_WIDTH;
  return Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, Math.round(n)));
}

function readSidebarWidthFromStorage(): number {
  if (typeof window === 'undefined' || !window.localStorage) return SIDEBAR_DEFAULT_WIDTH;
  const v = window.localStorage.getItem(SIDEBAR_WIDTH_LS_KEY);
  if (v === null) return SIDEBAR_DEFAULT_WIDTH;
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) return SIDEBAR_DEFAULT_WIDTH;
  return clampSidebarWidth(n);
}

export function Sidebar(): JSX.Element {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const toast = useToast();
  const modal = useModal();
  const { t, tx } = useTranslation();
  const [dragOver, setDragOver] = useState(false);
  const [remotePickerOpen, setRemotePickerOpen] = useState(false);
  const [remotePickerProfileId, setRemotePickerProfileId] = useState<string | null>(null);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [managedTag, setManagedTag] = useState<string | null>(null);
  // ADR-023:内置的 Running / Needs you 筛选,一次只选一个(两者互斥,同时选只会清空)
  const [statusFilter, setStatusFilter] = useState<SessionStatusFilter | null>(null);
  // ADR-018: a newer release puts a dot on the settings button.
  const { status: updateStatus } = useUpdateStatus();
  const availableUpdate = updateStatus?.state === 'available' ? updateStatus.update : null;
  // Chosen from the title bar badge, which is the only switcher.
  const segment = state.sidebarSegment;
  useEffect(() => saveSidebarSegment(segment), [segment]);

  // The badge asks for this when a server has no saved folder yet.
  useEffect(() => {
    const open = (e: Event): void => {
      setRemotePickerProfileId((e as CustomEvent<{ profileId: string }>).detail.profileId);
      setRemotePickerOpen(true);
    };
    window.addEventListener(PICK_REMOTE_FOLDER_EVENT, open);
    return () => window.removeEventListener(PICK_REMOTE_FOLDER_EVENT, open);
  }, []);

  const [fileTreeOpen, setFileTreeOpen] = useState<boolean>(() => readFileTreeOpenFromStorage());
  const toggleFileTree = (): void => {
    const next = !fileTreeOpen;
    setFileTreeOpen(next);
    try {
      window.localStorage?.setItem(FILE_TREE_OPEN_LS_KEY, String(next));
    } catch {
      // localStorage 不可用时只影响下次启动的默认状态
    }
    focusTerminalDom();
  };

  // ── Sidebar 宽度可拖动 + 持久化 ──
  // 拖动期间只 setWidth 不写 localStorage(快速移动会大量触发 setItem),松开
  // 时才落盘一次。全局 mousemove/mouseup 监听通过 ref 标记 isResizing,避免
  // 鼠标移出 sidebar 边缘后丢失事件;widthRef 镜像 state 让 onUp 拿到最新值
  // 而不依赖 setState updater(updater 内 throw 会把异常抛到 commit)。
  // document.body.style.cursor 临时锁成 ew-resize,防止拖动越过 sidebar 边界
  // 进入终端区时鼠标光标抖。
  const [sidebarWidth, setSidebarWidth] = useState<number>(() =>
    readSidebarWidthFromStorage(),
  );
  const widthRef = useRef(sidebarWidth);
  widthRef.current = sidebarWidth;
  const isResizingRef = useRef(false);

  const handleResizeMouseDown = (e: MouseEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return;
    e.preventDefault();
    isResizingRef.current = true;
    document.body.style.cursor = 'ew-resize';
    // 不允许拖动时选中文本
    document.body.style.userSelect = 'none';
  };

  useEffect(() => {
    const onMove = (e: globalThis.MouseEvent): void => {
      if (!isResizingRef.current) return;
      // sidebar 左边贴 viewport 左缘(无窗口阴影/边距),clientX 直接当宽度用
      setSidebarWidth(clampSidebarWidth(e.clientX));
    };
    const onUp = (): void => {
      if (!isResizingRef.current) return;
      isResizingRef.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      try {
        window.localStorage?.setItem(SIDEBAR_WIDTH_LS_KEY, String(widthRef.current));
      } catch {
        // localStorage 失败容忍 — 本次会话内拖动仍生效,下次重启回落默认
      }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  const handleResizeDoubleClick = (): void => {
    // 双击 handle 复位默认宽度(类似浏览器 devtools 分隔条惯例)
    setSidebarWidth(SIDEBAR_DEFAULT_WIDTH);
    try {
      window.localStorage?.setItem(SIDEBAR_WIDTH_LS_KEY, String(SIDEBAR_DEFAULT_WIDTH));
    } catch {
      // ignore
    }
  };

  const effectiveSegment: SidebarSegment = segment;

  // SSH 方案 v2.1 §II.3:列表按 segment 过滤(本地 = kind==='local',包含
  // WSL UNC 路径;远程 = kind==='ssh')。
  const { bookmarks, temporary } = state.pathTree;
  const folders = useMemo(
    () =>
      [...bookmarks, ...temporary].filter((n) =>
        effectiveSegment === 'remote' ? n.kind === 'ssh' : n.kind === 'local',
      ),
    [bookmarks, temporary, effectiveSegment],
  );
  const allTags = useMemo(() => countTags(folders), [folders]);
  // A selected tag whose last folder is gone has no chip left to turn it off, so it stops
  // counting rather than leaving the list empty.
  const activeTags = selectedTags.filter((tag) => allTags.some((c) => c.name === tag));
  const taggedFolders = folders.filter((n) => matchesTags(n.tags, activeTags));
  // ADR-023:状态筛选按 session 算,跨所有文件夹,与文件夹标签是"且"的关系。
  // 计数只数标签筛选后剩下的文件夹,点下去看到的数目与计数一致。
  const statusOf = (sid: string): SessionStatusFilter | null => {
    const s = state.sessions.get(sid);
    return s ? sessionStatus(s, state.unseenDoneSessionIds.has(sid)) : null;
  };
  const statusCounts: Record<SessionStatusFilter, number> = { running: 0, 'needs-you': 0 };
  for (const folder of taggedFolders) {
    for (const sid of folder.sessionIds) {
      const status = statusOf(sid);
      if (status) statusCounts[status] += 1;
    }
  }
  const visibleFolders =
    statusFilter === null
      ? taggedFolders
      : taggedFolders.filter((n) => n.sessionIds.some((sid) => statusOf(sid) === statusFilter));
  const reachableTags = new Set(countTags(visibleFolders).map((c) => c.name));

  const toggleTag = (tag: string): void => {
    setSelectedTags(
      activeTags.includes(tag) ? activeTags.filter((x) => x !== tag) : [...activeTags, tag],
    );
  };

  const addRemoteBookmark = async (profile: SshProfile, path: string): Promise<void> => {
    try {
      await window.api.invoke<unknown, AddBookmarkResponse>(
        COMMAND_CHANNELS.REMOTE_BOOKMARK_ADD,
        { sshProfileId: profile.id, remotePath: path },
      );
      toast.push({ kind: 'success', message: `已添加远程文件夹 ${path}` });
    } catch (err) {
      toast.push({
        kind: 'error',
        message: `添加远程文件夹失败:${err instanceof Error ? err.message : String(err)}`,
      });
    }
  };

  /** SFTP 连不上时的退路:服务器可能只开了 shell,这时只能键入路径。 */
  const typeRemotePath = async (profile: SshProfile): Promise<void> => {
    const remotePath = await modal.prompt({
      title: `添加远程文件夹 — ${profile.name}`,
      message: `输入 ${profile.username}@${profile.host} 上的目录路径。`,
      placeholder: '~/project',
      defaultValue: '~',
      confirmLabel: '加入',
    });
    const path = remotePath?.trim();
    if (path) await addRemoteBookmark(profile, path);
  };

  /**
   * 收藏栏 "+" 按钮。按当前 segment 走不同流程:
   *
   * - 本地段:beta.9 行为 — 系统 folder picker → BOOKMARK_ADD
   * - 远程段:RemoteFolderPicker 通过 SFTP 选目录。零 profile 时 toast 引导
   *   用户去设置。
   */
  const handleAddBookmark = async (): Promise<void> => {
    if (effectiveSegment === 'remote') {
      const profiles = state.sshProfiles;
      if (profiles.length === 0) {
        toast.push({
          kind: 'warn',
          message: '请先在 设置 → 远程 添加 SSH 服务器',
        });
        return;
      }
      setRemotePickerOpen(true);
      return;
    }
    // 本地段:beta.9 行为
    try {
      const result = await window.api.invoke<unknown, PickFolderResponse>(
        COMMAND_CHANNELS.BOOKMARK_PICK_FOLDER,
        {},
      );
      if (result.path === null) return;
      await window.api.invoke<unknown, AddBookmarkResponse>(
        COMMAND_CHANNELS.BOOKMARK_ADD,
        { path: result.path },
      );
    } catch (err) {
      toast.push({
        kind: 'error',
        message: `添加文件夹失败:${err instanceof Error ? err.message : String(err)}`,
      });
    }
  };

  /**
   * F12(DROP-1 架构重构):拖拽决策全部收拢到 App.tsx 的 window 监听器。
   * Sidebar 不再 preventDefault / 不再设 dropEffect — 那些事 window 统
   * 一管,通过 `data-drop-zone="files"` 标记声明"我接受"。
   *
   * 本组件这里只剩两件事:
   *   1. onDragOver 维护视觉态(.drag-over 高亮 + 居中浮卡)
   *   2. onDrop 消费 files → IPC bookmark:add
   *
   * 心跳超时(F8 引入)仍然保留:拖出窗口 / ESC 时没有可靠的 dragleave,
   * 靠"150ms 没收到下一个 dragover 就清视觉态"兜底。
   */
  const dragHeartbeatRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearDragOverSoon = (): void => {
    if (dragHeartbeatRef.current) clearTimeout(dragHeartbeatRef.current);
    dragHeartbeatRef.current = setTimeout(() => {
      setDragOver(false);
      dragHeartbeatRef.current = null;
    }, 150);
  };

  useEffect(() => {
    return () => {
      if (dragHeartbeatRef.current) clearTimeout(dragHeartbeatRef.current);
    };
  }, []);

  /**
   * 检查当前拖拽内容是否含文件。
   * 注:Chromium 的 DataTransfer.types 在 dragover 阶段对 OS 文件拖拽稳定
   * 返回包含 "Files" 的数组。非文件来源(终端选区 / 网页文本拖拽)不含。
   * 仅用于视觉态门控 — 避免拖文本时也跳出"放下添加为收藏"的浮卡。
   */
  const isFileDrag = (e: DragEvent<HTMLElement>): boolean => {
    const types = e.dataTransfer?.types;
    if (!types) return false;
    for (let i = 0; i < types.length; i++) {
      if (types[i] === 'Files') return true;
    }
    return false;
  };

  const handleDragOver = (e: DragEvent<HTMLElement>): void => {
    // 注意:这里不调 preventDefault / 不设 dropEffect — App.tsx 的 window
    // 监听器是唯一决策点(它会通过 data-drop-zone 属性识别本元素是 drop
    // zone 并设 'copy')。本 handler 只为视觉反馈服务。
    if (!isFileDrag(e)) return;
    setDragOver(true);
    clearDragOverSoon();
  };

  const handleDrop = async (e: DragEvent<HTMLElement>): Promise<void> => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    if (dragHeartbeatRef.current) {
      clearTimeout(dragHeartbeatRef.current);
      dragHeartbeatRef.current = null;
    }
    const files = Array.from(e.dataTransfer.files);
    for (const file of files) {
      // file.path 是 Electron 提供的扩展属性 (浏览器标准 File API 没有),
      // V1 我们假定 sandbox: false + nodeIntegration: false + contextIsolation: true
      // 也就是 webPreferences 默认提供 file.path
      const path = (file as File & { path?: string }).path;
      if (!path) continue;
      try {
        await window.api.invoke<unknown, AddBookmarkResponse>(
          COMMAND_CHANNELS.BOOKMARK_ADD,
          { path },
        );
      } catch (err) {
        console.error('[Sidebar] drop add-bookmark failed', err);
      }
    }
  };

  return (
    <aside
      className={`sidebar${dragOver ? ' drag-over' : ''}`}
      data-drop-zone="files"
      style={{ flexBasis: `${sidebarWidth}px` }}
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          dispatch({ type: 'view/select-path', pathId: null });
        }
      }}
      onDragOver={handleDragOver}
      onDrop={(e) => void handleDrop(e)}
    >
      {/* F11(beta 勘误2 续 v4):撤回 F9 inset box-shadow / F10 overlay border —
          sidebar 紧贴窗口左/下边,Win11 窗口圆角会吃掉绝对定位元素 inset:0 的
          左/下 2px 边框。改用纯背景洗涤区分 drag-over 态,浮卡居中作为主要
          视觉锚,完全不依赖边框渲染。pointer-events:none + aria-hidden 不挡 drop。 */}
      <div className="sidebar-drop-hint" aria-hidden="true">
        <span className="sidebar-drop-hint-icon">📁</span>
        <span className="sidebar-drop-hint-label">{t('sidebar.dropHint')}</span>
      </div>
      <div className="sidebar-bookmarks-dropzone" data-segment={effectiveSegment}>
        <FolderList
          folders={visibleFolders}
          statusFilter={statusFilter}
          activeTags={activeTags}
          onToggleTag={toggleTag}
          onManageTag={setManagedTag}
          onAdd={() => void handleAddBookmark()}
        />
      </div>
      {/* ADR-023:Running / Needs you 总在,所以这一栏不再只在有标签时出现 */}
      <div className="sidebar-tag-bar">
        <div className="sidebar-tags" role="group" aria-label={tx('按标签筛选', 'Filter by tag')}>
          {SESSION_STATUS_FILTERS.map((status) => {
            const active = statusFilter === status;
            const count = statusCounts[status];
            const label = status === 'running' ? tx('运行中', 'Running') : tx('等你处理', 'Needs you');
            return (
              <button
                key={status}
                type="button"
                className={`tag-chip status-filter-chip${active ? ' active' : ''}`}
                aria-pressed={active}
                disabled={!active && count === 0}
                title={
                  status === 'running'
                    ? tx('所有文件夹里正在运行的终端', 'Terminals running, in every folder')
                    : tx(
                        '所有文件夹里等你批准或等下一条指令的 agent',
                        'Agents waiting for your approval or next prompt, in every folder',
                      )
                }
                onClick={() => setStatusFilter(active ? null : status)}
              >
                <span className={`status-filter-dot ${status}`} aria-hidden="true" />
                {label}
                <span className="tag-chip-count">{count}</span>
              </button>
            );
          })}
          {allTags.length > 0 && <span className="tag-bar-divider" aria-hidden="true" />}
          {allTags.map(({ name, count }) => {
            const active = activeTags.includes(name);
            return (
              <div
                key={name}
                className={`tag-chip tag-filter-chip${active ? ' active' : ''}`}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setManagedTag(name);
                }}
              >
                <button
                  type="button"
                  className="tag-dot-button"
                  title={tx('颜色、重命名、删除', 'Colour, rename, delete')}
                  aria-label={tx(`管理标签 ${name}`, `Manage tag ${name}`)}
                  onClick={() => setManagedTag(name)}
                >
                  <TagDot tag={name} />
                </button>
                <button
                  type="button"
                  className="tag-filter-label"
                  aria-pressed={active}
                  disabled={!active && !reachableTags.has(name)}
                  title={name}
                  onClick={() => toggleTag(name)}
                >
                  {name}
                  <span className="tag-chip-count">{count}</span>
                </button>
              </div>
            );
          })}
        </div>
        {/* Outside the scrolling list, which would otherwise carry it out of view. */}
        {(activeTags.length > 0 || statusFilter !== null) && (
          <button
            type="button"
            className="tag-clear"
            onClick={() => {
              setSelectedTags([]);
              setStatusFilter(null);
            }}
          >
            {tx('清除', 'Clear')}
          </button>
        )}
      </div>
      {managedTag && <TagSettings tag={managedTag} onClose={() => setManagedTag(null)} />}
      {fileTreeOpen && <FileTreePanel />}
      {remotePickerOpen && (
        <RemoteFolderPicker
          profiles={
            remotePickerProfileId
              ? state.sshProfiles.filter((p) => p.id === remotePickerProfileId)
              : state.sshProfiles
          }
          onPick={(profile, path) => {
            setRemotePickerOpen(false);
            setRemotePickerProfileId(null);
            void addRemoteBookmark(profile, path);
          }}
          onManual={(profile) => {
            setRemotePickerOpen(false);
            setRemotePickerProfileId(null);
            void typeRemotePath(profile);
          }}
          onCancel={() => {
            setRemotePickerOpen(false);
            setRemotePickerProfileId(null);
          }}
        />
      )}
      <div className="sidebar-footer">
        <button
          type="button"
          className={`settings-entry${availableUpdate ? ' has-update' : ''}`}
          onClick={() =>
            // 有新版本时直接进关于页,下载按钮就在那里(ADR-018)
            dispatch(
              availableUpdate
                ? { type: 'view/enter-settings', category: 'about' }
                : { type: 'view/enter-settings' },
            )
          }
          title={
            availableUpdate
              ? tx(
                  `设置(有新版本 v${availableUpdate.version})`,
                  `Settings (v${availableUpdate.version} available)`,
                )
              : tx('设置', 'Settings')
          }
          aria-label={tx('设置', 'Settings')}
        >
          <Icon name="settings" size={20} />
        </button>
        <button
          type="button"
          className={`file-tree-toggle${fileTreeOpen ? ' active' : ''}`}
          onClick={toggleFileTree}
          title={t('fileTree.toggle')}
          aria-label={t('fileTree.toggle')}
          aria-pressed={fileTreeOpen}
          data-testid="file-tree-toggle"
        >
          <AccountTree size={20} />
        </button>
      </div>
      {/*
        右侧 resize handle:绝对定位,4px 宽,贴右边。鼠标按下时 setIsResizing,
        全局 mousemove 计算新宽度。双击复位默认宽度。aria-hidden 因为只是视觉
        affordance,不进辅助技术导航树(用户操作纯靠鼠标拖)。
      */}
      <div
        className="sidebar-resize-handle"
        onMouseDown={handleResizeMouseDown}
        onDoubleClick={handleResizeDoubleClick}
        title="拖动调整宽度 (双击复位)"
        aria-hidden="true"
      />
    </aside>
  );
}

/** What a folder row needs to drive the tag filter through its dots. */
interface TagDotActions {
  activeTags: string[];
  onToggleTag: (tag: string) => void;
  onManageTag: (tag: string) => void;
}

/** Most dots a row shows, so a heavily tagged folder keeps room for its name. */
const MAX_ROW_DOTS = 5;

/** Most session dots a pebble shows before it writes +N; few, so pebbles stay small. */
const MAX_BLOCK_SESSION_DOTS = 5;


/**
 * A session's dot colour (ADR-021): warning while an agent waits at an approval prompt, the
 * primary colour when it finished unseen, otherwise the active / idle / exited colour.
 * Shared by the session rows and the dots on a folder block so the two never disagree.
 */
function sessionDotColor(session: SessionInfo, unseen: boolean): string {
  if (session.agentPhase === 'blocked') return 'var(--color-warning, #f0f)';
  if (unseen) return 'var(--md-primary, #f0f)';
  return STATE_DOT_COLOR[session.state];
}

/** The breathing animation class that goes with sessionDotColor, with a leading space. */
function sessionDotClass(session: SessionInfo, unseen: boolean): string {
  if (session.agentPhase === 'blocked') return ' agent-blocked';
  if (unseen) return ' agent-unseen';
  return '';
}

function FolderList({
  folders,
  statusFilter,
  onAdd,
  ...dotActions
}: {
  folders: PathNode[];
  statusFilter: SessionStatusFilter | null;
  onAdd: () => void;
} & TagDotActions): JSX.Element {
  const { t, tx } = useTranslation();
  const selectedPathId = useAppState().selectedPathId;
  // BETA-014:末级文件夹同名时自动补父目录区分;手动命名的不参与。
  const displayNames = useMemo(() => disambiguatePathNames(folders), [folders]);
  const empty = folders.length === 0;
  const nameOverride = (p: PathNode): { displayNameOverride?: string } => {
    const override = p.kind === 'ssh' ? undefined : displayNames.get(p.id);
    return override !== undefined ? { displayNameOverride: override } : {};
  };

  const [layout, setLayout] = useState<FolderLayout>(() => readFolderLayoutFromStorage());
  // Pebbles layout: the folder whose sessions are shown in place of the pebbles.
  const [openFolderId, setOpenFolderId] = useState<string | null>(null);
  const toggleLayout = (): void => {
    const next: FolderLayout = layout === 'list' ? 'blocks' : 'list';
    setLayout(next);
    setOpenFolderId(null);
    try {
      window.localStorage?.setItem(FOLDER_LAYOUT_LS_KEY, next);
    } catch {
      // localStorage 不可用时只影响下次启动的默认布局
    }
  };
  // Follow the selection while a folder is open: picking a tab of another folder from the
  // tab bar should not leave the sidebar showing sessions the user is no longer looking at.
  useEffect(() => {
    if (selectedPathId !== null) {
      setOpenFolderId((open) => (open === null ? null : selectedPathId));
    }
  }, [selectedPathId]);
  // A folder removed from the list, or hidden by a filter, falls back to the pebbles.
  const openFolder =
    layout === 'blocks' && openFolderId !== null
      ? folders.find((p) => p.id === openFolderId)
      : undefined;
  const layoutLabel =
    layout === 'list' ? tx('以石子显示', 'Show as pebbles') : tx('以列表显示', 'Show as list');

  return (
    <section className={`sidebar-category${empty ? ' empty' : ''}`}>
      {/* No chevron slot: the icon lines up with the file tree header's folder icon, and the
          count follows the title instead of sitting by the buttons (material.css). */}
      <header className="sidebar-category-header">
        <span className="sidebar-category-title">
          <span className="sidebar-category-icon" aria-hidden="true">
            <Folder size={14} />
          </span>
          {t('sidebar.folders')}
          {!empty && <span className="sidebar-category-count">{folders.length}</span>}
        </span>
        <button
          type="button"
          className="sidebar-category-action"
          onClick={toggleLayout}
          title={layoutLabel}
          aria-label={layoutLabel}
          data-testid="folder-layout-toggle"
        >
          {layout === 'list' ? <GridView size={14} /> : <ViewList size={14} />}
        </button>
        <button
          type="button"
          className="sidebar-category-action"
          onClick={onAdd}
          title={t('sidebar.addBookmark.title')}
        >
          <Icon name="plus" size={12} />
        </button>
      </header>
      {!empty && layout === 'list' && (
        <ul className="sidebar-paths">
          {folders.map((p) => (
            <PathItem
              key={p.id}
              node={p}
              statusFilter={statusFilter}
              layout="row"
              {...dotActions}
              {...nameOverride(p)}
            />
          ))}
        </ul>
      )}
      {!empty && layout === 'blocks' && openFolder && (
        <PathItem
          key={openFolder.id}
          node={openFolder}
          statusFilter={statusFilter}
          layout="open"
          onBack={() => setOpenFolderId(null)}
          {...dotActions}
          {...nameOverride(openFolder)}
        />
      )}
      {!empty && layout === 'blocks' && !openFolder && (
        <ul className="sidebar-blocks">
          {folders.map((p) => (
            <PathItem
              key={p.id}
              node={p}
              statusFilter={statusFilter}
              layout="block"
              onOpen={() => setOpenFolderId(p.id)}
              {...dotActions}
              {...nameOverride(p)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

/** A folder's tags as dots. Click one to filter by it, right click to manage it. */
function RowTagDots({
  tags,
  activeTags,
  onToggleTag,
  onManageTag,
}: { tags: string[] } & TagDotActions): JSX.Element {
  const shown = tags.slice(0, MAX_ROW_DOTS);
  return (
    <span className="path-tag-dots">
      {shown.map((tag) => (
        <button
          key={tag}
          type="button"
          className={`tag-dot-button${activeTags.includes(tag) ? ' active' : ''}`}
          title={tag}
          aria-label={tag}
          aria-pressed={activeTags.includes(tag)}
          onClick={(e) => {
            e.stopPropagation();
            onToggleTag(tag);
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onManageTag(tag);
          }}
        >
          <TagDot tag={tag} />
        </button>
      ))}
      {tags.length > shown.length && (
        <span className="path-tag-more" title={tags.slice(MAX_ROW_DOTS).join(', ')}>
          +{tags.length - shown.length}
        </span>
      )}
    </span>
  );
}

/**
 * One folder, in one of three layouts that share the menu, rename, tags and terminal button:
 * - 'row': the list layout; a click selects, a second click folds the sessions in or out.
 * - 'block': a pebble; a click selects the folder and calls onOpen.
 * - 'open': the pebbles layout with this folder opened, a back row over its sessions.
 */
function PathItem({
  node,
  displayNameOverride,
  statusFilter,
  layout,
  onOpen,
  onBack,
  ...dotActions
}: {
  node: PathNode;
  displayNameOverride?: string;
  /** ADR-023:设了就只列这类 session,并且总是展开,一眼看到全部 */
  statusFilter: SessionStatusFilter | null;
  layout: 'row' | 'block' | 'open';
  /** 'block' only: show this folder's sessions in place of the pebbles. */
  onOpen?: () => void;
  /** 'open' only: go back to the pebbles. */
  onBack?: () => void;
} & TagDotActions): JSX.Element {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const ctxMenu = useContextMenuApi();
  const toast = useToast();
  const { tx } = useTranslation();
  const [tagging, setTagging] = useState(false);
  const expanded = statusFilter !== null || state.expandedPathIds.has(node.id);
  const selected = state.selectedPathId === node.id;
  const allSessions = useMemo(
    () => node.sessionIds.map((sid) => state.sessions.get(sid)).filter(Boolean) as SessionInfo[],
    [node.sessionIds, state.sessions],
  );
  const sessions =
    statusFilter === null
      ? allSessions
      : allSessions.filter(
          (s) => sessionStatus(s, state.unseenDoneSessionIds.has(s.id)) === statusFilter,
        );
  const activeCount = allSessions.length;
  // BETA-014:优先用 FolderList 算好的去重名;退到本节点 displayName / 末段
  const displayName =
    displayNameOverride ??
    node.displayName ??
    formatPathDisplayName(node);

  // M1-C:行内重命名 (仅收藏支持)
  const [renaming, setRenaming] = useState(false);
  const [renameText, setRenameText] = useState(displayName);
  const renameInputRef = useRef<HTMLInputElement | null>(null);

  const beginRename = (): void => {
    setRenameText(displayName);
    setRenaming(true);
    requestAnimationFrame(() => {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    });
  };

  const commitRename = (): void => {
    const v = renameText.trim();
    setRenaming(false);
    if (!v || v === displayName) return;
    window.api
      .invoke(COMMAND_CHANNELS.BOOKMARK_RENAME, {
        pathId: node.id,
        newDisplayName: v,
      })
      .catch((err: unknown) => {
        toast.push({
          kind: 'error',
          message: `重命名失败:${err instanceof Error ? err.message : String(err)}`,
        });
      });
  };

  // One click folds or unfolds, the same for every folder. Selecting already expands, and
  // selecting the current path again would drop its session, so each case is explicit.
  const handleRowClick = (): void => {
    if (renaming) return;
    if (selected) {
      dispatch({ type: 'view/toggle-path-expand', pathId: node.id });
      return;
    }
    dispatch({ type: 'view/select-path', pathId: node.id });
    if (expanded) dispatch({ type: 'view/toggle-path-expand', pathId: node.id });
  };

  const handleOpenTerminal = async (e: MouseEvent<HTMLButtonElement>): Promise<void> => {
    e.stopPropagation();
    // 在该 path 下用默认模板新建 session
    // 优先级:bookmark.defaultTemplateId > 全局 defaultTemplateId > 'shell' 兜底
    const templateId =
      node.defaultTemplateId ?? state.defaultTemplateId ?? 'shell';
    try {
      const dims = state.lastTerminalDims;
      const res = await window.api.invoke<unknown, CreateSessionResponse>(
          COMMAND_CHANNELS.SESSION_CREATE,
        {
          pathId: node.id,
          templateId,
          cols: dims.cols,
          rows: dims.rows,
        },
      );
      // 先切 path (会自动选 my-owned firstSid,但新创建的可能不是 firstSid),
      // 再显式 select 新创建的 session。两次 dispatch 在 React 18 自动 batch。
      dispatch({ type: 'view/select-path', pathId: node.id });
      dispatch({ type: 'view/select-session', sessionId: res.session.id });
      if (res.warning) {
        toast.push({ kind: 'warn', message: res.warning });
      }
    } catch (err) {
      // M1-K:不可达路径 / spawn 失败 → toast + (收藏路径) 提供"移除收藏"
      const msg = err instanceof Error ? err.message : String(err);
      toast.push({
        kind: 'error',
        message: `打开终端失败 (${node.path}):${msg}`,
        durationMs: 10000,
      });
    }
  };

  // M1-C:复制到剪贴板 — 抽到 useCopyToClipboard hook(P2-11),
  // Sidebar/MainPane/TerminalView 多处行为一致。
  const copyToClipboard = useCopyToClipboard();

  // M1-C:右键菜单 — 按分类组装条目
  const handleContextMenu = (e: MouseEvent<HTMLElement>): void => {
    e.preventDefault();
    e.stopPropagation();
    const items: ContextMenuItem[] = [];

    // 通用项
    items.push({
      label: '复制路径',
      onSelect: () => copyToClipboard(node.path, '路径'),
    });
    if (node.kind !== 'ssh') {
      items.push({
        label: '在 Explorer 中显示',
        onSelect: () => {
          window.api
            .invoke(COMMAND_CHANNELS.SYSTEM_SHOW_IN_EXPLORER, { path: node.path })
            .catch((err: unknown) =>
              toast.push({
                kind: 'error',
                message: `打开 Explorer 失败:${err instanceof Error ? err.message : String(err)}`,
              }),
            );
        },
      });
    }

    if (node.category === 'bookmarked') {
      items.push({ divider: true, label: '' });
      items.push({ label: '重命名…', onSelect: beginRename });
      items.push({ label: tx('标签…', 'Tags…'), onSelect: () => setTagging(true) });
      items.push({
        label: tx('从列表移除', 'Remove from list'),
        danger: true,
        onSelect: () => {
          window.api
            .invoke(COMMAND_CHANNELS.BOOKMARK_REMOVE, { pathId: node.id })
            .then(() =>
              toast.push({ kind: 'success', message: `已从列表移除 ${displayName}` }),
            )
            .catch((err: unknown) =>
              toast.push({
                kind: 'error',
                message: `移除失败:${err instanceof Error ? err.message : String(err)}`,
              }),
            );
        },
      });

      items.push({ divider: true, label: '' });
      items.push({
        label: tx('设置启动模板', 'Launch template'),
        submenu: state.templates
          .filter((x) => !x.hidden || x.id === node.defaultTemplateId)
          .map((template) => ({
            label: template.name,
            hint: template.command ? `启动命令: ${template.command}` : '系统默认 shell',
            checked: template.id === node.defaultTemplateId,
            onSelect: () => {
              window.api
                .invoke(COMMAND_CHANNELS.BOOKMARK_SET_DEFAULT_TEMPLATE, {
                  pathId: node.id,
                  templateId: template.id,
                })
                .catch((err: unknown) =>
                  toast.push({
                    kind: 'error',
                    message: `设置默认模板失败:${err instanceof Error ? err.message : String(err)}`,
                  }),
                );
            },
          })),
      });
    } else {
      items.push({ divider: true, label: '' });
      items.push({
        label: tx('保留在列表中', 'Keep in list'),
        onSelect: () => {
          window.api
            .invoke(
              node.kind === 'ssh'
                ? COMMAND_CHANNELS.REMOTE_BOOKMARK_ADD
                : COMMAND_CHANNELS.BOOKMARK_ADD,
              node.kind === 'ssh'
                ? {
                    sshProfileId: node.sshProfileId,
                    remotePath: node.path,
                    ...(node.displayName ? { displayName: node.displayName } : {}),
                  }
                : { path: node.path },
            )
            .then(() => toast.push({ kind: 'success', message: `已保留 ${displayName}` }))
            .catch((err: unknown) =>
              toast.push({
                kind: 'error',
                message: `保留失败:${err instanceof Error ? err.message : String(err)}`,
              }),
            );
        },
      });
    }

    ctxMenu.open({
      x: e.clientX,
      y: e.clientY,
      title: displayName,
      items,
    });
  };

  const tagEditor = tagging && (
    <TagEditor
      pathId={node.id}
      title={tx(`${displayName} 的标签`, `Tags for ${displayName}`)}
      onClose={() => setTagging(false)}
    />
  );
  const renameInput = (
    <input
      ref={renameInputRef}
      type="text"
      className="path-name-rename-input"
      value={renameText}
      onChange={(e) => setRenameText(e.target.value)}
      onBlur={commitRename}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commitRename();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          setRenaming(false);
        }
      }}
      onClick={(e) => e.stopPropagation()}
    />
  );
  const openTerminalButton = (
    <button
      type="button"
      className="path-open-terminal"
      title={`在终端中打开 ${node.path}`}
      aria-label={`在终端中打开 ${node.path}`}
      onClick={(e) => void handleOpenTerminal(e)}
    >
      <Terminal size={14} />
    </button>
  );
  const pathTitle = `${node.invalid ? `${node.path}\n⚠️ 路径不可访问` : node.path}${node.tags ? `\n${node.tags.join(', ')}` : ''}`;
  const onDragStart = (e: DragEvent<HTMLDivElement>): void => {
    e.dataTransfer.setData(PATH_DRAG_TYPE, node.id);
    e.dataTransfer.effectAllowed = 'copy';
  };
  const sessionList = sessions.length > 0 && (
    <ul className="session-list">
      {sessions.map((s) => (
        <SessionItem
          key={s.id}
          session={s}
          myWindowId={state.myWindowId}
          selected={state.selectedSessionId === s.id}
          unseen={state.unseenDoneSessionIds.has(s.id)}
          celebrate={
            !!state.settings.appearance?.hideTopTabBar &&
            (state.settings.appearance?.celebrations ?? true)
          }
          themeId={state.settings.appearance?.theme}
        />
      ))}
    </ul>
  );

  if (layout === 'block') {
    const openBlock = (): void => {
      if (renaming) return;
      dispatch({ type: 'view/select-path', pathId: node.id });
      onOpen?.();
    };
    // 每个 session 一个小圆点,颜色与 session 行一致;太多时画前几个再写 +N
    const shownDots = sessions.slice(0, MAX_BLOCK_SESSION_DOTS);
    // A pebble is as wide as its name and they wrap like words, so nothing lines up in
    // columns. Every pebble is the same symmetric capsule. The pebble holding the session on
    // screen, or the selected folder when none of its sessions is chosen, gets a ring along
    // its outline. Pebbles never take a selection fill colour.
    const holdsChosenSession =
      state.selectedSessionId !== null && node.sessionIds.includes(state.selectedSessionId);
    return (
      <li
        className={`path-block${holdsChosenSession || selected ? ' chosen' : ''}${
          node.invalid ? ' invalid' : ''
        }`}
      >
        {tagEditor}
        <div
          className="path-block-card"
          role="button"
          tabIndex={0}
          draggable={!renaming}
          onDragStart={onDragStart}
          onClick={openBlock}
          onKeyDown={(e) => {
            if (e.target !== e.currentTarget) return;
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              openBlock();
            }
          }}
          onContextMenu={handleContextMenu}
          title={pathTitle}
        >
          {node.invalid && <Warning size={12} className="path-block-icon path-invalid-icon" />}
          {renaming ? renameInput : <span className="path-block-name">{displayName}</span>}
          {shownDots.length > 0 && !renaming && (
            <span
              className="path-block-sessions"
              aria-label={tx(`${sessions.length} 个终端`, `${sessions.length} terminals`)}
            >
              {shownDots.map((s) => {
                const unseen = state.unseenDoneSessionIds.has(s.id);
                return (
                  <span
                    key={s.id}
                    className={`path-block-dot${sessionDotClass(s, unseen)}`}
                    style={{ backgroundColor: sessionDotColor(s, unseen) }}
                    title={s.displayName}
                  />
                );
              })}
              {sessions.length > shownDots.length && (
                <span className="path-block-more">+{sessions.length - shownDots.length}</span>
              )}
            </span>
          )}
        </div>
      </li>
    );
  }

  if (layout === 'open') {
    return (
      <div className={`path-open-folder${node.invalid ? ' invalid' : ''}`}>
        {tagEditor}
        <div
          className="path-open-folder-head"
          draggable={!renaming}
          onDragStart={onDragStart}
          onContextMenu={handleContextMenu}
          title={pathTitle}
        >
          <button
            type="button"
            className="path-open-folder-back"
            onClick={onBack}
            title={tx('返回所有文件夹', 'Back to all folders')}
            aria-label={tx('返回所有文件夹', 'Back to all folders')}
          >
            <ArrowBack size={16} />
          </button>
          {node.invalid && <Warning size={14} className="path-invalid-icon" />}
          {renaming ? renameInput : <span className="path-name">{displayName}</span>}
          {node.tags && !renaming && <RowTagDots tags={node.tags} {...dotActions} />}
          {!renaming && openTerminalButton}
        </div>
        {sessionList || (
          <p className="sidebar-empty path-open-folder-empty">
            {statusFilter === null
              ? tx(
                  '还没有终端。点右边的终端按钮新开一个。',
                  'No terminals yet. Use the terminal button to open one.',
                )
              : tx('没有符合筛选的终端。', 'No terminals match the filter.')}
          </p>
        )}
      </div>
    );
  }

  return (
    <li className={`path-item${selected ? ' selected' : ''}${node.invalid ? ' invalid' : ''}`}>
      {tagEditor}
      <div
        className="path-item-row"
        draggable={!renaming}
        onDragStart={onDragStart}
        onClick={handleRowClick}
        onContextMenu={handleContextMenu}
        title={pathTitle}
      >
        {/*
          F2(beta 勘误2):左侧固定 12px 槽位,按优先级选一个内容渲染 —
          展开箭头(有会话时)> 警告 icon(invalid 时)> 透明 placeholder。
          三种状态用同一个槽位,保证所有路径行的 name 文本起始 x 坐标一致,
          解决了 invalid 行 ⚠️ 把后续文字往右顶导致与其他行不对齐的问题。
          有会话且 invalid 的极少数情况(session 创建后路径被删):展开
          箭头优先,⚠️ 通过 title tooltip 提示。
        */}
        {node.invalid && sessions.length === 0 ? (
          <span className="path-expand-arrow path-invalid-slot" aria-label="路径不可访问">
            <Warning size={14} className="path-invalid-icon" />
          </span>
        ) : (
          // 同一个箭头转 90 度,而不是换成另一个图标:旋转过程说明了"展开"(motion.css)
          <span
            className={`path-expand-arrow${expanded ? ' expanded' : ''}`}
            aria-label={expanded ? '收起' : '展开'}
          >
            <ChevronRight size={16} />
          </span>
        )}
        {renaming ? renameInput : <span className="path-name">{displayName}</span>}
        {node.tags && !renaming && <RowTagDots tags={node.tags} {...dotActions} />}
        {activeCount > 0 && !renaming && (
          <span className="path-session-count" title={`${activeCount} 个终端`}>
            {activeCount}
          </span>
        )}
        {!renaming && openTerminalButton}
      </div>
      {expanded && sessionList}
    </li>
  );
}

interface SessionItemProps {
  session: SessionInfo;
  /** 父级传入 — 避免本组件订阅 state.myWindowId 触发无关重渲 */
  myWindowId: string;
  /** 父级传入 — 同上,避免订阅 state.selectedSessionId */
  selected: boolean;
  /** ADR-021:agent 跑完时用户没在看;父级传入,理由同上 */
  unseen: boolean;
  /**
   * ADR-027:圆点亮起时在这里撒小星星。只在顶部标签栏隐藏时为 true,
   * 否则标签上已经撒过,两处同时撒太吵。
   */
  celebrate: boolean;
  /** ADR-027:当前主题,决定小庆祝的样式 */
  themeId: string | undefined;
}

/**
 * 抖动源 D 的破法:本组件**不**调 useAppState()。
 *
 * 通过 props 拿渲染需要的 myWindowId / selected;事件回调里通过
 * useAppStateRef 拿最新 state(templates / 其他 session 列表 等)。
 * 用 React.memo 包裹后,sessions/state-changed 仅会让"那个真正变化的
 * session"对应的 SessionItem 重渲,其余引用未变的 props 被 memo 跳过。
 */
function SessionItemImpl({
  session,
  myWindowId,
  selected,
  unseen,
  celebrate,
  themeId,
}: SessionItemProps): JSX.Element {
  // ADR-027:小庆祝锚在状态圆点上
  const stateDotRef = useRef<HTMLSpanElement>(null);
  const dispatch = useAppDispatch();
  const ctxMenu = useContextMenuApi();
  const toast = useToast();
  const stateRef = useAppStateRef();
  const isMine = session.ownerWindowId === myWindowId;
  const ownedByOther =
    session.ownerWindowId !== null && session.ownerWindowId !== myWindowId;

  // M1-C:行内重命名
  const [renaming, setRenaming] = useState(false);
  const [renameText, setRenameText] = useState(session.displayName);
  const renameInputRef = useRef<HTMLInputElement | null>(null);

  const beginRename = (): void => {
    setRenameText(session.displayName);
    setRenaming(true);
    requestAnimationFrame(() => {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    });
  };
  const commitRename = (): void => {
    const v = renameText.trim();
    setRenaming(false);
    if (!v || v === session.displayName) return;
    window.api
      .invoke(COMMAND_CHANNELS.SESSION_RENAME, {
        sessionId: session.id,
        newDisplayName: v,
      })
      .catch((err: unknown) =>
        toast.push({
          kind: 'error',
          message: `重命名失败:${err instanceof Error ? err.message : String(err)}`,
        }),
      );
  };

  // 同 PathItem.copyToClipboard,统一走 useCopyToClipboard hook(P2-11)。
  const copyToClipboard = useCopyToClipboard();

  const handleContextMenu = (e: MouseEvent<HTMLLIElement>): void => {
    e.preventDefault();
    e.stopPropagation();
    const variant: 'mine' | 'orphan' | 'other' = isMine
      ? 'mine'
      : ownedByOther
        ? 'other'
        : 'orphan';
    ctxMenu.open({
      x: e.clientX,
      y: e.clientY,
      title: session.displayName,
      items: buildSessionContextMenu(session, {
        variant,
        pathTree: stateRef.current.pathTree,
        copyToClipboard,
        toastError: (message) => toast.push({ kind: 'error', message }),
        // Sidebar 端走"行内编辑"重命名(Tab 端走 Modal.prompt)
        onRename: beginRename,
      }),
    });
  };

  const handleClick = (): void => {
    if (renaming) return;
    // 本窗口已是 owner → 仅切 view
    if (isMine) {
      dispatch({ type: 'view/select-path', pathId: session.pathId });
      dispatch({ type: 'view/select-session', sessionId: session.id });
      return;
    }
    // 其他窗口持有 → 聚焦那个窗口,所有权不变 (软件定义书 8.4)。
    // 持有方在另一台机器上时无法聚焦,main 会交接给本窗口,这里跟着选中。
    if (ownedByOther) {
      window.api
        .invoke<{ sessionId: string }, FocusSessionOwnerResponse>(
          COMMAND_CHANNELS.SESSION_FOCUS_OWNER,
          { sessionId: session.id },
        )
        .then((res) => {
          if (res.transferred) dispatch({ type: 'view/select-session', sessionId: session.id });
        })
        .catch((err) => console.error('[Sidebar] focus-owner failed', err));
      return;
    }
    // 无主 → 乐观接管 (与 Tab.handleClick orphan 分支同协议:本地立即
    // 改 owner + select,消除 EmptyPathState 闪烁;失败回滚)
    const prevOwnedId = findMyOwnedSessionId(stateRef.current);
    if (prevOwnedId && prevOwnedId !== session.id) {
      dispatch({
        type: 'sessions/owner-changed',
        sessionId: prevOwnedId,
        ownerWindowId: null,
      });
    }
    dispatch({
      type: 'sessions/owner-changed',
      sessionId: session.id,
      ownerWindowId: myWindowId,
    });
    dispatch({ type: 'view/select-path', pathId: session.pathId });
    dispatch({ type: 'view/select-session', sessionId: session.id });

    window.api
      .invoke(COMMAND_CHANNELS.SESSION_CLAIM, { sessionId: session.id })
      .catch((err) => {
        console.error('[Sidebar] claim failed, rolling back', err);
        dispatch({
          type: 'sessions/owner-changed',
          sessionId: session.id,
          ownerWindowId: null,
        });
        if (prevOwnedId && prevOwnedId !== session.id) {
          dispatch({
            type: 'sessions/owner-changed',
            sessionId: prevOwnedId,
            ownerWindowId: myWindowId,
          });
        }
        dispatch({ type: 'view/select-session', sessionId: prevOwnedId });
      });
  };

  // ADR-008:currentCwd 与 originalCwd 不一致时显示 ⚠️ tooltip 真实 cwd。
  // session.pathId 永久不变,所以不会在 UI 上"跳" path,只是这个标志告诉用户
  // session 内 cd 走了。
  const cwdDrifted =
    !!session.currentCwd &&
    !!session.originalCwd &&
    !samePath(session.currentCwd, session.originalCwd);

  const baseTitle = ownedByOther
    ? `${session.displayName} (在其他窗口,点击聚焦那个窗口)`
    : session.displayName;
  const fullTitle = cwdDrifted
    ? `${baseTitle}\n当前目录已变 → ${session.currentCwd}\n(原: ${session.originalCwd})`
    : baseTitle;

  return (
    <li
      className={`session-item${selected ? ' selected' : ''}${
        ownedByOther ? ' owned-by-other' : ''
      }${session.state === 'exited' ? ' exited' : ''}`}
      onClick={() => void handleClick()}
      onContextMenu={handleContextMenu}
      title={fullTitle}
    >
      <span
        ref={stateDotRef}
        className={'session-state-dot' + sessionDotClass(session, unseen)}
        style={{ backgroundColor: sessionDotColor(session, unseen) }}
        aria-label={`状态: ${session.agentPhase ?? session.state}`}
      >
        {session.state === 'exited' && session.exitCode === 0 && (
          <CheckBold size={11} className="session-state-dot-icon ok" />
        )}
        {session.state === 'exited' &&
          typeof session.exitCode === 'number' &&
          session.exitCode !== 0 && (
            <CloseBold size={11} className="session-state-dot-icon fail" />
          )}
      </span>
      {celebrate && (
        <CelebrationBurst
          play={unseen && session.agentPhase !== 'blocked'}
          anchorRef={stateDotRef}
          enabled
          themeId={themeId}
        />
      )}
      {renaming ? (
        <input
          ref={renameInputRef}
          type="text"
          className="session-name-rename-input"
          value={renameText}
          onChange={(e) => setRenameText(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commitRename();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              setRenaming(false);
            }
          }}
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <span className="session-name" title={session.displayName}>{session.displayName}</span>
      )}
      {cwdDrifted && !renaming && (
        <span className="session-cwd-drift" aria-label="当前目录已变" title={session.currentCwd}>
          <Icon name="alertTriangle" size={11} />
        </span>
      )}
      {session.state === 'exited' && !renaming && (
        <span
          className="session-exit-code"
          title={`已退出 (exitCode=${session.exitCode ?? 0})`}
        >
          <Icon name="circleDot" size={11} />
        </span>
      )}
      {ownedByOther && !renaming && (
        <span className="session-owned-by-other" title="在其他窗口持有">
          <Icon name="externalLink" size={11} />
        </span>
      )}
    </li>
  );
}

/**
 * React.memo 包裹 SessionItem — 仅当 session 引用 / myWindowId / selected
 * 任一变化时才重渲。
 *
 * 关键前提:reducer 在 sessions/state-changed 时做的是 `new Map(state.sessions)`
 * + `sessions.set(id, merged)`,**只换那个变化的 session 的引用**,其它
 * session 引用保持不变 — 默认浅比较即可正确跳过无关项重渲。
 */
const SessionItem = memo(SessionItemImpl);

/**
 * 比较两个路径是否指向同一目录。Windows 大小写无关,POSIX 大小写敏感。
 * 不做 normalize (currentCwd / originalCwd 进入 SessionInfo 之前已经 path.resolve 过)。
 */
function samePath(a: string, b: string): boolean {
  if (a === b) return true;
  // Windows 上 C:\Foo 和 c:\foo 指同一目录。SessionManager 已经把卷符大写,
  // 但 OSC 报告的 cwd 卷符大小写可能不一致,这里再松一层。
  return a.toLowerCase() === b.toLowerCase();
}

function formatPathDisplayName(node: PathNode): string {
  const leaf = lastSegmentOf(node.path);
  return leaf;
}

function lastSegmentOf(path: string): string {
  // 跨平台:取 / 或 \ 分隔的最后一段;空字符串 / 根路径回退到原路径
  const m = path.match(/[^/\\]+$/);
  return m ? m[0] : path;
}
