/**
 * @file src/renderer/components/CoordinatorTour.tsx
 * @purpose The coordinator tour (ADR-024): an animated, step-by-step guide on top of the real
 *   window. It first introduces two roles: the Coordinator, which monitors and controls your
 *   Claude Code agents, and the Fintuner, which learns from the chat history where to save time
 *   and work more efficiently. Then it spotlights the tab to right-click, plays a cursor doing
 *   it, points at the Coordinator item in the menu, the new coordinator row, the setting and the
 *   plugin install, shows how to give the coordinator a job, and ends with a button that opens
 *   a Fintuner.
 * - Both roles are a recommended way to use tabs, not code: a coordinator is a Claude Code tab
 *   with the Coordinator mark (ADR-023/024), a Fintuner is a Claude Code tab with a prompt. The
 *   intro says so. To make the roles easy to spot, the tour renames the tabs "Coordinator" and
 *   "Fintuner" (a manual rename, so Claude Code's own titles do not overwrite it). The two are
 *   at the same level: the Fintuner tab also gets the Coordinator mark, so both sit in the row
 *   above the tabs (and both may control tabs when that extension is on).
 *
 * @关键设计:
 * - It points at the real UI and the user does the real thing; the tour never clicks for them,
 *   except the Fintuner button, which opens that tab itself.
 *   The overlay lets every click through (pointer-events: none) except on its own bubble.
 * - The step comes from app state (coordinatorTourStep in @shared/coordinator-tour), checked
 *   every animation frame together with where the target is. Right-clicking a tab, ticking
 *   Coordinator or turning the setting on moves the tour forward by itself.
 * - Targets are found through data attributes: data-quick-key="template:claude-code" inside
 *   data-guide="ghost-tab" (the Claude Code icon of the dashed quick launch tab, falling back to
 *   the tab itself and then to data-guide="new-tab", the +),
 *   data-session-id (each tab), data-guide="coordinator" (the menu item) and
 *   data-guide="coordinator-bar" (the coordinator row). Renaming those breaks the tour.
 * - When the tour opens: on launch while settings.extensions.tabControlGuideSeen is false (a new
 *   install, or the first launch after the update), and when the user ticks Coordinator (the
 *   tab menu fires COORDINATOR_GUIDE_EVENT), which then continues from the coordinator row.
 *   Done or "Don't show again" writes the flag, for every window; Later only closes it here.
 * - While the settings page is open, the quick launch tip is still showing (it points at the
 *   same + tab), or the target is not on screen, the tour waits hidden.
 *
 * @对应文档章节:软件定义书.md ADR-024
 *
 * @不要在这里做的事:
 * - 不要弹成模态框或挡住点击 (首启不该被拦住,见软件定义书第 2 章)
 * - 不要替用户按 Enter 装插件 (type-into-terminal.ts 只输入,不执行)
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { COMMAND_CHANNELS } from '@shared/protocol';
import {
  COORDINATOR_TOUR_STEPS,
  coordinatorTourStep,
  type CoordinatorTourInput,
  type CoordinatorTourStep,
} from '@shared/coordinator-tour';
import {
  COORDINATOR_GUIDE_EVENT,
  tabControlInstallLine,
  type TabControlStatus,
} from '@shared/tab-control';
import type { CreateSessionResponse, RenameSessionPayload } from '@shared/protocol';
import { useAppState } from '../store';
import { useTranslation } from './LanguageProvider';
import { useToast } from './Toast';
import { useTypeIntoNewTerminal } from './type-into-terminal';
import { useQuickLaunch } from './useQuickLaunch';

/** How often to look for the plugin again while the tour waits for the install. */
const PLUGIN_POLL_MS = 3000;
/** Space between the spotlight and the element it lights, in px. */
const SPOT_PAD = 4;
const BUBBLE_WIDTH = 300;
/** The intro shows both roles side by side in text, so its bubble is wider. */
const WIDE_BUBBLE_WIDTH = 360;
const EDGE = 12;
/** Tab names the tour gives the two roles. */
const COORD_NAME = 'Coordinator';
const FINTUNER_NAME = 'Fintuner';

