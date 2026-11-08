/**
 * @file src/shared/coordinator-tour.ts
 * @purpose Which step the coordinator tour (ADR-024, renderer CoordinatorTour.tsx) shows. The
 *   tour follows what the user really did, so the step is derived from app state every frame
 *   instead of being a counter the user clicks through.
 *
 * @关键设计:
 * - It opens by introducing two roles: the Coordinator, a tab that monitors and controls your
 *   Claude Code agents, and the Fintuner, an agent that reads the project's chat history and
 *   finds where to save time, cost and your decisions. It ends with how to start a Fintuner.
 * - Making a coordinator comes next: open a tab, right-click it, tick Coordinator. Each of these
 *   is detected (a folder tab exists, the tab menu is open, a coordinator exists).
 * - The intro, coordinator row and start steps are acknowledged with Next, because nothing in
 *   the app changes when someone has read them.
 * - The setting and plugin steps drop out once they are already done, so a user who set things up
 *   by hand only sees what is left.
 */

export type CoordinatorTourStep =
  | 'intro'
  | 'open-tab'
  | 'right-click'
  | 'tick'
  | 'row'
  | 'enable'
  | 'plugin'
  | 'start'
  | 'fintuner';

/** The steps in order, for the progress dots. `open-tab` only appears when no tab is open. */
export const COORDINATOR_TOUR_STEPS: readonly CoordinatorTourStep[] = [
  'intro',
  'open-tab',
  'right-click',
  'tick',
  'row',
  'enable',
  'plugin',
  'start',
  'fintuner',
];

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
  /** settings.extensions.tabControl */
  enabled: boolean;
  /** Claude Code lists the ceteris-tabs plugin; null while not checked yet. */
  pluginInstalled: boolean | null;
  /** The user pressed Next on the start step. */
  startSeen: boolean;
}

export function coordinatorTourStep(input: CoordinatorTourInput): CoordinatorTourStep {
  if (!input.introSeen) return 'intro';
  if (!input.hasCoordinator) {
    if (input.menuOpen) return 'tick';
    return input.hasFolderTab ? 'right-click' : 'open-tab';
  }
  if (!input.rowSeen) return 'row';
  if (!input.enabled) return 'enable';
  if (input.pluginInstalled !== true) return 'plugin';
  return input.startSeen ? 'fintuner' : 'start';
}
