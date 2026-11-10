/**
 * @file src/renderer/components/FileTreePanel.tsx
 * @purpose 侧栏底部的文件树面板,显示当前选中 session 所在目录。本地目录支持重命名和
 *   新建空文件,SSH session 通过 SFTP 只读浏览。点击 PDF、图片或 markdown 在终端区域打开。
 *
 * @关键设计:
 * - 根目录变化时靠 key 重新挂载 FileTreeBody,旧目录的异步结果随卸载丢弃。
 *   展开状态按根目录记在模块级 Map 里,切回同一 session 时不用重新展开。
 * - 刷新用 3 秒轮询加窗口聚焦,只读已展开的目录,不用 fs.watch。fs.watch 在
 *   WSL UNC 路径上不可靠,而且要管理跨窗口的监听生命周期,轮询简单得多。
 * - SFTP 登录提示只在用户能看到结果的请求上允许(interactive):首次挂载、点重试、
 *   点击文件。定时轮询永远安静,服务器的提示不会在用户没操作时凭空弹出。
 * - 慢速双击在 classifyRowClick 判定后还要等 RENAME_DELAY_MS 才进入编辑,期间
 *   再来一次点击说明用户其实在快速双击,取消重命名。
 * - 只用鼠标触发重命名,不加 F2:应用内功能键在 13.2 永远不做列表里。
 * - 置顶文件夹 (file-tree-pins.ts) 以小方块显示在标题下面。点一下文件树临时切到
 *   那个文件夹,再点一下或 session 的目录变了就回到 session 的目录。
 * - New file comes from the header + button or the right-click menu, never a shortcut. The
 *   name is typed in a row inside the target folder, so the user sees where it will land.
 *   A new file the viewer can show opens at once, so a .txt or .json is ready to type into.
 * - Local folders (rows, the header, pinned blocks, the blank area) have "Open in File
 *   Explorer", which opens the folder itself; a local file has "Show in File Explorer",
 *   which selects it. SFTP paths are on another machine, so they get neither.
 * - Delete (local only, 14.6 例外 2026-11-10) moves the entry to the Recycle Bin. There is no
 *   confirm dialog because the bin is the undo; the item's hint says so.
 *
 * @对应文档章节: 软件定义书.md 13.2、14.6
 *
 * @不要在这里做的事:
 * - 不要在这里编辑文件内容。点击后的显示和文本编辑在 PdfOverlay 和 TextFileView
 * - 不要自己拼接路径,路径一律用 main 返回的绝对路径
 */
import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type PointerEvent,
} from 'react';
import { COMMAND_CHANNELS } from '@shared/protocol';
import {
  classifyRowClick,
  flattenVisibleRows,
  fileViewKind,
  remapPath,
  resolveFileTreeRoot,
  type DirFailure,
  type FileTreeEntry,
  type FileTreeRow,
  type LastRowClick,
  type ListDirPayload,
  type ListDirResponse,
  type CreateFilePayload,
  type CreateFileResponse,
  type DeleteEntryPayload,
  type DeleteEntryResponse,
  type RenameEntryPayload,
  type RenameEntryResponse,
} from '@shared/file-tree';
import { focusTerminalDom } from '../focus';
import { folderPdfKey, openPdf } from '../pdf-view-store';
import {
  findPathNode,
  getDisplayableSession,
  getSelectedSession,
  type AppState,
  useAppState,
} from '../store';
import {
  isPinned,
  remapLocalPins,
  samePin,
  togglePin,
  useFolderPins,
  type FolderPin,
} from '../file-tree-pins';
import { useContextMenuApi, type ContextMenuItem } from './ContextMenu';
import { useTranslation } from './LanguageProvider';
import { Add, ChevronRight, Draft, Folder, FolderOpen } from './material-symbols';
import { useToast } from './Toast';

const POLL_INTERVAL_MS = 3000;
/** 远端每轮都要走网络,慢一些。 */
const REMOTE_POLL_INTERVAL_MS = 10_000;
const RENAME_DELAY_MS = 250;
const INDENT_PX = 14;

type DirState = { entries: FileTreeEntry[]; truncated: boolean } | { failure: DirFailure };

interface FileTreeBodyProps {
  root: string;
  /** Where a clicked PDF is shown, see pdfViewKey. Null when nothing can show it. */
  pdfViewKey: string | null;
  /** 有值时是 SFTP 浏览,只读 */
  sshProfileId: string | undefined;
  /** Goes up by one each time the header + button is pressed */
  newFileRequest: number;
}