/** Rename a tab the way the tab menu does; a failure only goes to the console. */
function renameTab(sessionId: string, name: string): void {
  const payload: RenameSessionPayload = { sessionId, newDisplayName: name };
  window.api
    .invoke(COMMAND_CHANNELS.SESSION_RENAME, payload)
    .catch((err: unknown) => console.warn(`[CoordinatorTour] rename to ${name} failed`, err));
}

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface Probe {
  step: CoordinatorTourStep;
  target: Rect;
  /** The open tab menu, so the bubble can sit beside it instead of over it. */
  menu: Rect | null;
}

function rectOf(el: Element | null): Rect | null {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return null;
  return { left: r.left, top: r.top, width: r.width, height: r.height };
}

function sameRect(a: Rect | null, b: Rect | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    Math.round(a.left) === Math.round(b.left) &&
    Math.round(a.top) === Math.round(b.top) &&
    Math.round(a.width) === Math.round(b.width) &&
    Math.round(a.height) === Math.round(b.height)
  );
}

/**
 * Where to open a Claude Code tab: its icon in the dashed quick launch tab (GhostTab), else the
 * dashed tab, else the + when quick launch is empty.
 */
function claudeLauncher(): Element | null {
  return (
    document.querySelector('[data-guide="ghost-tab"] [data-quick-key="template:claude-code"]') ??
    document.querySelector('[data-guide="ghost-tab"]') ??
    document.querySelector('[data-guide="new-tab"]')
  );
}

/** A tab of the current folder to right-click: the selected one, else the first. */
function folderTab(): Element | null {
  const bar = '.tab-bar:not(.coordinator-bar) .tab[data-session-id]';
  return document.querySelector(`${bar}.selected`) ?? document.querySelector(bar);
}

/** Save a partial extensions update; a failure only shows a toast. */
async function saveExtensions(
  partial: { tabControl?: boolean; tabControlGuideSeen?: boolean },
  onError: (message: string) => void,
): Promise<void> {
  try {
    await window.api.invoke(COMMAND_CHANNELS.SETTINGS_UPDATE, {
      partial: { extensions: partial },
    });
  } catch (err) {
    onError(err instanceof Error ? err.message : String(err));
  }
}

