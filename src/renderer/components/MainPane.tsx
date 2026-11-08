/**
 * @file src/renderer/components/MainPane.tsx
 * @purpose 右侧主区域:TabBar (当前 path 下的 sessions) + 终端区
 *   (本窗口持有的 session 显示 xterm,否则显示新建终端页面)。
 *
 * @关键设计 (CP-2 勘误后):
 * - "持有 = 显示" 不变量:TerminalView 只在 displayableSession (即 selected
 *   且 owner=myWindow 的) 不为 null 时挂载。selected 但 owner != myWindow
 *   (orphan / 他人持有) 时显示 EmptyPathState 新建终端页 — 没有"接管会话"
 *   占位 UI (用户勘误反思 #3)
 * - TabBar 顺序稳定:本窗口持有的 + orphan 按 path 下 sessions 的原始顺序
 *   排列;只把"其他窗口持有"的单独抽到最右端灰显 (用户勘误 #1)
 *   Tab 自己根据 session.ownerWindowId 决定 variant
 * - SESSION_CREATE 调用统一从 state.lastTerminalDims 读 cols/rows,避免
 *   spawn 80×24 然后 resize 到 142×42 触发的 ConPTY 重画 PowerShell 横幅
 *   (用户勘误 #2)
 * - main-pane 容器挂 ResizeObserver,持续把粗估的 cols/rows 写进 store
 *   (字号 × 0.6 估字宽,字号 × lineHeight 估行高);TerminalView 第一次
 *   xterm fit 后会用真实值覆盖
 *
 * @对应文档章节: 软件定义书.md 6.3 (右侧标签页)、6.4 (终端区域)
 */
import {
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  type DragEvent,
} from 'react';
import {
  COMMAND_CHANNELS,
  type AgentVersionInfo,
  type CreateSessionResponse,
  type ListAgentVersionsResponse,
  type ListShellsResponse,
  type UpgradeAgentPayload,
  type FocusSessionOwnerResponse,
} from '@shared/protocol';
import { formatPathDisplayPath } from '@shared/path-display';
import type { Point } from '@shared/quick-launch';
import type { SessionInfo, Template } from '@shared/types';
import {
  findMyOwnedSessionId,
  getEffectivePaneLayout,
  getPaneSlots,
  findPathNode,
  getDisplayableSession,
  getSessionsInSelectedPath,
  useAppDispatch,
  useAppState,
} from '../store';
import { PaneLayoutBar } from './PaneLayoutBar';
import { PATH_DRAG_TYPE } from './path-drag';
import { PdfOverlay } from './PdfOverlay';
import { TerminalView } from './TerminalView';
import {
  closePdf,
  folderPdfKey,
  movePdfView,
  prunePdfViews,
  usePdfView,
} from '../pdf-view-store';
import { focusTerminalDom } from '../focus';
import { Icon } from './icons';
import { TemplateIcon } from './TemplateIcon';
import { useContextMenuApi } from './ContextMenu';
import { useToast } from './Toast';
import {
  filterShellsForWslPath,
  getWslDistroName,
  shellIcon,
  type DetectedShell,
} from './launch-options';
import { QuickLaunchOverlay } from './QuickLaunchOverlay';
import { useModal } from './Modal';
import { useCopyToClipboard } from '../hooks/useCopyToClipboard';
import { buildSessionContextMenu } from './sessionContextMenu';
import { useTranslation } from './LanguageProvider';

// ── 终端尺寸估算用常量(P2-25) ──
// 这是"PTY spawn 前的兜底估算":xterm 实际 mount 后由 fitAddon 写回真实
// cols/rows,本估算只在 SESSION_CREATE 还没拿到真实尺寸时给一个合理初值。
//
// MONO_CHAR_ASPECT:等宽字符宽 / 字号 的经验比例。Cascadia / JBM / consolas
// 等程序员字体在多数字号下宽高比稳定在 0.55-0.62 之间,取 0.6 是中位估值。
// 即便偏离 ±10%,估算的 cols 偏差也只是 ±10% — fitAddon mount 后立即纠正。
const MONO_CHAR_ASPECT = 0.6;
// TerminalView 容器周围的固定 chrome:左右各 ~12px 内边距,顶部 tabbar 32px +
// statusbar 24px = 56px。这两个常量配合容器 clientWidth/Height 估出可用区域。
const TERMINAL_HOST_PADDING_X = 24;
const TERMINAL_HOST_CHROME_Y = 56;
// 兜底下限:就算容器尺寸异常(0 或负),也至少给 PTY 一个 spawn 能跑起来的初值。
const MIN_COLS = 20;
const MIN_ROWS = 5;

// builtinTemplateIcon 已抽到 TemplateIcon 组件复用(P2-14)。

