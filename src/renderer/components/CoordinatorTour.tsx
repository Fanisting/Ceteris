/**
 * @file src/renderer/components/CoordinatorTour.tsx
 * @purpose The coordinator tour (ADR-024): an animated, step-by-step guide on top of the real
 *   window. It first introduces three roles: the Coordinator, which monitors and controls your
 *   other agents; Workers, the normal tabs of its folder that take its work; and the
 *   Fintuner, which learns from the chat history where to save time and work more efficiently. Then it spotlights the tab to right-click, plays a cursor doing
 *   it, points at the Coordinator item in the menu, the new coordinator row, the setting and the
 *   plugin install, shows how to add normal tabs as workers, how to give the coordinator a job, and ends with a button that opens
 *   a Fintuner.
 * - The roles are a recommended way to use tabs, not code: a coordinator is an agent tab with
 *   the Coordinator mark (ADR-023/024), a Fintuner is an agent tab with a prompt. The
 *   intro says so. Roles are given from the tab menu (Role → Worker / Coordinator /
 *   Fintuner) or by the tour, through SessionManager.setRole, which renames the tab to the role
 *   and puts both roles in the row above the tabs, at the same level (@shared/session-role).
 *
 * @关键设计:
 * - It points at the real UI and the user does the real thing; the tour never clicks for them,
 *   except the "Set it up for me" link of the Fintuner part, which opens and names the tab.
 * - Prompts are pasted, not sent: "Paste an example" types a first job into the Coordinator,
 *   and the Fintuner gets its brief once its agent has started (waitUntilSettled). The user
 *   reads it and presses Enter. Any tab that becomes a Fintuner during that part gets the brief
 *   once (pasteBrief), whether the user picked the role or used the shortcut. Prompts come in Chinese and English (@shared/coordinator-prompts)
 *   and follow the interface language. If the agent never settles, the brief goes to the
 *   clipboard instead.
 *   The overlay lets every click through (pointer-events: none) except on its own bubble.
 * - The step comes from app state (coordinatorTourStep in @shared/coordinator-tour), checked
 *   every animation frame together with where the target is. Right-clicking a tab, ticking
 *   Coordinator or turning the setting on moves the tour forward by itself.
 * - It does not assume Claude Code. It points at whichever agent comes first among the quick
 *   launch icons, the Fintuner runs the same agent as the coordinator, and the setting and plugin
 *   steps (Claude Code only) drop out for a coordinator running another agent, or when the user
 *   says they do not use Claude Code (canControlTabs in @shared/coordinator-tour).
 * - Targets are found through data attributes: the first agent data-quick-key inside
 *   data-guide="ghost-tab" (an agent icon among the quick launch icons, falling back to
 *   the tab itself and then to data-guide="new-tab", the +),
 *   data-session-id (each tab), data-guide="role" and "role-coordinator" (the Role menu item
 *   and its Coordinator choice) and
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
  canControlTabs,
  coordinatorTourStep,
  type CoordinatorTourInput,
  type CoordinatorTourStep,
} from '@shared/coordinator-tour';
import {
  COORDINATOR_GUIDE_EVENT,
  tabControlInstallLine,
  type TabControlStatus,
} from '@shared/tab-control';
import type { CreateSessionResponse, SetRolePayload } from '@shared/protocol';
import { SESSION_ROLE_NAMES, WORKER_ROLE_NAME, type SessionRole } from '@shared/session-role';
import { COORDINATOR_JOB_PROMPT, FINTUNER_PROMPT } from '@shared/coordinator-prompts';
import { useAppDispatch, useAppState, useAppStateRef, type AppState } from '../store';
import { useTranslation } from './LanguageProvider';
import { useToast } from './Toast';
import { typeIntoSession, useTypeIntoNewTerminal } from './type-into-terminal';
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
const COORD_NAME = SESSION_ROLE_NAMES.coordinator;
const FINTUNER_NAME = SESSION_ROLE_NAMES.fintuner;
/** What the tour calls the normal tabs a coordinator directs. They keep their own names. */
const WORKER_NAME = WORKER_ROLE_NAME;

/** How long a new agent may take to start before its prompt goes to the clipboard instead. */
const SETTLE_TIMEOUT_MS = 30_000;
/** Quiet time after the agent's start-up output that counts as ready for input. */
const SETTLE_QUIET_MS = 1500;
const SETTLE_POLL_MS = 250;