export function CoordinatorTour(): JSX.Element | null {
  const { tx } = useTranslation();
  const state = useAppState();
  const toast = useToast();
  const typer = useTypeIntoNewTerminal();
  const seen = state.settings.extensions?.tabControlGuideSeen ?? false;
  const enabled = state.settings.extensions?.tabControl ?? false;
  // 启动时没看过就打开;之后勾选协调者能再打开它
  const [open, setOpen] = useState(!seen);
  const [introSeen, setIntroSeen] = useState(false);
  const [rowSeen, setRowSeen] = useState(false);
  const [startSeen, setStartSeen] = useState(false);
  const [coordId, setCoordId] = useState<string | null>(null);
  const [pluginInstalled, setPluginInstalled] = useState<boolean | null>(null);
  const [marketplaceDir, setMarketplaceDir] = useState<string | null>(null);
  const [probe, setProbe] = useState<Probe | null>(null);
  const [bubbleHeight, setBubbleHeight] = useState(180);
  const bubbleRef = useRef<HTMLDivElement>(null);

  const quickLaunch = useQuickLaunch(state.selectedPathId, 16);

  const showError = (message: string): void => toast.push({ kind: 'error', message });

  // 勾选协调者:打开引导,并在引导还没被关掉时把标签改名为 coord
  const seenRef = useRef(seen);
  seenRef.current = seen;
  useEffect(() => {
    const onTicked = (e: Event): void => {
      const detail = (e as CustomEvent<{ sessionId?: string } | undefined>).detail;
      const sessionId = detail?.sessionId ?? null;
      setCoordId(sessionId);
      setOpen(true);
      if (sessionId && !seenRef.current) renameTab(sessionId, COORD_NAME);
    };
    window.addEventListener(COORDINATOR_GUIDE_EVENT, onTicked);
    return () => window.removeEventListener(COORDINATOR_GUIDE_EVENT, onTicked);
  }, []);

  // 一次只出一个引导:"右键 + 号快速启动" 的气泡 (QuickLaunchTip) 也指着 + 号,先等它被关掉
  const quickLaunchTipShowing = state.settings.behavior?.quickLaunchTipSeen === false;
  const active = open && !seen && !state.inSettingsView && !quickLaunchTipShowing;

  const coordinators = [...state.sessions.values()].filter(
    (s) => s.coordinator === true && s.state !== 'exited',
  );
  const coord = coordinators.find((s) => s.id === coordId) ?? coordinators[0] ?? null;

  // 动画帧循环读的是这一帧的状态;放进 ref,循环本身不用随每次渲染重建
  const inputRef = useRef<Omit<CoordinatorTourInput, 'menuOpen' | 'hasFolderTab'>>({
    introSeen: false,
    hasCoordinator: false,
    rowSeen: false,
    enabled: false,
    pluginInstalled: null,
    startSeen: false,
  });
  inputRef.current = {
    introSeen,
    hasCoordinator: coord !== null,
    rowSeen,
    enabled,
    pluginInstalled,
    startSeen,
  };
  const coordIdRef = useRef<string | null>(null);
  coordIdRef.current = coord?.id ?? null;

  // 每一帧量一次:现在是哪一步、目标在哪。只有变了才 setState,静止时不重渲染
  useEffect(() => {
    if (!active) {
      setProbe(null);
      return;
    }
    let frame = 0;
    let last: Probe | null = null;
    const tick = (): void => {
      const menuItem = document.querySelector('[data-guide="coordinator"]');
      const tab = folderTab();
      const step = coordinatorTourStep({
        ...inputRef.current,
        menuOpen: menuItem !== null,
        hasFolderTab: tab !== null,
      });
      let target: Rect | null = null;
      let menu: Rect | null = null;
      if (step === 'intro') {
        // 两个角色的介绍指着当前文件夹的标签栏:agent 们就住在这里
        target = rectOf(document.querySelector('.tab-bar:not(.coordinator-bar) .tab-list'));
      } else if (step === 'open-tab' || step === 'fintuner') {
        // 两步都是开一个 Claude Code:指着虚线标签里它的图标
        target = rectOf(claudeLauncher());
      } else if (step === 'right-click') target = rectOf(tab);
      else if (step === 'tick') {
        target = rectOf(menuItem);
        menu = rectOf(menuItem?.closest('.ctx-menu') ?? null);
      } else if (step === 'row') {
        target = rectOf(document.querySelector('[data-guide="coordinator-bar"]'));
      } else if (coordIdRef.current) {
        target = rectOf(
          document.querySelector(
            `[data-guide="coordinator-bar"] [data-session-id="${CSS.escape(coordIdRef.current)}"]`,
          ),
        );
      }
      const next = target ? { step, target, menu } : null;
      const changed =
        (last === null) !== (next === null) ||
        (last !== null &&
          next !== null &&
          (last.step !== next.step ||
            !sameRect(last.target, next.target) ||
            !sameRect(last.menu, next.menu)));
      if (changed) {
        last = next;
        setProbe(next);
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [active]);

  // 插件装没装:打开时查一次,没装就每 3 秒再查,用户在新终端按完 Enter 这一步自己前进
  useEffect(() => {
    if (!active || pluginInstalled) return;
    let cancelled = false;
    const check = (): void => {
      window.api
        .invoke<unknown, TabControlStatus>(COMMAND_CHANNELS.EXTENSIONS_TAB_CONTROL_STATUS, {})
        .then((res) => {
          if (!cancelled) setPluginInstalled(res.pluginInstalled);
        })
        .catch((err: unknown) => console.warn('[CoordinatorTour] status check failed', err));
    };
    check();
    const timer = window.setInterval(check, PLUGIN_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [active, pluginInstalled]);

  useEffect(() => {
    if (!active || marketplaceDir) return;
    window.api
      .invoke<unknown, { dir: string }>(COMMAND_CHANNELS.EXTENSIONS_GET_MARKETPLACE_DIR, {})
      .then((res) => setMarketplaceDir(res.dir))
      .catch((err: unknown) => console.warn('[CoordinatorTour] marketplace dir failed', err));
  }, [active, marketplaceDir]);

  useLayoutEffect(() => {
    const h = bubbleRef.current?.offsetHeight;
    if (h && h !== bubbleHeight) setBubbleHeight(h);
  }, [probe, bubbleHeight]);

  if (!active || !probe) return null;

  const { step, target, menu } = probe;
  const spot = {
    left: target.left - SPOT_PAD,
    top: target.top - SPOT_PAD,
    width: target.width + SPOT_PAD * 2,
    height: target.height + SPOT_PAD * 2,
  };

  // 气泡:菜单那一步放在菜单旁边,其余放在目标下方 (放不下就放上方),左右不出窗口
  const width = step === 'intro' ? WIDE_BUBBLE_WIDTH : BUBBLE_WIDTH;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let bubbleLeft: number;
  let bubbleTop: number;
  let arrow: 'up' | 'down' | 'left' | 'right';
  if (step === 'tick' && menu) {
    const right = menu.left + menu.width + 16;
    if (right + width <= vw - EDGE) {
      bubbleLeft = right;
      arrow = 'left';
    } else {
      bubbleLeft = Math.max(EDGE, menu.left - 16 - width);
      arrow = 'right';
    }
    bubbleTop = Math.min(Math.max(EDGE, target.top - 24), vh - bubbleHeight - EDGE);
  } else {
    const center = step === 'intro' ? target.left + 40 : target.left + target.width / 2;
    bubbleLeft = Math.min(Math.max(EDGE, center - 36), vw - width - EDGE);
    const below = spot.top + spot.height + 14;
    if (below + bubbleHeight <= vh - EDGE) {
      bubbleTop = below;
      arrow = 'up';
    } else {
      bubbleTop = Math.max(EDGE, spot.top - 14 - bubbleHeight);
      arrow = 'down';
    }
  }
  // 介绍那一步的目标是整条标签栏,箭头指它左边开头
  const pointX = step === 'intro' ? target.left + 40 : target.left + target.width / 2;
  const arrowX = Math.min(Math.max(18, pointX - bubbleLeft), width - 18);

  // 光标动画演示动作:点 Claude Code 图标、右键标签、点菜单项;中间几步不需要
  const cursor =
    step === 'right-click'
      ? { x: target.left + target.width / 2, y: target.top + target.height / 2, right: true }
      : step === 'tick'
        ? {
            x: target.left + Math.min(60, target.width / 3),
            y: target.top + target.height / 2,
            right: false,
          }
        : step === 'open-tab'
          ? { x: target.left + target.width / 2, y: target.top + target.height / 2, right: false }
          : null;

  const dim =
    step === 'intro' ||
    step === 'open-tab' ||
    step === 'right-click' ||
    step === 'tick' ||
    step === 'row';
  // open-tab 只是前置步骤,和 right-click 共用一个点
  const dotSteps = COORDINATOR_TOUR_STEPS.filter((s) => s !== 'open-tab');
  const dotIndex = dotSteps.indexOf(step === 'open-tab' ? 'right-click' : step);
  const dots = dotSteps.length;

  const fintunerPrompt = tx(
    '你是这个项目的 Fintuner。读这个文件夹最近的 Claude Code 对话记录(~/.claude/projects 里对应本项目的 .jsonl)和运行历史,找出:哪里浪费了时间或 token,哪些步骤可以合并或交给协调者自动做,哪些问题反复来问我、其实可以定成规则。给我一份按收益排序的改进清单,每条写明具体怎么改。',
    "You are this project's Fintuner. Read the recent Claude Code chat history for this folder (its .jsonl files under ~/.claude/projects) and the run history, and find: where time or tokens were wasted, which steps could be merged or handed to the coordinator, and which questions keep coming back to me and could become rules. Give me a list of improvements ranked by payoff, each with exactly what to change.",
  );
  // 开 Fintuner:用快捷启动里的 Claude Code 开 (WSL / SSH 文件夹的 shell 规则都在那里),
  // 改名 Fintuner,复制提示,结束引导。提示不替用户发送,读历史要花 token,由用户按 Enter。
  const openFintuner = async (): Promise<void> => {
    const item = quickLaunch.items.find((i) => i.key === 'template:claude-code');
    let sessionId: string | null = null;
    if (item) {
      sessionId = await quickLaunch.launch(item);
    } else if (state.selectedPathId) {
      try {
        const dims = state.lastTerminalDims;
        const res = await window.api.invoke<unknown, CreateSessionResponse>(
          COMMAND_CHANNELS.SESSION_CREATE,
          {
            pathId: state.selectedPathId,
            templateId: 'claude-code',
            cols: dims.cols,
            rows: dims.rows,
          },
        );
        sessionId = res.session.id;
      } catch (err) {
        showError(err instanceof Error ? err.message : String(err));
      }
    }
    if (!sessionId) return;
    renameTab(sessionId, FINTUNER_NAME);
    // Fintuner 和 Coordinator 同级:同样打上协调者标记,放进上方那一行。
    // 不派发 COORDINATOR_GUIDE_EVENT,否则它会被改名成 Coordinator。
    window.api
      .invoke(COMMAND_CHANNELS.SESSION_SET_COORDINATOR, { sessionId, coordinator: true })
      .catch((err: unknown) => console.warn('[CoordinatorTour] mark Fintuner failed', err));
    try {
      await navigator.clipboard.writeText(fintunerPrompt);
      toast.push({
        kind: 'success',
        message: tx(
          `${FINTUNER_NAME} 已打开,提示已复制。等它启动后粘贴,按 Enter。`,
          `${FINTUNER_NAME} is open and its prompt is copied. Paste it once it starts, then press Enter.`,
        ),
        durationMs: 8000,
      });
    } catch (err) {
      showError(err instanceof Error ? err.message : String(err));
    }
    void saveExtensions({ tabControlGuideSeen: true }, showError);
  };

  const install = (): void => {
    const dir = marketplaceDir;
    if (dir) void typer.run((shellId) => tabControlInstallLine(shellId, dir), showError);
  };

  // 文字尽量一行:引导叠在真界面上,读得越少越好
  const copy: Record<CoordinatorTourStep, { title: string; body: string }> = {
    intro: {
      title: tx('两个角色', 'Two roles'),
      body: tx(
        '这是推荐用法,不是内置功能:两者都是普通的 Claude Code 标签,角色看你交给它的任务。',
        'A recommended setup, not built-in features: both are plain Claude Code tabs, and the role is the job you give them.',
      ),
    },
    'open-tab': {
      title: tx('开一个 Claude Code', 'Open a Claude Code tab'),
      body: tx('点虚线标签里的这个图标。', 'Click this icon in the dashed tab.'),
    },
    'right-click': {
      title: tx('右键这个标签', 'Right-click this tab'),
      body: tx('把它设为协调者。', 'You will make it the coordinator.'),
    },
    tick: {
      title: tx('勾选“协调者”', 'Tick Coordinator'),
      body: tx(
        `它会改名为 ${COORD_NAME},移到上方一行。`,
        `It is renamed ${COORD_NAME} and moves to a row on top.`,
      ),
    },
    row: {
      title: tx(`这是 ${COORD_NAME}`, `This is ${COORD_NAME}`),
      body: tx('这一行在任何文件夹都看得到。', 'This row shows it from every folder.'),
    },
    enable: {
      title: tx(`允许 ${COORD_NAME} 控制标签`, `Let ${COORD_NAME} control tabs`),
      body: tx('只有协调者标签能用。', 'Only coordinator tabs get this.'),
    },
    plugin: {
      title: tx('装 ceteris-tabs 插件', 'Add the ceteris-tabs plugin'),
      body: tx(
        '命令输入到新终端,你按 Enter 才执行。',
        'The commands go into a new terminal; you press Enter.',
      ),
    },
    start: {
      title: tx(`在 ${COORD_NAME} 里交代任务`, `Give ${COORD_NAME} a job`),
      body: tx(
        '比如:“开两个 Claude Code,一个写测试,一个修 bug,做完告诉我。”',
        'For example: “Open two Claude Code tabs, one for tests and one for the bug, and tell me when both are done.”',
      ),
    },
    fintuner: {
      title: tx('再开一个 Fintuner', 'Now open a Fintuner'),
      body: tx(
        `按钮在上方一行新开 ${FINTUNER_NAME},和 ${COORD_NAME} 同级,并复制好提示。`,
        `The button opens ${FINTUNER_NAME} in the top row, level with ${COORD_NAME}, and copies its prompt.`,
      ),
    },
  };

  return createPortal(
    <div className="ctour" data-dim={dim ? 'true' : 'false'}>
      <div className="ctour-spot" style={spot} />
      {cursor && (
        // key 让每一步重新播放一遍动画
        <div
          key={step}
          className="ctour-cursor"
          data-button={cursor.right ? 'right' : 'left'}
          style={{ left: cursor.x, top: cursor.y }}
          aria-hidden="true"
        >
          <span className="ctour-ripple" />
          <svg className="ctour-arrow" width="20" height="24" viewBox="0 0 20 24">
            <path d="M2 1.5 L2 19 L6.6 14.8 L9.6 21.6 L12.6 20.3 L9.7 13.6 L16 13.4 Z" />
          </svg>
          {cursor.right && <span className="ctour-cursor-label">{tx('右键', 'Right-click')}</span>}
        </div>
      )}
      <div
        ref={bubbleRef}
        key={`bubble-${step}`}
        className="ctour-bubble"
        data-arrow={arrow}
        role="dialog"
        aria-modal="false"
        aria-labelledby="ctour-title"
        style={{
          left: bubbleLeft,
          top: bubbleTop,
          width,
          ['--arrow-x' as string]: `${arrowX}px`,
        }}
      >
        <div
          className="ctour-progress"
          aria-label={tx(`第 ${dotIndex + 1} 步,共 ${dots} 步`, `Step ${dotIndex + 1} of ${dots}`)}
        >
          {Array.from({ length: dots }, (_, i) => (
            <span
              key={i}
              className="ctour-dot"
              data-state={i < dotIndex ? 'done' : i === dotIndex ? 'now' : 'todo'}
            />
          ))}
        </div>
        <p id="ctour-title" className="ctour-title">
          {copy[step].title}
        </p>
        {step === 'intro' && (
          <dl className="ctour-roles">
            <div className="ctour-role">
              <dt>
                <code>{COORD_NAME}</code>
                {tx(' 协调者', '')}
              </dt>
              <dd>
                {tx(
                  '盯着并指挥其他 Claude Code:派活、看进度、收结果。',
                  'Monitors and controls your other Claude Code tabs: hands out work, watches, collects results.',
                )}
              </dd>
            </div>
            <div className="ctour-role">
              <dt>
                <code>{FINTUNER_NAME}</code>
              </dt>
              <dd>
                {tx(
                  '读对话历史,找出省时间、提效率的办法。',
                  'Reads the chat history and finds ways to save time and work faster.',
                )}
              </dd>
            </div>
          </dl>
        )}
        <p className="ctour-body">{copy[step].body}</p>
        <div className="ctour-actions">
          {step !== 'fintuner' && (
            <button
              type="button"
              className="ctour-quiet"
              onClick={() => void saveExtensions({ tabControlGuideSeen: true }, showError)}
            >
              {tx('不再提示', "Don't show again")}
            </button>
          )}
          <span className="ctour-spacer" />
          {step !== 'fintuner' && (
            <button type="button" className="ctour-quiet" onClick={() => setOpen(false)}>
              {tx('稍后', 'Later')}
            </button>
          )}
          {step === 'intro' && (
            <button type="button" className="ctour-primary" onClick={() => setIntroSeen(true)}>
              {tx('开始', 'Start')}
            </button>
          )}
          {step === 'row' && (
            <button type="button" className="ctour-primary" onClick={() => setRowSeen(true)}>
              {tx('下一步', 'Next')}
            </button>
          )}
          {step === 'enable' && (
            <button
              type="button"
              className="ctour-primary"
              onClick={() => void saveExtensions({ tabControl: true }, showError)}
            >
              {tx('打开', 'Turn on')}
            </button>
          )}
          {step === 'plugin' && (
            <button
              type="button"
              className="ctour-primary"
              disabled={typer.preparing || !marketplaceDir}
              onClick={install}
            >
              {tx('输入安装命令', 'Type the commands')}
            </button>
          )}
          {step === 'start' && (
            <button type="button" className="ctour-primary" onClick={() => setStartSeen(true)}>
              {tx('下一步', 'Next')}
            </button>
          )}
          {step === 'fintuner' && (
            <>
              <button
                type="button"
                className="ctour-quiet"
                onClick={() => void saveExtensions({ tabControlGuideSeen: true }, showError)}
              >
                {tx('完成', 'Done')}
              </button>
              <button
                type="button"
                className="ctour-primary"
                disabled={!state.selectedPathId}
                onClick={() => void openFintuner()}
              >
                {tx('开 Fintuner', 'Open Fintuner')}
              </button>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