export function MainPane(): JSX.Element {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const sessions = getSessionsInSelectedPath(state);

  useEffect(() => {
    prunePdfViews((id) => state.sessions.has(id) || !!findPathNode(state.pathTree, id));
  }, [state.sessions, state.pathTree]);
  const displayable = getDisplayableSession(state);
  const layout = getEffectivePaneLayout(state);
  const slots = getPaneSlots(state);

  // A file open in a folder stays on screen when a terminal opens there, if the two fit side
  // by side. With no room it closes: the terminal just opened must be what the user sees.
  const selectedPathId = state.selectedPathId;
  const displayableId = displayable?.id ?? null;
  const hasEmptySlot = slots.includes(null);
  const fitsBeside = layout === 'single' || hasEmptySlot;
  useEffect(() => {
    if (!displayableId || !selectedPathId) return;
    const key = folderPdfKey(selectedPathId);
    if (fitsBeside) movePdfView(key, displayableId);
    else closePdf(key);
  }, [displayableId, selectedPathId, fitsBeside]);

  // A file must not hide the only terminal while a pane next to it stands empty.
  const hasSelectedView = usePdfView(displayableId ?? '') !== null;
  const spareSlot = layout !== 'single' && hasSelectedView ? slots.indexOf(null) : -1;
  const myWindowId = state.myWindowId;

  // When the selection moves between panes without a click, such as the selected pane
  // closing, nothing else gives the keyboard to the new pane.
  const selectedSessionId = state.selectedSessionId;
  useEffect(() => {
    if (layout !== 'single' && selectedSessionId) focusTerminalDom();
  }, [layout, selectedSessionId]);

  // Panes hold their sessions: the main process must not release one when another pane
  // claims, and a pane cannot receive output or input until its session is ours.
  const paneIds = layout === 'single' ? [] : slots.flatMap((s) => (s ? [s.id] : []));
  const paneKey = paneIds.join(',');
  const orphanKey =
    layout === 'single'
      ? ''
      : slots.flatMap((s) => (s && s.ownerWindowId === null ? [s.id] : [])).join(',');
  const failedClaims = useRef(new Set<string>());
  const [pathDragOver, setPathDragOver] = useState(false);
  const toast = useToast();

  useEffect(() => {
    window.api
      .invoke(COMMAND_CHANNELS.SESSION_SET_PANE_SESSIONS, {
        sessionIds: paneKey ? paneKey.split(',') : [],
      })
      .catch((err) => console.error('[MainPane] set-pane-sessions failed', err));
  }, [paneKey]);

  useEffect(() => {
    if (!orphanKey) return;
    for (const sessionId of orphanKey.split(',')) {
      if (failedClaims.current.has(sessionId)) continue;
      dispatch({ type: 'sessions/owner-changed', sessionId, ownerWindowId: myWindowId });
      window.api.invoke(COMMAND_CHANNELS.SESSION_CLAIM, { sessionId }).catch((err) => {
        console.error('[MainPane] pane claim failed', err);
        failedClaims.current.add(sessionId);
        dispatch({ type: 'sessions/owner-changed', sessionId, ownerWindowId: null });
      });
    }
  }, [orphanKey, myWindowId, dispatch]);

  const containerRef = useRef<HTMLElement | null>(null);
  const fontSize = state.settings.appearance?.terminalFontSize ?? 13;
  const lineHeight = state.settings.appearance?.terminalLineHeight ?? 1.2;

  // FOC-6:selectedSessionId 变化时(托盘点击 / 跨窗口聚焦 /
  // evt:window:focus-requested / view/select-session 等任意路径)
  // 把焦点送到新 session 的 xterm。
  //
  // 与 A1/A2 的关系:
  // - A1 在 TerminalView mount 时 term.focus() — 覆盖新建 + 切 session(key 重建)
  // - A2 在 Tab / Chrome / Template button click 末尾 focusTerminalDom — 显式
  // - A4 此 effect 兜底所有 dispatch 路径(reducer 改 selectedSessionId 但
  //   没人显式 focus 的场景,如 sessions/created reducer 自动 select)
  //
  // displayable 为 null(EmptyPathState)时不送焦点 — xterm 不存在,
  // focusTerminalDom 内部 querySelector 会 no-op 安全。
  useEffect(() => {
    if (state.selectedSessionId) focusTerminalDom();
  }, [state.selectedSessionId]);

  // 勘误第二轮:移除"拖文件夹到主区 → 新建终端"自定义。原 M1-B 的 onDragOver
  // preventDefault 把整个 main-pane 变成 droptarget,xterm 元素接不到 drop
  // 事件,Windows Terminal-风格的"拖文件到终端 → 粘贴路径"默认行为被吃掉。
  // 现在:主区不处理 drop 事件,事件穿透到 .terminal-host,xterm 沿用默认行为。
  // 加文件夹到收藏仍由 Sidebar 处理。

  // FLK-2:把主区容器尺寸 + 字号 → 估算 cols/rows → 写入 store。
  //
  // 历史:原版本挂 ResizeObserver 持续 dispatch dims,会和 TerminalView
  // 内部的 RO 双写抖动 — 拖窗时 chrome 每帧 layout 更新但 xterm 网格滞后
  // 150ms,体感"周边在跳但终端慢半拍"。
  //
  // 现在:只在 mount 时算一次,作为"PTY spawn 前的兜底估算"用,后续真实
  // 尺寸完全由 TerminalView mount 后的 fitAddon.fit() 写回 store
  // (TerminalView 是单一权威)。
  //
  // 字号 / 行高变化触发重算 — 用户改字号后再新建 session 时尺寸更准。
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const charWidth = fontSize * MONO_CHAR_ASPECT;
    const cellHeight = fontSize * lineHeight;
    const usableW = Math.max(0, el.clientWidth - TERMINAL_HOST_PADDING_X);
    const usableH = Math.max(0, el.clientHeight - TERMINAL_HOST_CHROME_Y);
    const cols = Math.max(MIN_COLS, Math.floor(usableW / charWidth));
    const rows = Math.max(MIN_ROWS, Math.floor(usableH / cellHeight));
    dispatch({ type: 'view/update-terminal-dims', dims: { cols, rows } });
  }, [dispatch, fontSize, lineHeight]);

  // A folder dragged from the sidebar opens a terminal there. Capture phase, because
  // xterm consumes drops to paste file paths, and that must keep working for real files.
  const isPathDrag = (e: DragEvent<HTMLElement>): boolean =>
    e.dataTransfer.types.includes(PATH_DRAG_TYPE);

  const openDroppedPath = async (pathId: string): Promise<void> => {
    const node = findPathNode(state.pathTree, pathId);
    if (!node) return;
    try {
      const dims = state.lastTerminalDims;
      const res = await window.api.invoke<unknown, CreateSessionResponse>(
        COMMAND_CHANNELS.SESSION_CREATE,
        {
          pathId,
          templateId: node.defaultTemplateId ?? state.defaultTemplateId ?? 'shell',
          cols: dims.cols,
          rows: dims.rows,
        },
      );
      dispatch({ type: 'view/select-path', pathId });
      dispatch({ type: 'view/select-session', sessionId: res.session.id });
      if (res.warning) toast.push({ kind: 'warn', message: res.warning });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.push({ kind: 'error', message: `打开终端失败 (${node.path}):${msg}` });
    }
  };

  const dropProps = {
    onDragOverCapture: (e: DragEvent<HTMLElement>): void => {
      if (!isPathDrag(e)) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'copy';
      setPathDragOver(true);
    },
    onDragLeave: (e: DragEvent<HTMLElement>): void => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setPathDragOver(false);
    },
    onDropCapture: (e: DragEvent<HTMLElement>): void => {
      setPathDragOver(false);
      if (!isPathDrag(e)) return;
      e.preventDefault();
      e.stopPropagation();
      void openDroppedPath(e.dataTransfer.getData(PATH_DRAG_TYPE));
    },
  };
  const mainClass = `main-pane${pathDragOver ? ' path-drag-over' : ''}`;

  if (!state.selectedPathId) {
    return (
      <main className={mainClass} ref={containerRef} {...dropProps}>
        <WelcomeState />
      </main>
    );
  }

  // Several panes can be empty, and one PDF must not appear in each of them.
  const folderPdfSlot = displayable ? -1 : layout === 'single' ? 0 : slots.indexOf(null);

  return (
    <main className={mainClass} ref={containerRef} {...dropProps}>
      {/* BETA-027:简易模式下 Tab bar 隐藏(浮动工具栏由 App.tsx 直接渲染)
          issue #4:appearance.hideTopTabBar=true 时也隐藏 TabBar(Sidebar 仍在) */}
      {!state.simpleMode && !state.settings.appearance?.hideTopTabBar && (
        <TabBar
          sessions={sessions}
          selectedSessionId={state.selectedSessionId}
          showBlankTab={!displayable}
        />
      )}
      {/* One tree for every layout, one terminal included, keyed by session: a session
          changes pane through grid-area, so no layout change rebuilds its terminal. */}
      <div className={`pane-grid pane-grid-${layout}`}>
        {(layout === 'single' ? [displayable] : slots).map((s, i) => (
          <div
            key={s?.id ?? `empty-${i}`}
            className={`pane-slot${s && s.id === state.selectedSessionId ? ' focused' : ''}`}
            style={{ gridArea: `p${i}` }}
            onMouseDownCapture={(e) => {
              // Pressing a pane's x must not move focus to a pane that is about to close.
              if ((e.target as Element).closest('.pane-close')) return;
              if (s && s.id !== state.selectedSessionId) {
                dispatch({ type: 'view/select-session', sessionId: s.id });
              }
            }}
          >
            {!s ? (
              <div className="session-stage">
                <EmptyPathState pathId={state.selectedPathId as string} />
                {i === folderPdfSlot && (
                  <PdfOverlay viewKey={folderPdfKey(state.selectedPathId as string)} />
                )}
                {i === spareSlot && displayableId && <PdfOverlay viewKey={displayableId} />}
              </div>
            ) : s.ownerWindowId === myWindowId ? (
              <>
                {/* With one terminal the file sits beside it, see .session-stage-beside. In a
                    grid it covers its own pane only. Its header sits above .pane-close, so
                    while a file is open the one visible x closes the file, not the session. */}
                <div
                  className={`session-stage${layout === 'single' ? ' session-stage-beside' : ''}`}
                >
                  <div className="session-terminal">
                    <TerminalView session={s} />
                  </div>
                  {!(s.id === displayableId && spareSlot >= 0) && <PdfOverlay viewKey={s.id} />}
                </div>
                {layout !== 'single' && <PaneCloseButton sessionId={s.id} />}
              </>
            ) : null}
          </div>
        ))}
      </div>
      {!state.simpleMode && <PaneLayoutBar />}
    </main>
  );
}