/**
 * Wait until a newly opened agent tab is ready to take typed input: it printed its start-up
 * screen (state went active) and then stayed quiet for SETTLE_QUIET_MS, or its agent phase says
 * done. Typing earlier can land in the shell before the agent starts, or be dropped.
 * Resolves false when the tab exits or the wait times out.
 */
async function waitUntilSettled(
  stateRef: { current: AppState },
  sessionId: string,
): Promise<boolean> {
  const started = Date.now();
  // 已经开了一会儿的标签 (用户拿现有标签当 Fintuner) 不会再有启动输出,安静够久也算好了
  let sawOutput = (stateRef.current.sessions.get(sessionId)?.createdAt ?? started) < started - 5000;
  let quietSince: number | null = null;
  while (Date.now() - started < SETTLE_TIMEOUT_MS) {
    const session = stateRef.current.sessions.get(sessionId);
    if (session?.state === 'exited') return false;
    if (session?.agentPhase === 'done') return true;
    if (session?.state === 'active') {
      sawOutput = true;
      quietSince = null;
    } else if (session && sawOutput) {
      quietSince ??= Date.now();
      if (Date.now() - quietSince >= SETTLE_QUIET_MS) return true;
    }
    await new Promise((resolve) => setTimeout(resolve, SETTLE_POLL_MS));
  }
  return false;
}