const expandedByRoot = new Map<string, ReadonlySet<string>>();

function folderLabel(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function pinFor(path: string, sshProfileId: string | undefined): FolderPin {
  return sshProfileId ? { path, sshProfileId } : { path };
}

/**
 * Menu item for a local path: a folder opens in File Explorer, a file is selected in its
 * folder. SFTP paths live on another machine, so callers leave this item out for them.
 */
function explorerItem(
  path: string,
  isDirectory: boolean,
  label: string,
  onError: (message: string) => void,
): ContextMenuItem {
  return {
    label,
    onSelect: () => {
      window.api
        .invoke(COMMAND_CHANNELS.SYSTEM_SHOW_IN_EXPLORER, { path, open: isDirectory })
        .catch((err: unknown) =>
          onError(`${label}: ${err instanceof Error ? err.message : String(err)}`),
        );
    },
  };
}

export function FileTreePanel(): JSX.Element {
  const state = useAppState();
  const { t } = useTranslation();
  const session = getSelectedSession(state);
  // A clicked folder shows its files straight away, before any terminal is open in it.
  const pathId = session?.pathId ?? state.selectedPathId;
  const node = pathId ? (findPathNode(state.pathTree, pathId) ?? null) : null;
  const root = session ? resolveFileTreeRoot(session, node) : (node?.path ?? null);
  const sessionSshProfileId = node?.kind === 'ssh' ? node.sshProfileId : undefined;
  const { height, handleProps } = useResizableHeight();
  const [newFileRequest, setNewFileRequest] = useState(0);
  const pins = useFolderPins();
  const menu = useContextMenuApi();
  const toast = useToast();
  const toastError = (message: string): void => toast.push({ kind: 'error', message });
  // 点过的置顶只在 session 目录不变时有效,cd 或切 session 后自动回到 session 的目录
  const baseKey = `${sessionSshProfileId ?? ''}|${session?.id ?? ''}|${root ?? ''}`;
  const [jump, setJump] = useState<{ baseKey: string; pin: FolderPin } | null>(null);
  const activePin = jump && jump.baseKey === baseKey && isPinned(pins, jump.pin) ? jump.pin : null;
  const shownRoot = activePin ? activePin.path : root;
  const sshProfileId = activePin ? activePin.sshProfileId : sessionSshProfileId;

  const openPinMenu = (e: MouseEvent<HTMLElement>, pin: FolderPin): void => {
    e.preventDefault();
    e.stopPropagation();
    menu.open({
      x: e.clientX,
      y: e.clientY,
      items: [
        {
          label: t(isPinned(pins, pin) ? 'fileTree.unpin' : 'fileTree.pin'),
          onSelect: () => togglePin(pin),
        },
        ...(pin.sshProfileId
          ? []
          : [explorerItem(pin.path, true, t('fileTree.openInExplorer'), toastError)]),
      ],
    });
  };

  return (
    <>
      <div
        className="file-tree-resize"
        role="separator"
        aria-orientation="horizontal"
        title={t('fileTree.resize')}
        {...handleProps}
      />
      <section
        className="file-tree-panel"
        aria-label={t('fileTree.title')}
        style={height === null ? undefined : { flexBasis: height }}
      >
        <div
          className="file-tree-header"
          title={shownRoot ?? undefined}
          onContextMenu={(e) => {
            if (shownRoot) openPinMenu(e, pinFor(shownRoot, sshProfileId));
          }}
        >
          <Folder size={14} />
          <span className="file-tree-header-label">
            {shownRoot ? folderLabel(shownRoot) : t('fileTree.title')}
          </span>
          {shownRoot && !sshProfileId && (
            <button
              type="button"
              className="file-tree-header-btn"
              title={t('fileTree.newFile')}
              aria-label={t('fileTree.newFile')}
              onClick={() => setNewFileRequest((n) => n + 1)}
            >
              <Add size={16} />
            </button>
          )}
        </div>
        {pins.length > 0 && (
          <div className="file-tree-pins" role="toolbar" aria-label={t('fileTree.pins')}>
            {pins.map((pin) => {
              const active = activePin !== null && samePin(activePin, pin);
              return (
                <button
                  key={`${pin.sshProfileId ?? ''}|${pin.path}`}
                  type="button"
                  className={`file-tree-pin${active ? ' active' : ''}`}
                  aria-pressed={active}
                  title={pin.path}
                  onClick={() => {
                    setJump(active ? null : { baseKey, pin });
                    focusTerminalDom();
                  }}
                  onContextMenu={(e) => openPinMenu(e, pin)}
                >
                  {folderLabel(pin.path)}
                </button>
              );
            })}
          </div>
        )}
        {shownRoot ? (
          <FileTreeBody
            key={`${sshProfileId ?? ''}|${shownRoot}`}
            root={shownRoot}
            pdfViewKey={pdfViewKey(state)}
            sshProfileId={sshProfileId}
            newFileRequest={newFileRequest}
          />
        ) : (
          <p className="file-tree-hint">{t('fileTree.empty.noSession')}</p>
        )}
      </section>
    </>
  );
}

/** Where a clicked PDF is shown: over the terminal on screen, else over the new tab page. */
function pdfViewKey(state: AppState): string | null {
  const session = getDisplayableSession(state);
  if (session) return session.id;
  return state.selectedPathId ? folderPdfKey(state.selectedPathId) : null;
}

const HEIGHT_KEY = 'ceteris.sidebar.fileTreeHeight';
const MIN_HEIGHT = 120;
/** What must stay visible above the panel, so folders can always be reached. */
const MIN_ABOVE = 180;

function readHeight(): number | null {
  try {
    const value = Number(window.localStorage?.getItem(HEIGHT_KEY));
    return value >= MIN_HEIGHT ? value : null;
  } catch {
    return null;
  }
}

function saveHeight(value: number | null): void {
  try {
    if (value === null) window.localStorage?.removeItem(HEIGHT_KEY);
    else window.localStorage?.setItem(HEIGHT_KEY, String(value));
  } catch {
    // Only a remembered height is lost, so nothing needs reporting.
  }
}

/** Drag the handle to resize, double-click to go back to the default height. */
function useResizableHeight(): {
  height: number | null;
  handleProps: {
    onPointerDown: (e: PointerEvent<HTMLDivElement>) => void;
    onDoubleClick: () => void;
  };
} {
  const [height, setHeight] = useState<number | null>(readHeight);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>): void => {
    const handle = e.currentTarget;
    const panel = handle.nextElementSibling as HTMLElement;
    const sidebar = handle.closest('.sidebar') as HTMLElement;
    const startY = e.clientY;
    const startHeight = panel.getBoundingClientRect().height;
    const max = Math.max(MIN_HEIGHT, sidebar.clientHeight - MIN_ABOVE);
    let latest = startHeight;
    handle.setPointerCapture(e.pointerId);
    handle.classList.add('dragging');

    const move = (ev: globalThis.PointerEvent): void => {
      latest = Math.min(max, Math.max(MIN_HEIGHT, startHeight + startY - ev.clientY));
      setHeight(latest);
    };
    const end = (): void => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
      handle.classList.remove('dragging');
      saveHeight(Math.round(latest));
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  };

  const onDoubleClick = (): void => {
    setHeight(null);
    saveHeight(null);
  };

  return { height, handleProps: { onPointerDown, onDoubleClick } };
}