/**
 * The x on a split pane. Closes the session exactly as the x on its tab does.
 *
 * It never takes the keyboard. Handing focus back from here would land on the terminal
 * being closed, whose focus report then reaches a session that no longer exists and shows
 * a false warning. MainPane moves focus once the store has picked the next pane.
 */
function PaneCloseButton({ sessionId }: { sessionId: string }): JSX.Element {
  const { tx } = useTranslation();
  const label = tx('关闭终端', 'Close terminal');
  return (
    <button
      type="button"
      className="pane-close"
      title={label}
      aria-label={label}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        window.api
          .invoke(COMMAND_CHANNELS.SESSION_CLOSE, { sessionId })
          .catch((err) => console.error('[Pane] close failed', err));
      }}
    >
      <Icon name="close" size={14} />
    </button>
  );
}

function WelcomeState(): JSX.Element {
  const { tx } = useTranslation();
  return (
    <div className="welcome-state">
      <h2 className="welcome-signature">
        Ceteris
        <svg viewBox="0 0 240 22" fill="none" aria-hidden="true">
          <path
            d="M6 15C58 7 128 3 234 7C176 9 118 12 78 19"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </h2>
      <p>
        {tx('从左侧选一个路径开始,或点击', 'Pick a path on the left, or click')}{' '}
        <strong>{tx('文件夹 +', 'Folders +')}</strong>{' '}
        {tx('添加文件夹。', 'to add a folder.')}
      </p>
    </div>
  );
}