/** Give a tab a role the way the tab menu does; main renames it. Failures go to the console. */
function setRole(sessionId: string, role: SessionRole | null): void {
  const payload: SetRolePayload = { sessionId, role };
  window.api
    .invoke(COMMAND_CHANNELS.SESSION_SET_ROLE, payload)
    .catch((err: unknown) => console.warn(`[CoordinatorTour] set role ${role} failed`, err));
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
  /** The coordinator's folder shows at least one normal tab, which is a worker. */
  hasWorker: boolean;
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

/** Quick launch keys of plain shells; every other quick launch template is an agent. */
const SHELL_QUICK_KEY = /^(shell:|template:(shell|admin-shell)$)/;

/** Whether a quick launch key starts an agent rather than a plain shell. */
function isAgentKey(key: string): boolean {
  return !SHELL_QUICK_KEY.test(key);
}

/**
 * Where to open an agent tab: the first agent icon among the quick launch icons (GhostTab),
 * whatever agent the user put there, else the icon group, else the + when quick launch is empty.
 */
function agentLauncher(): Element | null {
  const icons = [...document.querySelectorAll('[data-guide="ghost-tab"] [data-quick-key]')];
  return (
    icons.find((el) => isAgentKey(el.getAttribute('data-quick-key') ?? '')) ??
    document.querySelector('[data-guide="ghost-tab"]') ??
    document.querySelector('[data-guide="new-tab"]')
  );
}

/** The box around every normal tab of the current folder: the workers. */
function workerTabs(): Rect | null {
  const tabs = [
    ...document.querySelectorAll('.tab-bar:not(.coordinator-bar) .tab[data-session-id]'),
  ];
  const rects = tabs.map(rectOf).filter((r): r is Rect => r !== null);
  if (rects.length === 0) return null;
  const left = Math.min(...rects.map((r) => r.left));
  const top = Math.min(...rects.map((r) => r.top));
  const right = Math.max(...rects.map((r) => r.left + r.width));
  const bottom = Math.max(...rects.map((r) => r.top + r.height));
  return { left, top, width: right - left, height: bottom - top };
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
  const stateRef = useAppStateRef();
  const dispatch = useAppDispatch();
  const toast = useToast();
  const typer = useTypeIntoNewTerminal();
  const seen = state.settings.extensions?.tabControlGuideSeen ?? false;
  const enabled = state.settings.extensions?.tabControl ?? false;
  // 启动时没看过就打开;之后勾选协调者能再打开它
  const [open, setOpen] = useState(!seen);
  const [introSeen, setIntroSeen] = useState(false);
  const [rowSeen, setRowSeen] = useState(false);
  const [workerSeen, setWorkerSeen] = useState(false);
  // 用户说自己不用 Claude Code:跳过设置和插件两步
  const [noClaude, setNoClaude] = useState(false);
  const [startSeen, setStartSeen] = useState(false);
  // Fintuner 那一段开始时已有的标签和 Fintuner:之后新开的标签才算候选,新出现的 Fintuner 才粘贴
  const [fintunerBaseline, setFintunerBaseline] = useState<{
    sessions: Set<string>;
    fintuners: Set<string>;
  } | null>(null);
  const pastedRef = useRef(new Set<string>());
  const [pastedInto, setPastedInto] = useState<string | null>(null);
  const [coordId, setCoordId] = useState<string | null>(null);
  const [pluginInstalled, setPluginInstalled] = useState<boolean | null>(null);
  const [marketplaceDir, setMarketplaceDir] = useState<string | null>(null);
  const [probe, setProbe] = useState<Probe | null>(null);
  const [bubbleHeight, setBubbleHeight] = useState(180);
  const bubbleRef = useRef<HTMLDivElement>(null);

  const quickLaunch = useQuickLaunch(state.selectedPathId, 16);

  const showError = (message: string): void => {
    toast.push({ kind: 'error', message });
  };

  // 设成 Coordinator:打开引导 (改名在 main 的 setRole 里已经做了)
  useEffect(() => {
    const onTicked = (e: Event): void => {
      const detail = (e as CustomEvent<{ sessionId?: string } | undefined>).detail;
      setCoordId(detail?.sessionId ?? null);
      setOpen(true);
    };
    window.addEventListener(COORDINATOR_GUIDE_EVENT, onTicked);
    return () => window.removeEventListener(COORDINATOR_GUIDE_EVENT, onTicked);
  }, []);

  // 一次只出一个引导:"右键 + 号快速启动" 的气泡 (QuickLaunchTip) 也指着 + 号,先等它被关掉
  const quickLaunchTipShowing = state.settings.behavior?.quickLaunchTipSeen === false;
  const active = open && !seen && !state.inSettingsView && !quickLaunchTipShowing;

  // Coordinator 角色的标签 (旧的只有 coordinator 标记、没有 role 的也算);Fintuner 不算
  const coordinators = [...state.sessions.values()].filter(
    (s) =>
      s.state !== 'exited' && (s.role === 'coordinator' || (s.coordinator === true && !s.role)),
  );
  const coord = coordinators.find((s) => s.id === coordId) ?? coordinators[0] ?? null;
  const live = [...state.sessions.values()].filter((s) => s.state !== 'exited');
  const fintuners = live.filter((s) => s.role === 'fintuner');
  const newestFintuner = fintuners.sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
  // 候选:Fintuner 那一段开始后新开、还没有角色的标签,取最新的
  const candidate = fintunerBaseline
    ? (live
        .filter((s) => !s.role && !s.coordinator && !fintunerBaseline.sessions.has(s.id))
        .sort((a, b) => b.createdAt - a.createdAt)[0] ?? null)
    : null;
  // 标签控制只有 Claude Code 能用:协调者跑的是别的 agent,或用户说不用,就跳过那两步
  const controlSupported = !noClaude && (coord ? canControlTabs(coord.templateId) : true);

  // 动画帧循环读的是这一帧的状态;放进 ref,循环本身不用随每次渲染重建
  const inputRef = useRef<Omit<CoordinatorTourInput, 'menuOpen' | 'hasFolderTab'>>({
    introSeen: false,
    hasCoordinator: false,
    rowSeen: false,
    workerSeen: false,
    controlSupported: true,
    enabled: false,
    pluginInstalled: null,
    startSeen: false,
    hasFintuner: false,
    hasFintunerCandidate: false,
  });
  inputRef.current = {
    introSeen,
    hasCoordinator: coord !== null,
    rowSeen,
    workerSeen,
    controlSupported,
    enabled,
    pluginInstalled,
    startSeen,
    hasFintuner: newestFintuner !== null,
    hasFintunerCandidate: candidate !== null,
  };
  const coordIdRef = useRef<string | null>(null);
  coordIdRef.current = coord?.id ?? null;
  const candidateIdRef = useRef<string | null>(null);
  candidateIdRef.current = candidate?.id ?? null;
  const fintunerIdRef = useRef<string | null>(null);
  fintunerIdRef.current = newestFintuner?.id ?? null;

  // 进入 Fintuner 那一段时记下已有的标签和 Fintuner
  useEffect(() => {
    if (!startSeen || fintunerBaseline) return;
    const all = [...stateRef.current.sessions.values()];
    setFintunerBaseline({
      sessions: new Set(all.map((s) => s.id)),
      fintuners: new Set(all.filter((s) => s.role === 'fintuner').map((s) => s.id)),
    });
  }, [startSeen, fintunerBaseline, stateRef]);

  // Fintuner 那一段里新出现的 Fintuner (用户选了角色,或点了“直接帮我开好”) 各粘贴一次提示
  const newFintunerId =
    fintunerBaseline && newestFintuner && !fintunerBaseline.fintuners.has(newestFintuner.id)
      ? newestFintuner.id
      : null;
  const pasteBriefRef = useRef<(id: string) => Promise<void>>(async () => {});
  useEffect(() => {
    if (!newFintunerId || !open || seen || pastedRef.current.has(newFintunerId)) return;
    pastedRef.current.add(newFintunerId);
    void pasteBriefRef.current(newFintunerId);
  }, [newFintunerId, open, seen]);

  // 每一帧量一次:现在是哪一步、目标在哪。只有变了才 setState,静止时不重渲染
  useEffect(() => {
    if (!active) {
      setProbe(null);
      return;
    }
    let frame = 0;
    let last: Probe | null = null;
    const tick = (): void => {
      // 菜单开着就指着“角色”,子菜单开着就指着里面要选的角色 (前半段 Coordinator,
      // Fintuner 那一段 Fintuner)
      const pick = inputRef.current.startSeen ? 'role-fintuner' : 'role-coordinator';
      const menuItem =
        document.querySelector(`[data-guide="${pick}"]`) ??
        document.querySelector('[data-guide="role"]');
      const tab = folderTab();
      const step = coordinatorTourStep({
        ...inputRef.current,
        menuOpen: menuItem !== null,
        hasFolderTab: tab !== null,
      });
      let target: Rect | null = null;
      let menu: Rect | null = null;
      if (step === 'intro') {
        // 角色介绍指着当前文件夹的标签栏:agent 们就住在这里
        target = rectOf(document.querySelector('.tab-bar:not(.coordinator-bar) .tab-list'));
      } else if (step === 'open-tab' || step === 'fintuner-open') {
        // 两步都是开一个 agent:指着标签栏末尾第一个 agent 图标
        target = rectOf(agentLauncher());
      } else if (step === 'right-click') target = rectOf(tab);
      else if (step === 'tick' || step === 'fintuner-pick') {
        target = rectOf(menuItem);
        menu = rectOf(menuItem?.closest('.ctx-menu') ?? null);
      } else if (step === 'fintuner-right-click' && candidateIdRef.current) {
        target = rectOf(
          document.querySelector(`.tab[data-session-id="${CSS.escape(candidateIdRef.current)}"]`),
        );
      } else if (step === 'finish' && fintunerIdRef.current) {
        target = rectOf(
          document.querySelector(`.tab[data-session-id="${CSS.escape(fintunerIdRef.current)}"]`),
        );
      } else if (step === 'row') {
        target = rectOf(document.querySelector('[data-guide="coordinator-bar"]'));
      } else if (step === 'worker') {
        // 有普通标签就圈出它们 (这些就是 Worker),没有就指着开 agent 的图标
        target = workerTabs() ?? rectOf(agentLauncher());
      } else if (coordIdRef.current) {
        target = rectOf(
          document.querySelector(
            `[data-guide="coordinator-bar"] [data-session-id="${CSS.escape(coordIdRef.current)}"]`,
          ),
        );
      }
      const next = target ? { step, target, menu, hasWorker: tab !== null } : null;
      const changed =
        (last === null) !== (next === null) ||
        (last !== null &&
          next !== null &&
          (last.step !== next.step ||
            last.hasWorker !== next.hasWorker ||
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

  const { step, target, menu, hasWorker } = probe;
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
  if ((step === 'tick' || step === 'fintuner-pick') && menu) {
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

  // 光标动画演示动作:点 agent 图标、右键标签、点菜单项;中间几步不需要
  const cursor =
    step === 'right-click' || step === 'fintuner-right-click'
      ? { x: target.left + target.width / 2, y: target.top + target.height / 2, right: true }
      : step === 'tick' || step === 'fintuner-pick'
        ? {
            x: target.left + Math.min(60, target.width / 3),
            y: target.top + target.height / 2,
            right: false,
          }
        : step === 'open-tab' || step === 'fintuner-open' || (step === 'worker' && !hasWorker)
          ? { x: target.left + target.width / 2, y: target.top + target.height / 2, right: false }
          : null;

  const dim =
    step === 'intro' ||
    step === 'open-tab' ||
    step === 'right-click' ||
    step === 'tick' ||
    step === 'row' ||
    step === 'worker' ||
    step === 'fintuner-open' ||
    step === 'fintuner-right-click' ||
    step === 'fintuner-pick';
  // 进度点:open-tab 和 right-click 共用一个点,做 Fintuner 的三步共用一个点
  const dotOf = (s: CoordinatorTourStep): CoordinatorTourStep =>
    s === 'open-tab'
      ? 'right-click'
      : s === 'fintuner-right-click' || s === 'fintuner-pick'
        ? 'fintuner-open'
        : s;
  const dotSteps = COORDINATOR_TOUR_STEPS.filter((s) => dotOf(s) === s);
  const dotIndex = dotSteps.indexOf(dotOf(step));
  const dots = dotSteps.length;

  // 提示跟界面语言走:中文用户拿到中文写的版本,英文用户拿到英文写的版本
  const fintunerPrompt = tx(FINTUNER_PROMPT.zh, FINTUNER_PROMPT.en);
  const jobPrompt = tx(COORDINATOR_JOB_PROMPT.zh, COORDINATOR_JOB_PROMPT.en);

  // 把示例任务粘贴进 Coordinator (它已经在跑,不用等),切到它,让用户看一眼再按 Enter
  const pasteJob = async (): Promise<void> => {
    if (!coord) return;
    try {
      dispatch({ type: 'view/select-path', pathId: coord.pathId });
      dispatch({ type: 'view/select-session', sessionId: coord.id });
      await typeIntoSession(coord.id, jobPrompt);
      toast.push({
        kind: 'success',
        message: tx(
          `例子已粘贴到 ${COORD_NAME},看一眼再按 Enter。`,
          `The example is pasted into ${COORD_NAME}. Read it, then press Enter.`,
        ),
        durationMs: 8000,
      });
    } catch (err) {
      showError(err instanceof Error ? err.message : String(err));
    }
  };

  // 把 Fintuner 的提示粘贴进去:等 agent 安静下来再输入,不按 Enter;起不来就放剪贴板
  const pasteBrief = async (sessionId: string): Promise<void> => {
    if (await waitUntilSettled(stateRef, sessionId)) {
      try {
        await typeIntoSession(sessionId, fintunerPrompt);
        setPastedInto(sessionId);
        toast.push({
          kind: 'success',
          message: tx(
            `提示已粘贴到 ${FINTUNER_NAME},看一眼再按 Enter。`,
            `The brief is pasted into ${FINTUNER_NAME}. Read it, then press Enter.`,
          ),
          durationMs: 8000,
        });
        return;
      } catch (err) {
        console.warn('[CoordinatorTour] pasting the Fintuner brief failed', err);
      }
    }
    try {
      await navigator.clipboard.writeText(fintunerPrompt);
      toast.push({
        kind: 'info',
        message: tx(
          `${FINTUNER_NAME} 启动得有点慢,提示已复制,等它好了粘贴进去再按 Enter。`,
          `${FINTUNER_NAME} is slow to start; its brief is copied. Paste it once it is ready, then press Enter.`,
        ),
        durationMs: 10000,
      });
    } catch (err) {
      showError(err instanceof Error ? err.message : String(err));
    }
  };

  // “直接帮我开好”:和协调者用同一个 agent 开一个标签并给它 Fintuner 角色 (协调者是 shell
  // 时用快捷启动里第一个 agent)。粘贴由下面的监视统一做,这里不粘贴。
  const coordAgentKey = coord ? `template:${coord.templateId}` : null;
  const fintunerItem =
    quickLaunch.items.find((i) => i.key === coordAgentKey && isAgentKey(i.key)) ??
    quickLaunch.items.find((i) => isAgentKey(i.key)) ??
    null;
  const fintunerTemplateId =
    coord && isAgentKey(`template:${coord.templateId}`) ? coord.templateId : 'claude-code';
  const openFintuner = async (): Promise<void> => {
    let sessionId: string | null = null;
    if (fintunerItem) {
      sessionId = await quickLaunch.launch(fintunerItem);
    } else if (state.selectedPathId) {
      try {
        const dims = state.lastTerminalDims;
        const res = await window.api.invoke<unknown, CreateSessionResponse>(
          COMMAND_CHANNELS.SESSION_CREATE,
          {
            pathId: state.selectedPathId,
            templateId: fintunerTemplateId,
            cols: dims.cols,
            rows: dims.rows,
          },
        );
        sessionId = res.session.id;
      } catch (err) {
        showError(err instanceof Error ? err.message : String(err));
      }
    }
    if (sessionId) setRole(sessionId, 'fintuner');
  };

  pasteBriefRef.current = pasteBrief;

  const install = (): void => {
    const dir = marketplaceDir;
    if (dir) void typer.run((shellId) => tabControlInstallLine(shellId, dir), showError);
  };

  // 文字尽量一行:引导叠在真界面上,读得越少越好
  const copy: Record<CoordinatorTourStep, { title: string; body: string }> = {
    intro: {
      title: tx('三个角色', 'Three roles'),
      body: tx(
        '这是推荐用法,不是内置功能:都是普通的 agent 标签(Claude Code、Codex 等),角色看你交给它的任务。',
        'A recommended setup, not built-in features: all are plain agent tabs (Claude Code, Codex and others), and the role is the job you give them.',
      ),
    },
    'open-tab': {
      title: tx('开一个 agent', 'Open an agent'),
      body: tx(
        '点标签栏末尾你常用的 agent 图标,比如 Claude Code 或 Codex。',
        'Click the icon of the agent you use at the end of the tab strip, such as Claude Code or Codex.',
      ),
    },
    'right-click': {
      title: tx('右键这个标签', 'Right-click this tab'),
      body: tx('在菜单里给它一个角色。', 'You will give it a role from the menu.'),
    },
    tick: {
      title: tx(`选 角色 → ${COORD_NAME}`, `Pick Role → ${COORD_NAME}`),
      body: tx(
        `它会改名为 ${COORD_NAME},移到上方一行。`,
        `It is renamed ${COORD_NAME} and moves to a row on top.`,
      ),
    },
    row: {
      title: tx(`这是 ${COORD_NAME}`, `This is ${COORD_NAME}`),
      body: tx('这一行在任何文件夹都看得到。', 'This row shows it from every folder.'),
    },
    worker: hasWorker
      ? {
          title: tx(`这些是 ${WORKER_NAME}`, `These are ${WORKER_NAME}s`),
          body: tx(
            `同一文件夹的普通标签都归 ${COORD_NAME} 指挥。`,
            `Normal tabs in this folder take work from ${COORD_NAME}.`,
          ),
        }
      : {
          title: tx(`加一个 ${WORKER_NAME}`, `Add a ${WORKER_NAME}`),
          body: tx(
            `普通标签就是 ${WORKER_NAME}。点这里开一个,或让 ${COORD_NAME} 自己开。`,
            `Any normal tab is a ${WORKER_NAME}. Open one here, or let ${COORD_NAME} open them.`,
          ),
        },
    enable: {
      title: tx(`允许 ${COORD_NAME} 控制标签`, `Let ${COORD_NAME} control tabs`),
      body: tx(
        '需要 Claude Code,且只有协调者标签能用。',
        'Needs Claude Code, and only coordinator tabs get it.',
      ),
    },
    plugin: {
      title: tx('给 Claude Code 装 ceteris-tabs', 'Add ceteris-tabs to Claude Code'),
      body: tx(
        '命令输入到新终端,你按 Enter 才执行。',
        'The commands go into a new terminal; you press Enter.',
      ),
    },
    start: controlSupported
      ? {
          title: tx(`在 ${COORD_NAME} 里交代任务`, `Give ${COORD_NAME} a job`),
          body: tx(
            '交给它一件值得分给几个 agent 的事。',
            'Give it a task worth splitting across agents.',
          ),
        }
      : {
          title: tx(
            `从 ${COORD_NAME} 盯住 ${WORKER_NAME}`,
            `Watch your ${WORKER_NAME}s from ${COORD_NAME}`,
          ),
          body: tx(
            '自动派活目前只支持 Claude Code。用其他 agent 时,这一行和“运行中 / 等你处理”帮你看谁在跑、谁在等你。',
            'Handing out work by itself needs Claude Code for now. With other agents, this row and the Running / Needs you filters show who runs and who waits for you.',
          ),
        },
    'fintuner-open': {
      title: tx(
        `再开一个 agent 当 ${FINTUNER_NAME}`,
        `Open another agent for the ${FINTUNER_NAME}`,
      ),
      body: tx(
        `${FINTUNER_NAME} 也是一个 agent 标签。点这里开一个。`,
        `The ${FINTUNER_NAME} is an agent tab too. Click here to open one.`,
      ),
    },
    'fintuner-right-click': {
      title: tx('右键这个新标签', 'Right-click the new tab'),
      body: tx(`给它 ${FINTUNER_NAME} 这个角色。`, `You will give it the ${FINTUNER_NAME} role.`),
    },
    'fintuner-pick': {
      title: tx(`选 角色 → ${FINTUNER_NAME}`, `Pick Role → ${FINTUNER_NAME}`),
      body: tx(
        `它会改名为 ${FINTUNER_NAME},和 ${COORD_NAME} 并排在上方,提示自动粘贴进去。`,
        `It is renamed ${FINTUNER_NAME}, sits next to ${COORD_NAME}, and gets its brief pasted in.`,
      ),
    },
    finish: {
      title: tx(`这是 ${FINTUNER_NAME}`, `This is the ${FINTUNER_NAME}`),
      body:
        newestFintuner && pastedInto === newestFintuner.id
          ? tx(
              '提示已粘贴进去,看一眼按 Enter 就开始。',
              'Its brief is pasted in. Read it and press Enter to start.',
            )
          : tx('把提示交给它就能开始。', 'Give it its brief to start.'),
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
                  '盯着并指挥其他 agent:派活、看进度、收结果。',
                  'Monitors and controls your other agents: hands out work, watches, collects results.',
                )}
              </dd>
            </div>
            <div className="ctour-role">
              <dt>
                <code>{WORKER_NAME}</code>
                {tx(' 普通标签', '')}
              </dt>
              <dd>
                {tx(
                  `同一文件夹的其他标签,接 ${COORD_NAME} 派的活。`,
                  `The other tabs of its folder, doing the work ${COORD_NAME} hands out.`,
                )}
              </dd>
            </div>
            <div className="ctour-role">
              <dt>
                <code>{FINTUNER_NAME}</code>
              </dt>
              <dd>
                {tx(
                  '也是一个 agent 标签:读对话历史,找出省时间、提效率的办法。',
                  'An agent tab too: reads the chat history and finds ways to save time and work faster.',
                )}
              </dd>
            </div>
          </dl>
        )}
        <p className="ctour-body">{copy[step].body}</p>
        {step === 'fintuner-open' && (
          <button type="button" className="ctour-link" onClick={() => void openFintuner()}>
            {tx('直接帮我开好', 'Set it up for me')}
          </button>
        )}
        {step === 'finish' && newestFintuner && pastedInto !== newestFintuner.id && (
          <button
            type="button"
            className="ctour-link"
            onClick={() => {
              pastedRef.current.add(newestFintuner.id);
              void pasteBrief(newestFintuner.id);
            }}
          >
            {tx('把提示粘贴进去', 'Paste the brief')}
          </button>
        )}
        {step === 'start' && controlSupported && coord && (
          <button type="button" className="ctour-link" onClick={() => void pasteJob()}>
            {tx(`把一个例子粘贴到 ${COORD_NAME}`, `Paste an example into ${COORD_NAME}`)}
          </button>
        )}
        {(step === 'enable' || step === 'plugin') && (
          <button type="button" className="ctour-link" onClick={() => setNoClaude(true)}>
            {tx('不用 Claude Code?跳过这两步', 'Not using Claude Code? Skip these two steps')}
          </button>
        )}
        <div className="ctour-actions">
          {step !== 'finish' && (
            <button
              type="button"
              className="ctour-quiet"
              onClick={() => void saveExtensions({ tabControlGuideSeen: true }, showError)}
            >
              {tx('不再提示', "Don't show again")}
            </button>
          )}
          <span className="ctour-spacer" />
          {step !== 'finish' && (
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
          {step === 'worker' && (
            <button type="button" className="ctour-primary" onClick={() => setWorkerSeen(true)}>
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
          {step === 'finish' && (
            <button
              type="button"
              className="ctour-primary"
              onClick={() => void saveExtensions({ tabControlGuideSeen: true }, showError)}
            >
              {tx('完成', 'Done')}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