function FileTreeBody({
  root,
  pdfViewKey: pdfKey,
  sshProfileId,
  newFileRequest,
}: FileTreeBodyProps): JSX.Element {
  const expansionKey = `${sshProfileId ?? ''}|${root}`;
  const { t } = useTranslation();
  const toast = useToast();
  const toastError = (message: string): void => toast.push({ kind: 'error', message });
  const menu = useContextMenuApi();
  const pins = useFolderPins();
  const [dirs, setDirs] = useState<ReadonlyMap<string, DirState>>(() => new Map());
  const [expanded, setExpandedState] = useState<ReadonlySet<string>>(
    () => expandedByRoot.get(expansionKey) ?? new Set(),
  );
  const [selected, setSelected] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameText, setRenameText] = useState('');
  /** The folder showing the new file name row, or null */
  const [creatingIn, setCreatingIn] = useState<string | null>(null);
  const [createText, setCreateText] = useState('');

  const expandedRef = useRef(expanded);
  // 回车提交后输入框卸载可能再触发 blur,用 ref 保证同一次重命名只提交一遍
  const renamingRef = useRef<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const lastClickRef = useRef<LastRowClick | null>(null);
  const renameTimerRef = useRef<number | null>(null);
  const refreshingRef = useRef(false);
  const mountedRef = useRef(false);
  // 每个目录只采用最新一次请求的结果,否则改名前发出的轮询会把旧名字写回来
  const loadSeqRef = useRef(new Map<string, number>());
  // Same guard as renamingRef: Enter, then the blur from unmounting, must create only once
  const creatingRef = useRef<string | null>(null);
  // The + press already handled, so a remount after cd does not open a new row
  const handledNewFileRef = useRef(newFileRequest);

  const setExpanded = useCallback(
    (next: ReadonlySet<string>): void => {
      expandedRef.current = next;
      expandedByRoot.set(expansionKey, next);
      setExpandedState(next);
    },
    [expansionKey],
  );

  const loadDir = useCallback(
    async (
      dir: string,
      options: { fresh?: boolean; interactive?: boolean } = {},
    ): Promise<void> => {
      const seq = (loadSeqRef.current.get(dir) ?? 0) + 1;
      loadSeqRef.current.set(dir, seq);
      let res: ListDirResponse;
      try {
        res = await window.api.invoke<ListDirPayload, ListDirResponse>(
          COMMAND_CHANNELS.FS_LIST_DIR,
          { path: dir, ...(sshProfileId ? { sshProfileId, ...options } : {}) },
        );
      } catch {
        // Link 断线时 invoke 会 reject,当作普通失败显示,不打断轮询
        res = { ok: false, reason: 'unknown' };
      }
      if (!mountedRef.current || loadSeqRef.current.get(dir) !== seq) return;
      if (!res.ok && res.reason === 'not-found' && dir !== root) {
        const next = new Set(expandedRef.current);
        if (next.delete(dir)) setExpanded(next);
      }
      const nextState: DirState = res.ok
        ? { entries: res.entries, truncated: res.truncated }
        : { failure: res.reason };
      // 内容没变就保留旧 Map,轮询才不会每 3 秒重渲染整棵树
      setDirs((prev) =>
        JSON.stringify(prev.get(dir)) === JSON.stringify(nextState)
          ? prev
          : new Map(prev).set(dir, nextState),
      );
    },
    [root, sshProfileId, setExpanded],
  );

  const refreshAll = useCallback(
    async (options: { interactive?: boolean } = {}): Promise<void> => {
      if (refreshingRef.current || document.visibilityState !== 'visible') return;
      refreshingRef.current = true;
      try {
        for (const dir of [root, ...expandedRef.current]) await loadDir(dir, options);
      } finally {
        refreshingRef.current = false;
      }
    },
    [root, loadDir],
  );

  const clearRenameTimer = (): void => {
    if (renameTimerRef.current !== null) window.clearTimeout(renameTimerRef.current);
    renameTimerRef.current = null;
  };

  useEffect(() => {
    mountedRef.current = true;
    // 挂载时不传 fresh:切 tab 或 cd 都会重新挂载,自动重试等于反复登录。
    // 失败后显示缓存的原因,由重试按钮决定何时再登录。
    // 但挂载是用户切过来的结果,允许弹登录提示;定时轮询和聚焦刷新则保持安静
    void refreshAll({ interactive: true });
    const interval = window.setInterval(
      () => void refreshAll(),
      sshProfileId ? REMOTE_POLL_INTERVAL_MS : POLL_INTERVAL_MS,
    );
    const onFocus = (): void => void refreshAll();
    window.addEventListener('focus', onFocus);
    return () => {
      mountedRef.current = false;
      window.clearInterval(interval);
      window.removeEventListener('focus', onFocus);
      clearRenameTimer();
    };
  }, [refreshAll, sshProfileId]);

  const rows = useMemo(() => {
    const entriesByDir = new Map<string, FileTreeEntry[]>();
    for (const [dir, value] of dirs) {
      if ('entries' in value) entriesByDir.set(dir, value.entries);
    }
    return flattenVisibleRows(root, entriesByDir, expanded);
  }, [root, dirs, expanded]);

  const hintFor = (dir: DirState | undefined): string | null => {
    if (!dir) return null;
    if ('failure' in dir) return t(`fileTree.error.${dir.failure}`);
    if (dir.truncated) return t('fileTree.truncated', { count: dir.entries.length });
    return dir.entries.length === 0 ? t('fileTree.empty.folder') : null;
  };

  const toggleFolder = (path: string): void => {
    const next = new Set(expanded);
    if (next.delete(path)) {
      setExpanded(next);
      return;
    }
    next.add(path);
    setExpanded(next);
    void loadDir(path);
  };

  const beginRename = (entry: FileTreeEntry): void => {
    clearRenameTimer();
    renamingRef.current = entry.path;
    setSelected(entry.path);
    setRenameText(entry.name);
    setRenaming(entry.path);
    requestAnimationFrame(() => {
      const input = inputRef.current;
      if (!input) return;
      input.focus();
      // 和资源管理器一样,文件只选中主文件名,改名时不会误删扩展名
      const dot = entry.isDirectory ? -1 : entry.name.lastIndexOf('.');
      input.setSelectionRange(0, dot > 0 ? dot : entry.name.length);
    });
  };

  const endRename = (): void => {
    renamingRef.current = null;
    lastClickRef.current = null;
    setRenaming(null);
  };

  const applyRename = async (row: FileTreeRow, newName: string): Promise<void> => {
    const oldPath = row.entry.path;
    const res = await window.api
      .invoke<RenameEntryPayload, RenameEntryResponse>(COMMAND_CHANNELS.FS_RENAME, {
        path: oldPath,
        newName,
      })
      .catch((): RenameEntryResponse => ({ ok: false, reason: 'unknown' }));
    if (!mountedRef.current) return;
    if (!res.ok) {
      toast.push({
        kind: 'error',
        message: t(`fileTree.rename.error.${res.reason}`, { name: newName }),
      });
      return;
    }
    setExpanded(new Set([...expandedRef.current].map((p) => remapPath(p, oldPath, res.path))));
    remapLocalPins((p) => remapPath(p, oldPath, res.path));
    setSelected((prev) => (prev === null ? prev : remapPath(prev, oldPath, res.path)));
    setDirs((prev) => {
      const next = new Map(prev);
      for (const dir of prev.keys()) {
        if (remapPath(dir, oldPath, res.path) !== dir) next.delete(dir);
      }
      return next;
    });
    await loadDir(row.parentPath);
    void refreshAll();
  };

  /**
   * Moves a row to the Recycle Bin. No confirm dialog: the bin is the undo, and the menu
   * item says where the entry goes. Pins to a deleted folder stay, so restoring it from the
   * bin brings the pin back to life.
   */
  const applyDelete = async (row: FileTreeRow): Promise<void> => {
    const { path, name } = row.entry;
    const res = await window.api
      .invoke<DeleteEntryPayload, DeleteEntryResponse>(COMMAND_CHANNELS.FS_DELETE, { path })
      .catch((): DeleteEntryResponse => ({ ok: false, reason: 'unknown' }));
    if (!mountedRef.current) return;
    if (!res.ok) {
      toast.push({ kind: 'error', message: t(`fileTree.delete.error.${res.reason}`, { name }) });
      return;
    }
    toast.push({ kind: 'success', message: t('fileTree.delete.done', { name }) });
    // remapPath changes exactly the paths at or under `path`, so this drops the deleted
    // folder and everything below it from the expanded set and the listing cache.
    const isGone = (p: string): boolean => remapPath(p, path, '') !== p;
    setExpanded(new Set([...expandedRef.current].filter((p) => !isGone(p))));
    setSelected((prev) => (prev !== null && isGone(prev) ? null : prev));
    setDirs((prev) => new Map([...prev].filter(([dir]) => !isGone(dir))));
    await loadDir(row.parentPath);
  };

  const commitRename = async (row: FileTreeRow): Promise<void> => {
    if (renamingRef.current !== row.entry.path) return;
    endRename();
    // 先还焦点再等结果:链接慢时用户可能已开始下一次重命名,等完再还会抢走它的焦点
    focusTerminalDom();
    const newName = renameText.trim();
    if (newName && newName !== row.entry.name) await applyRename(row, newName);
  };

  const beginCreate = (dir: string): void => {
    clearRenameTimer();
    endRename();
    if (dir !== root && !expandedRef.current.has(dir)) {
      setExpanded(new Set(expandedRef.current).add(dir));
      void loadDir(dir);
    }
    creatingRef.current = dir;
    setCreateText('');
    setCreatingIn(dir);
  };

  const endCreate = (): void => {
    creatingRef.current = null;
    setCreatingIn(null);
  };

  const commitCreate = async (dir: string): Promise<void> => {
    if (creatingRef.current !== dir) return;
    endCreate();
    const name = createText.trim();
    if (!name) {
      focusTerminalDom();
      return;
    }
    const res = await window.api
      .invoke<CreateFilePayload, CreateFileResponse>(COMMAND_CHANNELS.FS_CREATE_FILE, {
        dirPath: dir,
        name,
      })
      .catch((): CreateFileResponse => ({ ok: false, reason: 'unknown' }));
    if (!mountedRef.current) return;
    if (!res.ok) {
      toast.push({ kind: 'error', message: t(`fileTree.create.error.${res.reason}`, { name }) });
      focusTerminalDom();
      return;
    }
    setSelected(res.path);
    await loadDir(dir);
    if (fileViewKind(name) && pdfKey) {
      void openPdf(pdfKey, { name, path: res.path });
      return;
    }
    focusTerminalDom();
  };

  /** A folder row gets the file inside it; a file row gets it beside itself. */
  const createTargetOf = (row: FileTreeRow | undefined): string =>
    !row ? root : row.entry.isDirectory ? row.entry.path : row.parentPath;

  useEffect(() => {
    if (newFileRequest === handledNewFileRef.current) return;
    handledNewFileRef.current = newFileRequest;
    beginCreate(createTargetOf(rows.find((r) => r.entry.path === selected)));
    // Only a new press opens the row; a change of selection or rows must not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newFileRequest]);

  const handleRowClick = (e: MouseEvent<HTMLDivElement>, row: FileTreeRow): void => {
    const { entry } = row;
    clearRenameTimer();
    const now = Date.now();
    const onName = (e.target as Element).closest('.file-tree-name') !== null;
    const action = classifyRowClick(lastClickRef.current, entry.path, now, onName);
    lastClickRef.current = { path: entry.path, at: now };
    if (action === 'ignore') return;
    if (action === 'rename' && !sshProfileId) {
      renameTimerRef.current = window.setTimeout(() => beginRename(entry), RENAME_DELAY_MS);
      return;
    }
    setSelected(entry.path);
    if (!entry.isDirectory && fileViewKind(entry.name) && pdfKey) {
      void openPdf(pdfKey, {
        name: entry.name,
        path: entry.path,
        ...(sshProfileId ? { sshProfileId } : {}),
      });
      return;
    }
    if (entry.isDirectory) toggleFolder(entry.path);
    focusTerminalDom();
  };

  const handleChevronClick = (e: MouseEvent<HTMLSpanElement>, row: FileTreeRow): void => {
    // 点箭头只折叠展开,不计入慢速双击,否则连点箭头会误入重命名
    e.stopPropagation();
    clearRenameTimer();
    lastClickRef.current = null;
    setSelected(row.entry.path);
    toggleFolder(row.entry.path);
    focusTerminalDom();
  };

  const handleContextMenu = (e: MouseEvent<HTMLDivElement>, row: FileTreeRow): void => {
    e.preventDefault();
    e.stopPropagation();
    clearRenameTimer();
    setSelected(row.entry.path);
    const items: ContextMenuItem[] = [];
    if (row.entry.isDirectory) {
      const pin = pinFor(row.entry.path, sshProfileId);
      items.push({
        label: t(isPinned(pins, pin) ? 'fileTree.unpin' : 'fileTree.pin'),
        onSelect: () => togglePin(pin),
      });
    }
    // 远端文件树只读,不能新建或改名;远端路径在另一台机器上,也不能在 Explorer 里打开
    if (!sshProfileId) {
      const { path, isDirectory } = row.entry;
      items.push(
        { label: t('fileTree.newFile'), onSelect: () => beginCreate(createTargetOf(row)) },
        { label: t('fileTree.rename'), onSelect: () => beginRename(row.entry) },
        explorerItem(
          path,
          isDirectory,
          t(isDirectory ? 'fileTree.openInExplorer' : 'fileTree.showInExplorer'),
          toastError,
        ),
        { divider: true, label: '' },
        {
          label: t('fileTree.delete'),
          hint: t('fileTree.delete.hint'),
          danger: true,
          onSelect: () => void applyDelete(row),
        },
      );
    }
    if (items.length > 0) menu.open({ x: e.clientX, y: e.clientY, items });
  };

  /** Right-click below the rows: a new file in the top folder. */
  const handleBlankContextMenu = (e: MouseEvent<HTMLDivElement>): void => {
    e.preventDefault();
    if (sshProfileId) return;
    menu.open({
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: t('fileTree.newFile'), onSelect: () => beginCreate(root) },
        explorerItem(root, true, t('fileTree.openInExplorer'), toastError),
      ],
    });
  };

  const newFileRow = (dir: string, depth: number): JSX.Element | null =>
    creatingIn !== dir ? null : (
      <div className="file-tree-row" style={{ paddingLeft: `${6 + depth * INDENT_PX}px` }}>
        <span className="file-tree-chevron placeholder" />
        <Draft size={14} className="file-tree-icon" />
        <input
          autoFocus
          type="text"
          className="path-name-rename-input"
          aria-label={t('fileTree.newFile')}
          placeholder={t('fileTree.newFile.placeholder')}
          value={createText}
          onChange={(e) => setCreateText(e.target.value)}
          onBlur={() => {
            // Same rule as rename: switching windows must not create a half typed name
            if (document.hasFocus()) void commitCreate(dir);
          }}
          onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
            if (e.key === 'Enter') {
              e.preventDefault();
              void commitCreate(dir);
            } else if (e.key === 'Escape') {
              e.preventDefault();
              endCreate();
              focusTerminalDom();
            }
          }}
        />
      </div>
    );

  const rootState = dirs.get(root);
  const rootHint = !rootState && sshProfileId ? t('fileTree.connecting') : hintFor(rootState);

  return (
    <div className="file-tree-list" role="tree" onContextMenu={handleBlankContextMenu}>
      {newFileRow(root, 0)}
      {rootHint && <p className="file-tree-hint">{rootHint}</p>}
      {sshProfileId && rootState && 'failure' in rootState && (
        <button
          type="button"
          className="file-tree-retry"
          onClick={() => void loadDir(root, { fresh: true, interactive: true })}
        >
          {t('fileTree.retry')}
        </button>
      )}
      {rows.map((row) => {
        const { entry, depth } = row;
        const isExpanded = entry.isDirectory && expanded.has(entry.path);
        const hint = isExpanded ? hintFor(dirs.get(entry.path)) : null;
        const FileIcon = !entry.isDirectory ? Draft : isExpanded ? FolderOpen : Folder;
        return (
          <Fragment key={entry.path}>
            <div
              className={`file-tree-row${selected === entry.path ? ' selected' : ''}`}
              role="treeitem"
              aria-selected={selected === entry.path}
              aria-expanded={entry.isDirectory ? isExpanded : undefined}
              style={{ paddingLeft: `${6 + depth * INDENT_PX}px` }}
              title={entry.path}
              onClick={(e) => handleRowClick(e, row)}
              onContextMenu={(e) => handleContextMenu(e, row)}
            >
              {entry.isDirectory ? (
                <span
                  className={`file-tree-chevron${isExpanded ? ' expanded' : ''}`}
                  onClick={(e) => handleChevronClick(e, row)}
                >
                  {/* 一个箭头旋转 90 度表示展开,见 motion.css */}
                  <ChevronRight size={16} />
                </span>
              ) : (
                <span className="file-tree-chevron placeholder" />
              )}
              <FileIcon size={14} className="file-tree-icon" />
              {renaming === entry.path ? (
                <input
                  ref={inputRef}
                  type="text"
                  className="path-name-rename-input"
                  aria-label={t('fileTree.rename')}
                  value={renameText}
                  onChange={(e) => setRenameText(e.target.value)}
                  onBlur={() => {
                    // 切到别的窗口也会 blur。这里提交的是磁盘改名,不能把打到一半的名字写下去
                    if (document.hasFocus()) void commitRename(row);
                  }}
                  onClick={(e) => e.stopPropagation()}
                  onContextMenu={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    // 输入法组合期间的回车是确认候选词,不是提交重命名
                    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      void commitRename(row);
                    } else if (e.key === 'Escape') {
                      e.preventDefault();
                      endRename();
                      focusTerminalDom();
                    }
                  }}
                />
              ) : (
                <span className="file-tree-name">{entry.name}</span>
              )}
            </div>
            {isExpanded && newFileRow(entry.path, depth + 1)}
            {hint && (
              <p
                className="file-tree-hint nested"
                style={{ paddingLeft: `${6 + (depth + 1) * INDENT_PX}px` }}
              >
                {hint}
              </p>
            )}
          </Fragment>
        );
      })}
    </div>
  );
}