function EmptyPathState({ pathId }: { pathId: string }): JSX.Element {
  const { tx } = useTranslation();
  const state = useAppState();
  const dispatch = useAppDispatch();
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const node = findPathNode(state.pathTree, pathId);
  const isSshPath = node?.kind === 'ssh';
  const wslDistroName = node ? getWslDistroName(node.path) : null;
  const isWslPath = !!wslDistroName;
  const displayPath =
    isSshPath && node
      ? node.path
      : node
        ? formatPathDisplayPath(node)
        : pathId;
  // 勘误第二轮 #3:启动期拉一次 detectShells,缓存到组件状态。SessionManager
  // 内部已 cache,所以二次以上调用是 O(1)。
  const [shells, setShells] = useState<DetectedShell[] | null>(null);

  useEffect(() => {
    if (isSshPath) {
      setShells([]);
      return;
    }
    let cancelled = false;
    window.api
      .invoke<unknown, ListShellsResponse>(
        COMMAND_CHANNELS.SETTINGS_LIST_SHELLS,
        {},
      )
      .then((res) => {
        if (!cancelled) setShells(res.shells);
      })
      .catch((err) => {
        console.warn('[EmptyPathState] list-shells failed', err);
        if (!cancelled) setShells([]); // 失败 → 不显示 shell 区段,但仍允许模板按钮
      });
    return () => {
      cancelled = true;
    };
  }, [isSshPath]);

  // Agent 状态点只对本机路径有意义:SSH / WSL 里的 agent 是另一套安装。
  const showAgentDots = !isSshPath && !isWslPath;
  const [agentVersions, setAgentVersions] = useState<Map<string, AgentVersionInfo>>(
    () => new Map(),
  );
  useEffect(() => {
    if (!showAgentDots) return;
    let cancelled = false;
    window.api
      .invoke<unknown, ListAgentVersionsResponse>(COMMAND_CHANNELS.AGENT_LIST_VERSIONS, {})
      .then((res) => {
        if (!cancelled) setAgentVersions(new Map(res.agents.map((a) => [a.templateId, a])));
      })
      .catch((err) => {
        // 查不到就不显示点,按钮照常可用
        console.warn('[EmptyPathState] list-agent-versions failed', err);
      });
    return () => {
      cancelled = true;
    };
  }, [showAgentDots]);

  const handleUpgrade = async (templateId: string): Promise<void> => {
    if (creating) return;
    setCreating(true);
    try {
      const dims = state.lastTerminalDims;
      const res = await window.api.invoke<UpgradeAgentPayload, CreateSessionResponse>(
        COMMAND_CHANNELS.AGENT_UPGRADE,
        { templateId, pathId, cols: dims.cols, rows: dims.rows },
      );
      dispatch({ type: 'view/select-session', sessionId: res.session.id });
      focusTerminalDom();
    } catch (err) {
      console.error('[MainPane] agent upgrade failed', err);
      const msg = err instanceof Error ? err.message : String(err);
      toast.push({
        kind: 'error',
        message: tx(`启动升级失败:${msg}`, `Failed to start the update: ${msg}`),
      });
    } finally {
      setCreating(false);
    }
  };

  const handleCreate = async (
    templateId: string,
    shellId?: string,
    sshTmuxMode?: 'disabled' | 'attach-or-create',
  ): Promise<void> => {
    if (creating) return;
    setCreating(true);
    try {
      const dims = state.lastTerminalDims;
      const res = await window.api.invoke<unknown, CreateSessionResponse>(
        COMMAND_CHANNELS.SESSION_CREATE,
        {
          pathId,
          templateId,
          ...(shellId ? { shellId } : {}),
          ...(isSshPath ? { sshTmuxMode: sshTmuxMode ?? 'disabled' } : {}),
          cols: dims.cols,
          rows: dims.rows,
        },
      );
      dispatch({ type: 'view/select-session', sessionId: res.session.id });
      if (res.warning) {
        toast.push({ kind: 'warn', message: tx(res.warning, res.warning) });
      }
      // FOC-3:模板按钮点击后焦点漂在 button 上,挂载 TerminalView 后
      // 自动把焦点送回 xterm。A4 的 selectedSessionId effect 也会兜底,
      // 但显式 + rAF 让"立即可打字"语义更清晰。
      focusTerminalDom();
    } catch (err) {
      console.error('[MainPane] create-session failed', err);
      toast.push({
        kind: 'error',
        message: tx(`新建终端失败:${err instanceof Error ? err.message : String(err)}`, `Failed to create terminal: ${err instanceof Error ? err.message : String(err)}`),
      });
    } finally {
      setCreating(false);
    }
  };

  const templates = state.templates.filter((t) => !t.hidden);
  const shellTemplates = templates.filter((t) => SHELL_TEMPLATE_IDS.has(t.id));
  const agentTemplates = templates.filter((t) => !SHELL_TEMPLATE_IDS.has(t.id));
  const visibleShells = shells ? filterShellsForWslPath(shells, wslDistroName) : null;
  const wslShellId = isWslPath ? visibleShells?.[0]?.id : undefined;
  // WSL 路径要等 WSL shell 检测出来,模板才有地方跑
  const canLaunchTemplates = isSshPath || !isWslPath || !!wslShellId;
  const renderTemplate = (t: Template): JSX.Element => (
    <TemplateLaunchButton
      key={t.id}
      template={t}
      creating={creating}
      onLaunch={() => void handleCreate(t.id, isSshPath ? undefined : wslShellId, 'disabled')}
      version={showAgentDots ? agentVersions.get(t.id) : undefined}
      onUpgrade={() => void handleUpgrade(t.id)}
    />
  );

  return (
    <>
      {/* The same bar a terminal has, so the path stays put when switching to this page. */}
      <div className="terminal-statusbar">
        <span className="status-text">{tx('新建终端', 'New terminal')}</span>
        <span className="status-cwd" title={displayPath}>
          {displayPath}
        </span>
      </div>
      <div className="empty-path-state">
        {isSshPath && (
          <div className="empty-section">
            <div className="empty-section-title">SSH</div>
            <div className="empty-button-grid">
              <button
                type="button"
                className="template-button"
                onClick={() => void handleCreate('shell', undefined, 'disabled')}
                disabled={creating}
                title={displayPath}
              >
                <span className="template-icon">
                  <Icon name="shell" size={18} />
                </span>
                <span className="template-label">{tx('连接', 'Connect')}</span>
              </button>
              <button
                type="button"
                className="template-button"
                onClick={() => void handleCreate('shell', undefined, 'attach-or-create')}
                disabled={creating}
                title={tx(`通过 tmux 连接 ${displayPath}`, `Connect with tmux to ${displayPath}`)}
              >
                <span className="template-icon">
                  <Icon name="templateShell" size={18} />
                </span>
                <span className="template-label">tmux</span>
              </button>
              {shellTemplates.map(renderTemplate)}
            </div>
          </div>
        )}

        {!isSshPath &&
          ((visibleShells?.length ?? 0) > 0 || (canLaunchTemplates && shellTemplates.length > 0)) && (
          <div className="empty-section">
            <div className="empty-section-title">Shell</div>
            <div className="empty-button-grid">
              {(visibleShells ?? []).map((s) => (
                <button
                  key={s.id}
                  type="button"
                  className="template-button"
                  onClick={() => void handleCreate('shell', s.id)}
                  disabled={creating}
                  title={`${s.displayName}\n${s.executablePath}`}
                >
                  <span className="template-icon">
                    <Icon name={shellIcon(s.id)} size={18} />
                  </span>
                  <span className="template-label">{s.displayName}</span>
                </button>
              ))}
              {canLaunchTemplates && shellTemplates.map(renderTemplate)}
            </div>
          </div>
        )}

        {agentTemplates.length > 0 && (
          <div className="empty-section">
            <div className="empty-section-title">Agents</div>
            <div className="empty-button-grid">
              {canLaunchTemplates && agentTemplates.map(renderTemplate)}
            </div>
          </div>
        )}
      </div>
    </>
  );
}

