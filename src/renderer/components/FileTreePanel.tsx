/**
 * @file src/renderer/components/FileTreePanel.tsx
 * @purpose 侧栏底部的文件树面板,显示当前选中 session 所在目录,支持重命名。
 *
 * @关键设计:
 * - 根目录变化时靠 key 重新挂载 FileTreeBody,旧目录的异步结果随卸载丢弃。
 *   展开状态按根目录记在模块级 Map 里,切回同一 session 时不用重新展开。
 * - 刷新用 3 秒轮询加窗口聚焦,只读已展开的目录,不用 fs.watch。fs.watch 在
 *   WSL UNC 路径上不可靠,而且要管理跨窗口的监听生命周期,轮询简单得多。
 * - 慢速双击在 classifyRowClick 判定后还要等 RENAME_DELAY_MS 才进入编辑,期间
 *   再来一次点击说明用户其实在快速双击,取消重命名。
 * - 只用鼠标触发重命名,不加 F2:应用内功能键在 13.2 永远不做列表里。
 *
 * @对应文档章节: 软件定义书.md 13.2、14.6
 *
 * @不要在这里做的事:
 * - 不要打开或编辑文件内容 (内置文件编辑器永远不做)
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
} from 'react';
import { COMMAND_CHANNELS } from '@shared/protocol';
import {
  classifyRowClick,
  flattenVisibleRows,
  remapPath,
  resolveFileTreeRoot,
  type FileTreeEntry,
  type FileTreeFailure,
  type FileTreeRow,
  type LastRowClick,
  type ListDirPayload,
  type ListDirResponse,
  type RenameEntryPayload,
  type RenameEntryResponse,
} from '@shared/file-tree';
import { focusTerminalDom } from '../focus';
import { findPathNode, getSelectedSession, useAppState } from '../store';
import { useContextMenuApi } from './ContextMenu';
import { useTranslation } from './LanguageProvider';
import { ChevronRight, Draft, ExpandMore, Folder, FolderOpen } from './material-symbols';
import { useToast } from './Toast';

const POLL_INTERVAL_MS = 3000;
const RENAME_DELAY_MS = 250;
const INDENT_PX = 14;

type DirState = { entries: FileTreeEntry[]; truncated: boolean } | { failure: FileTreeFailure };

const expandedByRoot = new Map<string, ReadonlySet<string>>();

function folderLabel(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

export function FileTreePanel(): JSX.Element {
  const state = useAppState();
  const { t } = useTranslation();
  const session = getSelectedSession(state);
  const node = session ? (findPathNode(state.pathTree, session.pathId) ?? null) : null;
  const root = resolveFileTreeRoot(session, node);

  return (
    <section className="file-tree-panel" aria-label={t('fileTree.title')}>
      <div className="file-tree-header" title={root ?? undefined}>
        <Folder size={14} />
        <span className="file-tree-header-label">
          {root ? folderLabel(root) : t('fileTree.title')}
        </span>
      </div>
      {root ? (
        <FileTreeBody key={root} root={root} />
      ) : (
        <p className="file-tree-hint">
          {t(session ? 'fileTree.empty.remote' : 'fileTree.empty.noSession')}
        </p>
      )}
    </section>
  );
}

function FileTreeBody({ root }: { root: string }): JSX.Element {
  const { t } = useTranslation();
  const toast = useToast();
  const menu = useContextMenuApi();
  const [dirs, setDirs] = useState<ReadonlyMap<string, DirState>>(() => new Map());
  const [expanded, setExpandedState] = useState<ReadonlySet<string>>(
    () => expandedByRoot.get(root) ?? new Set(),
  );
  const [selected, setSelected] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameText, setRenameText] = useState('');

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

  const setExpanded = useCallback(
    (next: ReadonlySet<string>): void => {
      expandedRef.current = next;
      expandedByRoot.set(root, next);
      setExpandedState(next);
    },
    [root],
  );

  const loadDir = useCallback(
    async (dir: string): Promise<void> => {
      const seq = (loadSeqRef.current.get(dir) ?? 0) + 1;
      loadSeqRef.current.set(dir, seq);
      let res: ListDirResponse;
      try {
        res = await window.api.invoke<ListDirPayload, ListDirResponse>(
          COMMAND_CHANNELS.FS_LIST_DIR,
          { path: dir },
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
    [root, setExpanded],
  );

  const refreshAll = useCallback(async (): Promise<void> => {
    if (refreshingRef.current || document.visibilityState !== 'visible') return;
    refreshingRef.current = true;
    try {
      for (const dir of [root, ...expandedRef.current]) await loadDir(dir);
    } finally {
      refreshingRef.current = false;
    }
  }, [root, loadDir]);

  const clearRenameTimer = (): void => {
    if (renameTimerRef.current !== null) window.clearTimeout(renameTimerRef.current);
    renameTimerRef.current = null;
  };

  useEffect(() => {
    mountedRef.current = true;
    void refreshAll();
    const interval = window.setInterval(() => void refreshAll(), POLL_INTERVAL_MS);
    const onFocus = (): void => void refreshAll();
    window.addEventListener('focus', onFocus);
    return () => {
      mountedRef.current = false;
      window.clearInterval(interval);
      window.removeEventListener('focus', onFocus);
      clearRenameTimer();
    };
  }, [refreshAll]);

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

  const commitRename = async (row: FileTreeRow): Promise<void> => {
    if (renamingRef.current !== row.entry.path) return;
    endRename();
    // 先还焦点再等结果:链接慢时用户可能已开始下一次重命名,等完再还会抢走它的焦点
    focusTerminalDom();
    const newName = renameText.trim();
    if (newName && newName !== row.entry.name) await applyRename(row, newName);
  };

  const handleRowClick = (e: MouseEvent<HTMLDivElement>, row: FileTreeRow): void => {
    const { entry } = row;
    clearRenameTimer();
    const now = Date.now();
    const onName = (e.target as Element).closest('.file-tree-name') !== null;
    const action = classifyRowClick(lastClickRef.current, entry.path, now, onName);
    lastClickRef.current = { path: entry.path, at: now };
    if (action === 'ignore') return;
    if (action === 'rename') {
      renameTimerRef.current = window.setTimeout(() => beginRename(entry), RENAME_DELAY_MS);
      return;
    }
    setSelected(entry.path);
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
    menu.open({
      x: e.clientX,
      y: e.clientY,
      items: [{ label: t('fileTree.rename'), onSelect: () => beginRename(row.entry) }],
    });
  };

  const rootHint = hintFor(dirs.get(root));

  return (
    <div className="file-tree-list" role="tree">
      {rootHint && <p className="file-tree-hint">{rootHint}</p>}
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
                <span className="file-tree-chevron" onClick={(e) => handleChevronClick(e, row)}>
                  {isExpanded ? <ExpandMore size={16} /> : <ChevronRight size={16} />}
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
