/**
 * @file src/shared/pane-layout.ts
 * @purpose Which session each terminal pane shows. Pure, so the rules are testable
 *   without a renderer.
 *
 * Rules:
 * - The selected session is always on screen.
 * - Sessions keep their pane while they stay visible, so changing the selection never
 *   rebuilds a terminal that is already showing.
 * - No selection means the user pressed "new": the last pane stays empty for the picker.
 * - Sessions held by another window are never taken.
 * - Dividers: every split layout has at most one column line and one row line. Their places
 *   are fractions of the track space, so they survive window resizes and layout changes.
 *   Each side keeps at least MIN_PANE_PX, unless the grid is too small for both.
 *
 * @关键设计 Pure functions only; MainPane / PaneDividers hold the state and the DOM.
 * @对应文档章节 软件定义书.md 6.4 (终端区域)
 * @不要在这里做的事 No DOM, no React, no persistence. The split stays in memory like the layout.
 */
import type { SessionInfo } from './types';

export type PaneLayoutId = 'single' | 'rows' | 'cols' | 'main-left' | 'main-right' | 'grid';

export const PANE_COUNTS: Record<PaneLayoutId, number> = {
  single: 1,
  rows: 2,
  cols: 2,
  'main-left': 3,
  'main-right': 3,
  grid: 4,
};

/** Where the dividers sit: fraction of the track space given to the first column / row. */
export interface PaneSplit {
  col: number;
  row: number;
}

export const DEFAULT_PANE_SPLIT: PaneSplit = { col: 0.5, row: 0.5 };

/** Smallest pane width or height a drag may leave, in CSS pixels. */
export const MIN_PANE_PX = 120;

/**
 * Which dividers a layout has. The row line of main-left only runs through the right
 * column, and that of main-right through the left one; the renderer draws it that way.
 */
export const PANE_DIVIDERS: Record<PaneLayoutId, { col: boolean; row: boolean }> = {
  single: { col: false, row: false },
  rows: { col: false, row: true },
  cols: { col: true, row: false },
  'main-left': { col: true, row: true },
  'main-right': { col: true, row: true },
  grid: { col: true, row: true },
};

/**
 * Turns a pointer position into a divider fraction.
 *
 * @param offset pointer distance from the start of the track space (grid edge plus padding),
 *   measured to the middle of the gap, in px
 * @param trackSpace grid size minus padding and gap, in px: the space the two tracks share
 * @param minPx smallest size either side may get
 * @returns a fraction in (0, 1). Each side keeps minPx when trackSpace allows; a grid smaller
 *   than 2 × minPx keeps the divider in the middle. Bad input (NaN, empty grid) gives 0.5.
 */
export function splitFraction(offset: number, trackSpace: number, minPx = MIN_PANE_PX): number {
  if (!Number.isFinite(offset) || !Number.isFinite(trackSpace) || trackSpace <= 0) return 0.5;
  const margin = Math.min(0.5, Math.max(0, minPx) / trackSpace);
  return Math.min(1 - margin, Math.max(margin, offset / trackSpace));
}

type PaneSession = Pick<SessionInfo, 'id' | 'ownerWindowId'>;

/**
 * @param sessions sessions of the selected path, in tab order
 * @returns one entry per pane; null is an empty pane
 */
export function computePaneSlots<S extends PaneSession>(
  layout: PaneLayoutId,
  sessions: readonly S[],
  selectedSessionId: string | null,
  myWindowId: string,
): Array<S | null> {
  const count = PANE_COUNTS[layout];
  const usable = sessions.filter((s) => s.ownerWindowId === null || s.ownerWindowId === myWindowId);
  const selected = usable.find((s) => s.id === selectedSessionId) ?? null;

  let shown: S[];
  if (!selected) {
    shown = usable.slice(0, Math.max(0, count - 1));
  } else if (usable.slice(0, count).includes(selected)) {
    shown = usable.slice(0, count);
  } else {
    shown = [...usable.slice(0, count - 1), selected];
  }

  const slots: Array<S | null> = [...shown];
  while (slots.length < count) slots.push(null);
  return slots;
}