/** 内置的纯 shell 模板归到 Shell 区;其余模板 (含自定义) 归到 Agents 区。 */
const SHELL_TEMPLATE_IDS = new Set(['shell', 'admin-shell']);

function TemplateLaunchButton({
  template,
  creating,
  onLaunch,
  version,
  onUpgrade,
}: {
  template: Template;
  creating: boolean;
  onLaunch: () => void;
  /** 有值时在卡片右侧显示状态点 */
  version?: AgentVersionInfo | undefined;
  onUpgrade?: () => void;
}): JSX.Element {
  const button = (
    <button
      type="button"
      className={`template-button${version ? ' has-dot' : ''}`}
      onClick={onLaunch}
      disabled={creating}
      title={template.command ? `${template.name} — 启动命令: ${template.command}` : template.name}
    >
      <span className="template-icon">
        <TemplateIcon template={template} size={18} />
      </span>
      <span className="template-label">{template.name}</span>
    </button>
  );
  if (!version) return button;
  return (
    <div className="template-button-wrap">
      {button}
      <AgentVersionDot info={version} disabled={creating} onUpgrade={onUpgrade} />
    </div>
  );
}

/**
 * Agent 卡片右侧的状态点:
 * - 绿:已是最新
 * - 黄:有新版本,点它在新终端里跑升级命令
 * - 灰:已装,但查不到最新版 (离线 / 无 registry);点它同样跑升级命令
 * - 空心:PATH 上没找到
 */
