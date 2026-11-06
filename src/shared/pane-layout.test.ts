import { describe, expect, it } from 'vitest';
import { computePaneSlots, PANE_COUNTS } from './pane-layout';

const ME = 'me';
const mine = (id: string) => ({ id, ownerWindowId: ME });
const free = (id: string) => ({ id, ownerWindowId: null });
const theirs = (id: string) => ({ id, ownerWindowId: 'other' });
const ids = (slots: Array<{ id: string } | null>) => slots.map((s) => s?.id ?? null);

describe('computePaneSlots', () => {
  it('returns exactly one slot per pane for every layout', () => {
    for (const [layout, count] of Object.entries(PANE_COUNTS)) {
      const slots = computePaneSlots(layout as never, [mine('a')], 'a', ME);
      expect(slots).toHaveLength(count);
    }
  });

  it('single shows only the selected session', () => {
    expect(ids(computePaneSlots('single', [mine('a'), free('b')], 'b', ME))).toEqual(['b']);
  });

  it('fills panes in tab order and leaves spare panes empty', () => {
    expect(ids(computePaneSlots('grid', [mine('a'), free('b')], 'a', ME))).toEqual([
      'a',
      'b',
      null,
      null,
    ]);
  });

  it('keeps a visible session in place when another pane is selected', () => {
    const list = [mine('a'), mine('b'), mine('c')];
    expect(ids(computePaneSlots('main-left', list, 'a', ME))).toEqual(['a', 'b', 'c']);
    expect(ids(computePaneSlots('main-left', list, 'c', ME))).toEqual(['a', 'b', 'c']);
  });

  it('brings a selected session on screen by replacing the last pane', () => {
    const list = [mine('a'), mine('b'), mine('c'), mine('d')];
    expect(ids(computePaneSlots('cols', list, 'd', ME))).toEqual(['a', 'd']);
  });

  it('leaves the last pane free for the picker when nothing is selected', () => {
    const list = [mine('a'), mine('b'), mine('c')];
    expect(ids(computePaneSlots('cols', list, null, ME))).toEqual(['a', null]);
  });

  it('never takes a session held by another window', () => {
    expect(ids(computePaneSlots('cols', [theirs('x'), mine('a')], 'x', ME))).toEqual(['a', null]);
  });

  it('copes with no sessions at all', () => {
    expect(ids(computePaneSlots('rows', [], null, ME))).toEqual([null, null]);
  });
});
