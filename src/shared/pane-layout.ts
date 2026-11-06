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
  const usable = sessions.filter(
    (s) => s.ownerWindowId === null || s.ownerWindowId === myWindowId,
  );
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