function AgentVersionDot({
  info,
  disabled,
  onUpgrade,
}: {
  info: AgentVersionInfo;
  disabled: boolean;
  onUpgrade?: (() => void) | undefined;
}): JSX.Element {
  const { tx } = useTranslation();
  const cmd = info.upgradeCommand ?? '';
  const lines: string[] = [];
  switch (info.status) {
    case 'current':
      lines.push(tx(`${info.installed ?? ''} 已是最新`, `${info.installed ?? ''} is up to date`));
      break;
    case 'outdated':
      lines.push(`${tx('有新版本', 'Update available')}: ${info.installed} → ${info.latest}`);
      break;
    case 'installed':
      lines.push(
        `${tx('已安装', 'Installed')} ${info.installed ?? ''}`,
        tx('查不到最新版本', 'Latest version unknown'),
      );
      break;
    default:
      lines.push(tx('PATH 上没找到这个命令', 'Not found on PATH'));
  }
  if (info.path) {
    const method = info.installMethod && info.installMethod !== 'self' ? info.installMethod : null;
    lines.push(method ? tx(`用 ${method} 安装:${info.path}`, `Installed with ${method}: ${info.path}`) : info.path);
  }
  for (const other of info.otherCopies ?? []) {
    lines.push(tx(`PATH 上另有一份 (不会运行):${other}`, `Another copy on PATH (not used): ${other}`));
  }
  if (info.status === 'outdated' || info.status === 'installed') {
    if (cmd) {
      lines.push(tx(`点击运行:${cmd}`, `Click to run: ${cmd}`));
      // 系统包管理器的版本常比 npm / PyPI 晚几天,升级后点可能仍是黄色
      if (info.status === 'outdated' && ['brew', 'winget', 'scoop'].includes(info.installMethod ?? '')) {
        lines.push(
          tx(
            `${info.installMethod} 可能还没收录 ${info.latest}`,
            `${info.installMethod} may not have ${info.latest} yet`,
          ),
        );
      }
    } else {
      lines.push(tx('认不出安装方式,请用安装时的方式升级', "Can't tell how it was installed; update it the way you installed it"));
    }
  }
  const title = lines.join('\n');
  const clickable =
    (info.status === 'outdated' || info.status === 'installed') && !!cmd && !!onUpgrade;
  if (!clickable) {
    return <span className={`agent-dot ${info.status}`} title={title} aria-label={title} />;
  }
  return (
    <button
      type="button"
      className={`agent-dot ${info.status}`}
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onUpgrade}
    />
  );
}

interface TabBarProps {
  sessions: SessionInfo[];
  selectedSessionId: string | null;
  /**
   * 勘误第二轮 #8:当 displayable=null 时,父级 MainPane 显示 EmptyPathState
   * 作为内容,此时 tabbar 里渲染一个"新建"占位 tab(visually selected),
   * 让"新建终端页面"看起来像一个 chrome 空白页 tab,而不是游离在标签页之外。
   */
  showBlankTab: boolean;
}

