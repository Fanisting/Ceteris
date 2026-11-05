/**
 * @file src/shared/quick-launch.test.ts
 * @purpose 覆盖快捷启动的默认值、校验、勾选逻辑和环绕布局几何。
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_QUICK_LAUNCH_ITEMS,
  QUICK_LAUNCH_MAX_ITEMS,
  isValidQuickLaunchItems,
  quickLaunchItemKey,
  radialPositions,
  toggleQuickLaunchItem,
  type QuickLaunchItem,
} from './quick-launch';

const template = (id: string): QuickLaunchItem => ({ kind: 'template', id });

describe('默认选项', () => {
  it('是 Claude Code 和 Codex', () => {
    expect(DEFAULT_QUICK_LAUNCH_ITEMS).toEqual([template('claude-code'), template('codex')]);
  });
});

describe('isValidQuickLaunchItems', () => {
  it('接受默认值、空列表、shell 选项', () => {
    expect(isValidQuickLaunchItems([...DEFAULT_QUICK_LAUNCH_ITEMS])).toBe(true);
    expect(isValidQuickLaunchItems([])).toBe(true);
    expect(isValidQuickLaunchItems([{ kind: 'shell', id: 'pwsh' }])).toBe(true);
  });

  it('模板和 shell 可以同 id', () => {
    expect(
      isValidQuickLaunchItems([template('x'), { kind: 'shell', id: 'x' }]),
    ).toBe(true);
  });

  it.each([
    ['非数组', 'claude-code'],
    ['null', null],
    ['null 项', [null]],
    ['未知类型', [{ kind: 'command', id: 'x' }]],
    ['空 id', [template('')]],
    ['id 非字符串', [{ kind: 'template', id: 1 }]],
    ['重复项', [template('a'), template('a')]],
    [
      '超过上限',
      Array.from({ length: QUICK_LAUNCH_MAX_ITEMS + 1 }, (_, i) => template(`t${i}`)),
    ],
  ])('拒绝 %s', (_name, value) => {
    expect(isValidQuickLaunchItems(value)).toBe(false);
  });
});

describe('toggleQuickLaunchItem', () => {
  it('未勾选时加到末尾', () => {
    expect(toggleQuickLaunchItem([template('a')], template('b'))).toEqual([
      template('a'),
      template('b'),
    ]);
  });

  it('已勾选时移除', () => {
    expect(toggleQuickLaunchItem([template('a'), template('b')], template('a'))).toEqual([
      template('b'),
    ]);
  });

  it('已达上限时不再添加,但仍可移除', () => {
    const full = Array.from({ length: QUICK_LAUNCH_MAX_ITEMS }, (_, i) => template(`t${i}`));
    expect(toggleQuickLaunchItem(full, template('new'))).toEqual(full);
    expect(toggleQuickLaunchItem(full, template('t0'))).toHaveLength(QUICK_LAUNCH_MAX_ITEMS - 1);
  });

  it('不修改入参', () => {
    const items = [template('a')];
    toggleQuickLaunchItem(items, template('b'));
    expect(items).toHaveLength(1);
  });
});

describe('quickLaunchItemKey', () => {
  it('区分类型', () => {
    expect(quickLaunchItemKey(template('x'))).not.toBe(
      quickLaunchItemKey({ kind: 'shell', id: 'x' }),
    );
  });
});

describe('radialPositions', () => {
  const anchor = { x: 600, y: 40 };
  const distance = (a: { x: number; y: number }, b: { x: number; y: number }): number =>
    Math.hypot(a.x - b.x, a.y - b.y);

  it('0 个选项返回空', () => {
    expect(radialPositions(0, anchor, 1200)).toEqual([]);
  });

  it('1 个选项在 + 号正下方', () => {
    const [only] = radialPositions(1, anchor, 1200);
    expect(only?.x).toBe(600);
    expect(only?.y).toBeGreaterThan(anchor.y);
  });

  it('两个默认选项分列 + 号左右', () => {
    const [left, right] = radialPositions(2, anchor, 1200);
    expect(left!.x).toBeLessThan(anchor.x);
    expect(right!.x).toBeGreaterThan(anchor.x);
  });

  it.each([1, 2, 3, 4, 5, 6, 7, 8])(
    '%i 个选项都明显低于 + 号,不会盖住同一行的标签文字',
    (count) => {
      for (const p of radialPositions(count, anchor, 1200)) {
        expect(p.y - anchor.y).toBeGreaterThan(21);
      }
    },
  );

  it.each([2, 3, 4, 5, 6, 7, 8])('%i 个选项都在 + 号下方且互不重叠', (count) => {
    const points = radialPositions(count, anchor, 1200);
    expect(points).toHaveLength(count);
    for (const p of points) expect(p.y).toBeGreaterThanOrEqual(anchor.y - 1e-6);
    for (let i = 1; i < points.length; i += 1) {
      expect(distance(points[i]!, points[i - 1]!)).toBeGreaterThanOrEqual(70);
    }
  });

  it.each([
    ['贴右边', 1190],
    ['贴左边', 10],
  ])('%s时整组留在视口内', (_name, x) => {
    for (const p of radialPositions(8, { x, y: 40 }, 1200)) {
      expect(p.x - 21).toBeGreaterThanOrEqual(0);
      expect(p.x + 21).toBeLessThanOrEqual(1200);
    }
  });

  it('窗口极窄时居中,不产生 NaN', () => {
    for (const p of radialPositions(8, anchor, 100)) {
      expect(Number.isFinite(p.x)).toBe(true);
    }
  });
});
