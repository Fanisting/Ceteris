/**
 * @file src/shared/quick-launch.test.ts
 * @purpose 覆盖快捷启动的默认值、校验和勾选逻辑。
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_QUICK_LAUNCH_ITEMS,
  QUICK_LAUNCH_MAX_ITEMS,
  isValidQuickLaunchItems,
  quickLaunchItemKey,
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
