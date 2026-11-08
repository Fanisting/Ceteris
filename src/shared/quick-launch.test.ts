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
  // + 号在一个很高的视口正中,不触发平移,便于检查扇形本身的形状
  const anchor = { x: 300, y: 400 };
  const viewport = { width: 1200, height: 800 };
  const all = [1, 2, 3, 4, 5, 6, 7, 8];
  const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-6;

  it('0 个选项返回空', () => {
    expect(radialPositions(0, anchor, viewport)).toEqual([]);
  });

  it.each(all)('%i 个选项全在 + 号右侧,不盖住左边的侧栏', (count) => {
    for (const p of radialPositions(count, anchor, viewport)) {
      expect(p.x).toBeGreaterThan(anchor.x + 21);
    }
  });

  it.each(all)('%i 个选项以穿过 + 号的水平线上下对称', (count) => {
    const points = radialPositions(count, anchor, viewport);
    for (const p of points) {
      const mirror = 2 * anchor.y - p.y;
      expect(points.some((q) => near(q.x, p.x) && near(q.y, mirror))).toBe(true);
    }
  });

  it.each(all)('%i 个选项两两之间都不重叠', (count) => {
    const points = radialPositions(count, anchor, viewport);
    expect(points).toHaveLength(count);
    for (let i = 0; i < points.length; i += 1) {
      for (let j = i + 1; j < points.length; j += 1) {
        const gap = Math.hypot(points[i]!.x - points[j]!.x, points[i]!.y - points[j]!.y);
        expect(gap).toBeGreaterThanOrEqual(70);
      }
    }
  });

  it('8 个选项在空间够时也在 + 号 230px 以内,鼠标不用走太远', () => {
    for (const p of radialPositions(8, anchor, viewport)) {
      expect(Math.hypot(p.x - anchor.x, p.y - anchor.y)).toBeLessThanOrEqual(230);
    }
  });

  // 真实窗口里 + 号中心离顶部约 60px
  const top = { x: 300, y: 60 };

  it.each(all)('%i 个选项在贴窗口顶部的 + 号旁仍以它为轴上下对称,并留在窗口内', (count) => {
    const points = radialPositions(count, top, viewport);
    for (const p of points) {
      expect(p.y - 21).toBeGreaterThanOrEqual(0);
      const mirror = 2 * top.y - p.y;
      expect(points.some((q) => near(q.x, p.x) && near(q.y, mirror))).toBe(true);
    }
  });

  it('贴窗口右边时整组左移,留在视口内', () => {
    for (const p of radialPositions(8, { x: 1150, y: 400 }, viewport)) {
      expect(p.x + 21).toBeLessThanOrEqual(viewport.width);
    }
  });

  it('窗口极小时居中,不产生 NaN', () => {
    for (const p of radialPositions(8, anchor, { width: 100, height: 100 })) {
      expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
    }
  });
});