function TabBar({ sessions, selectedSessionId, showBlankTab }: TabBarProps): JSX.Element {
  const { tx } = useTranslation();
  const state = useAppState();
  const dispatch = useAppDispatch();

  const [quickLaunchAnchor, setQuickLaunchAnchor] = useState<Point | null>(null);

  const handleBlankTabContextMenu = (e: MouseEvent<HTMLButtonElement>): void => {
    e.preventDefault();
    const icon = e.currentTarget.querySelector('.tab-blank-icon') ?? e.currentTarget;
    const rect = icon.getBoundingClientRect();
    setQuickLaunchAnchor({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
  };

  const handleClickBlankTab = (): void => {
    // 已经显示 EmptyPathState → 取消选中真正的 session,确保新建页保持当前态。
    // 多数情况下 selectedSessionId 已经是非 mine 的 session id,这里只是让
    // dispatch 触发一次重算确保 view 一致。
    dispatch({ type: 'view/select-session', sessionId: null });
    // 显式 blur 占位 tab 按钮 —EmptyPathState 没有 xterm 可以 focus,
    // 但至少不应该让 button 一直 :focus 着,Tab 键导航变奇怪。
    (document.activeElement as HTMLElement | null)?.blur();
  };

  // CP-3 勘误 #5:**彻底**移除"灰显抽到最右边"的分组逻辑。
  // 直接按 path.sessionIds 顺序渲染所有 tab — 不分组、不重排。
  // 灰显 / orphan / mine 的视觉差由 Tab 自己根据 ownerWindowId 决定 variant,
  // 与位置无关。
  //
  // 勘误第二轮 #8:移除尾部 "+" 按钮 → 替换为常驻"新建" tab。新建 tab 在
  // 用户当前持有/查看其他 session 时点击即切换到 EmptyPathState,这与 Chrome
  // 的 new-tab 行为一致(不在被点之前消耗资源);自动选中只在已无 displayable
  // 时才发生(showBlankTab=true)。
  return (
    <div className="tab-bar">
      <div className="tab-list">
        {sessions.map((s) => (
          <Tab
            key={s.id}
            session={s}
            myWindowId={state.myWindowId}
            selected={s.id === selectedSessionId}
          />
        ))}
        <button
          type="button"
          className={`tab tab-blank${showBlankTab ? ' selected' : ''}`}
          onClick={handleClickBlankTab}
          onContextMenu={handleBlankTabContextMenu}
          title={tx('新建终端:选择 Shell 或模板', 'New terminal: pick a shell or template')}
          aria-label={tx('新建终端', 'New terminal')}
        >
          <span className="tab-blank-icon" aria-hidden="true"><Icon name="plus" size={18} /></span>
        </button>
      </div>
      {quickLaunchAnchor && state.selectedPathId && (
        <QuickLaunchOverlay
          pathId={state.selectedPathId}
          anchor={quickLaunchAnchor}
          onClose={() => setQuickLaunchAnchor(null)}
        />
      )}
    </div>
  );
}

interface TabProps {
  session: SessionInfo;
  myWindowId: string;
  selected: boolean;
}

function Tab({ session, myWindowId, selected }: TabProps): JSX.Element {
  const { tx } = useTranslation();
  const state = useAppState();
  const dispatch = useAppDispatch();
  const ctxMenu = useContextMenuApi();
  const toast = useToast();
  const modal = useModal();

  // Variant 由 session.ownerWindowId 自决,不再由父级分组传入。这样 tab
  // 即使移动 (虽然现在不再重排) 也不会丢 variant。
  const variant: 'mine' | 'orphan' | 'other' =
    session.ownerWindowId === myWindowId
      ? 'mine'
      : session.ownerWindowId === null
        ? 'orphan'
        : 'other';

  // 复制到剪贴板 — 统一走 useCopyToClipboard hook(P2-11)。
  const copyToClipboard = useCopyToClipboard();

  const handleContextMenu = (e: MouseEvent<HTMLButtonElement>): void => {
    e.preventDefault();
    e.stopPropagation();
    ctxMenu.open({
      x: e.clientX,
      y: e.clientY,
      title: session.displayName,
      items: buildSessionContextMenu(session, {
        variant,
        pathTree: state.pathTree,
        copyToClipboard,
        toastError: (message) => toast.push({ kind: 'error', message }),
        onRename: async () => {
          // Tab 端走 Modal.prompt(Sidebar 端走行内编辑,两者菜单"内容"对齐
          // 但触发体验各按各侧的惯例)。
          const next = await modal.prompt({
            title: tx('重命名会话', 'Rename session'),
            message: tx('为此会话指定新的显示名(不影响 sessionId)', 'New display name for this session (sessionId stays the same)'),
            defaultValue: session.displayName,
            confirmLabel: tx('保存', 'Save'),
          });
          if (next === null) return;
          const trimmed = next.trim();
          if (!trimmed) return;
          window.api
            .invoke(COMMAND_CHANNELS.SESSION_RENAME, {
              sessionId: session.id,
              newDisplayName: trimmed,
            })
            .catch((err: unknown) =>
              toast.push({
                kind: 'error',
                message: `重命名失败:${err instanceof Error ? err.message : String(err)}`,
              }),
            );
        },
      }),
    });
  };

  const handleClick = (e: MouseEvent<HTMLButtonElement>): void => {
    e.preventDefault();
    if (variant === 'other') {
      // 其他窗口持有 → 聚焦那个窗口,所有权不变 (软件定义书 8.4)。
      // 持有方在另一台机器上时无法聚焦,main 会交接给本窗口,这里跟着选中。
      window.api
        .invoke<{ sessionId: string }, FocusSessionOwnerResponse>(
          COMMAND_CHANNELS.SESSION_FOCUS_OWNER,
          { sessionId: session.id },
        )
        .then((res) => {
          if (!res.transferred) return;
          dispatch({ type: 'view/select-session', sessionId: session.id });
          focusTerminalDom();
        })
        .catch((err) => console.error('[Tab] focus-owner failed', err));
      return;
    }
    if (variant === 'orphan') {
      // 乐观接管:本地立即改 owner + select,消除"+按钮闪一下"现象。
      // claim 失败 (race: SessionAlreadyOwned/NotFound,几乎不会发生)
      // 时再 dispatch 回滚到之前持有状态。
      const prevOwnedId = findMyOwnedSessionId(state);
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
      dispatch({ type: 'view/select-session', sessionId: session.id });

      window.api
        .invoke(COMMAND_CHANNELS.SESSION_CLAIM, { sessionId: session.id })
        .catch((err) => {
          console.error('[Tab] claim failed, rolling back', err);
          // 回滚:目标变回 orphan,旧持有变回 myWindow
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
      // FOC-2:乐观接管成功路径也需要送焦点;rAF + 选择器在新 TerminalView
      // 挂上后命中。失败 rollback 后 EmptyPathState 没 xterm,focusTerminalDom
      // 会 no-op,无副作用。
      focusTerminalDom();
      return;
    }
    // 本窗口持有 (mine):仅切换 view (新模型下其实 myTabs 至多 1 个,
    // 多数场景这就是当前 selected — no-op,但保留分支以防 race)
    dispatch({ type: 'view/select-session', sessionId: session.id });
    // FOC-2:Tab click 后 button 默认接管 :focus,把焦点送回 xterm,
    // 让用户敲键立即生效。orphan 接管分支已在前文 dispatch 后落到
    // 同一 selectedSessionId 路径,A4 的 effect 会兜底;但显式调用
    // 让"点 tab → 能打字"的契约不依赖 effect 触发时机。
    focusTerminalDom();
  };

  const handleClose = (e: MouseEvent<HTMLSpanElement>): void => {
    e.stopPropagation();
    window.api
      .invoke(COMMAND_CHANNELS.SESSION_CLOSE, { sessionId: session.id })
      .catch((err) => console.error('[Tab] close failed', err));
  };

  // ADR-008:cwd 漂移提示。session.pathId 永久不变,只有 currentCwd 与
  // originalCwd 不一致时才显示 ⚠️。
  const cwdDrifted =
    !!session.currentCwd &&
    !!session.originalCwd &&
    session.currentCwd.toLowerCase() !== session.originalCwd.toLowerCase();

  const tooltipParts: string[] = [];
  if (variant === 'other') {
    tooltipParts.push(tx(`${session.displayName} (在其他窗口)`, `${session.displayName} (owned by another window)`));
  } else {
    tooltipParts.push(session.displayName);
  }
  if (cwdDrifted) {
    tooltipParts.push(tx(`当前目录 → ${session.currentCwd}`, `Current dir → ${session.currentCwd}`));
    tooltipParts.push(tx(`(原: ${session.originalCwd})`, `(orig: ${session.originalCwd})`));
  }
  if (session.state === 'exited') {
    tooltipParts.push(tx(`已退出 (exitCode=${session.exitCode ?? 0})`, `Exited (exitCode=${session.exitCode ?? 0})`));
  }

  return (
    <button
      type="button"
      className={
        `tab` +
        (selected ? ' selected' : '') +
        (variant === 'other' ? ' owned-by-other' : '') +
        (variant === 'orphan' ? ' orphan' : '') +
        (session.state === 'exited' ? ' exited' : '') +
        (session.state === 'active' ? ' running' : '')
      }
      onClick={handleClick}
      onContextMenu={handleContextMenu}
      title={tooltipParts.join('\n')}
    >
      <span className="tab-name">{session.displayName}</span>
      {cwdDrifted && (
        <span className="tab-cwd-drift" aria-label={tx('当前目录已变', 'Current directory changed')}>
          <Icon name="alertTriangle" size={11} />
        </span>
      )}
      {variant !== 'other' && (
        <span
          className="tab-close"
          onClick={handleClose}
          title={tx('关闭', 'Close')}
          role="button"
        >
          <Icon name="close" size={14} />
        </span>
      )}
    </button>
  );
}
