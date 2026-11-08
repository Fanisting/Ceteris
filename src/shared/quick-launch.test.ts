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
    expect(isValidQuickLaunchItems([template('x'), { kind: 'shell', id: 'x' }])).toBe(true);
  });

  it.each([
    ['非数组', 'claude-code'],
    ['null', null],
    ['null 项', [null]],
    ['未知类型', [{ kind: 'command', id: 'x' }]],
    ['空 id', [template('')]],
    ['id 非字符串', [{ kind: 'template', id: 1 }]],
    ['重复项', [template('a'), template('a')]],
    ['超过上限', Array.from({ length: QUICK_LAUNCH_MAX_ITEMS + 1 }, (_, i) => template(`t${i}`))],
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
  const anchor = { x: 300, y: 40 };
  const all = [1, 2, 3, 4, 5, 6, 7, 8];

  it('0 个选项返回空', () => {
    expect(radialPositions(0, anchor, 1200)).toEqual([]);
  });

  it.each(all)('%i 个选项全在 + 号右侧,不盖住左边的侧栏', (count) => {
    for (const p of radialPositions(count, anchor, 1200)) {
      expect(p.x).toBeGreaterThanOrEqual(anchor.x - 1e-6);
    }
  });

  it.each(all)('%i 个选项都明显低于 + 号,不会盖住同一行的标签文字', (count) => {
    // 圆的半径 21px,加上标签文字半行高 8px
    for (const p of radialPositions(count, anchor, 1200)) {
      expect(p.y - anchor.y).toBeGreaterThan(29);
    }
  });

  it.each(all)('%i 个选项两两之间都不重叠', (count) => {
    const points = radialPositions(count, anchor, 1200);
    expect(points).toHaveLength(count);
    for (let i = 0; i < points.length; i += 1) {
      for (let j = i + 1; j < points.length; j += 1) {
        expect(
          Math.hypot(points[i]!.x - points[j]!.x, points[i]!.y - points[j]!.y),
        ).toBeGreaterThanOrEqual(70);
      }
    }
  });

  it('8 个选项也在 + 号 230px 以内,鼠标不用走太远', () => {
    for (const p of radialPositions(8, anchor, 1200)) {
      expect(Math.hypot(p.x - anchor.x, p.y - anchor.y)).toBeLessThanOrEqual(230);
    }
  });

  it('贴窗口右边时整组左移,留在视口内', () => {
    for (const p of radialPositions(8, { x: 1150, y: 40 }, 1200)) {
      expect(p.x + 21).toBeLessThanOrEqual(1200);
    }
  });

  it('窗口极窄时居中,不产生 NaN', () => {
    for (const p of radialPositions(8, anchor, 100)) {
      expect(Number.isFinite(p.x)).toBe(true);
    }
  });
});
