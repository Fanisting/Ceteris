import { describe, expect, it } from 'vitest';
import { computePaneSlots, PANE_COUNTS, PANE_DIVIDERS, splitFraction } from './pane-layout';

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

describe('splitFraction', () => {
  it('maps the pointer offset to a fraction of the track space', () => {
    expect(splitFraction(300, 1000, 120)).toBeCloseTo(0.3);
  });

  it('keeps each side at least minPx wide', () => {
    expect(splitFraction(10, 1000, 120)).toBeCloseTo(0.12);
    expect(splitFraction(995, 1000, 120)).toBeCloseTo(0.88);
    expect(splitFraction(-50, 1000, 120)).toBeCloseTo(0.12);
  });

  it('keeps the divider in the middle when the grid is smaller than two minimum panes', () => {
    expect(splitFraction(30, 200, 120)).toBe(0.5);
  });

  it('falls back to the middle for an empty grid or bad numbers', () => {
    expect(splitFraction(100, 0)).toBe(0.5);
    expect(splitFraction(Number.NaN, 1000)).toBe(0.5);
    expect(splitFraction(100, Number.POSITIVE_INFINITY)).toBe(0.5);
  });
});

describe('PANE_DIVIDERS', () => {
  it('gives a divider exactly where a layout has two tracks', () => {
    expect(PANE_DIVIDERS.single).toEqual({ col: false, row: false });
    expect(PANE_DIVIDERS.rows).toEqual({ col: false, row: true });
    expect(PANE_DIVIDERS.cols).toEqual({ col: true, row: false });
    for (const l of ['main-left', 'main-right', 'grid'] as const) {
      expect(PANE_DIVIDERS[l]).toEqual({ col: true, row: true });
    }
  });
});
