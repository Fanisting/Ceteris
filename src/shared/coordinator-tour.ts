/**
 * @file src/shared/coordinator-tour.ts
 * @purpose Which step the coordinator tour (ADR-024, renderer CoordinatorTour.tsx) shows. The
 *   tour follows what the user really did, so the step is derived from app state every frame
 *   instead of being a counter the user clicks through.
 *
 * @关键设计:
 * - It opens by introducing three roles: the Coordinator, a tab that monitors and controls your
 *   agents; Workers, the normal tabs of its folder that do the work it hands out;
 *   and the Fintuner, an agent that reads the project's chat history and finds where to save
 *   time, cost and your decisions. The Fintuner is an agent tab too, so the tour ends by making
 *   one the same way as the Coordinator: open an agent, right-click it, Role → Fintuner.
 * - Making a coordinator comes next: open a tab, right-click it, tick Coordinator. Each of these
 *   is detected (a folder tab exists, the tab menu is open, a coordinator exists).
 * - The intro, coordinator row, worker and start steps are acknowledged with Next, because
 *   reading them changes nothing in the app. The worker step shows how to add a worker when
 *   there is none and points at the workers when there are some; either way it waits for Next.
 * - The setting and plugin steps drop out once they are already done, so a user who set things up
 *   by hand only sees what is left.
 * - Not everyone uses Claude Code. Claude Code (plugin) and Codex (config.toml entry) both get
 *   ceteris-tabs; when the coordinator runs another agent (or the user says so) the setting and
 *   plugin steps drop out and the tour shows how to watch the workers instead.
 */

export type CoordinatorTourStep =
  | 'intro'
  | 'open-tab'
  | 'right-click'
  | 'tick'
  | 'row'
  | 'worker'
  | 'enable'
  | 'plugin'
  | 'start'
  | 'fintuner-open'
  | 'fintuner-right-click'
  | 'fintuner-pick'
  | 'finish';

/** The steps in order, for the progress dots. `open-tab` only appears when no tab is open. */
export const COORDINATOR_TOUR_STEPS: readonly CoordinatorTourStep[] = [
  'intro',
  'open-tab',
  'right-click',
  'tick',
  'row',
  'worker',
  'enable',
  'plugin',
  'start',
  'fintuner-open',
  'fintuner-right-click',
  'fintuner-pick',
  'finish',
];

/**
 * Built-in agent templates that cannot use tab control. Claude Code gets the ceteris-tabs plugin
 * and Codex the same server through ~/.codex/config.toml (ADR-033, ADR-042), so neither is here.
 * A shell or a custom template may be running either inside, so those keep the setup steps.
 */
const NO_TAB_CONTROL_TEMPLATE_IDS: ReadonlySet<string> = new Set([
  'opencode',
  'gemini-cli',
  'github-copilot',
  'cursor',
  'aider',
  'pi',
  'omp',
  'qwen-code',
  'amp',
  'crush',
  'kimi',
  'goose',
  'droid',
  'kiro',
  'cline',
  'auggie',
  'kilo',
  'codebuddy',
  'qoder',
  'letta',
]);

/** Whether a coordinator started from this template can use the tab control plugin. */
export function canControlTabs(templateId: string): boolean {
  return !NO_TAB_CONTROL_TEMPLATE_IDS.has(templateId);
}

export interface CoordinatorTourInput {
  /** The user pressed Next on the two roles intro. */
  introSeen: boolean;
  /** A tab that is still running is marked as coordinator. */
  hasCoordinator: boolean;
  /** The tab menu is open and shows the Coordinator item. */
  menuOpen: boolean;
  /** The current folder shows at least one tab the user can right-click. */
  hasFolderTab: boolean;
  /** The user pressed Next on the coordinator row step. */
  rowSeen: boolean;
  /** The user pressed Next on the worker step. */
  workerSeen: boolean;
  /** The coordinator can use tab control: it may run Claude Code or Codex and the user did not opt out. */
  controlSupported: boolean;
  /** settings.extensions.tabControl */
  enabled: boolean;
  /** The coordinator's agent has ceteris-tabs (Claude Code plugin or Codex config entry); null while not checked yet. */
  pluginInstalled: boolean | null;
  /** The user pressed Next on the start step. */
  startSeen: boolean;
  /** A tab has the Fintuner role. */
  hasFintuner: boolean;
  /** An agent tab opened since the Fintuner part began, ready to be given the role. */
  hasFintunerCandidate: boolean;
}

export function coordinatorTourStep(input: CoordinatorTourInput): CoordinatorTourStep {
  if (!input.introSeen) return 'intro';
  if (!input.hasCoordinator) {
    if (input.menuOpen) return 'tick';
    return input.hasFolderTab ? 'right-click' : 'open-tab';
  }
  if (!input.rowSeen) return 'row';
  if (!input.workerSeen) return 'worker';
  if (input.controlSupported) {
    if (!input.enabled) return 'enable';
    if (input.pluginInstalled !== true) return 'plugin';
  }
  if (!input.startSeen) return 'start';
  if (input.hasFintuner) return 'finish';
  if (input.menuOpen) return 'fintuner-pick';
  return input.hasFintunerCandidate ? 'fintuner-right-click' : 'fintuner-open';
}
