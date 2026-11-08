/**
 * @file src/shared/quick-launch.ts
 * @purpose 快捷启动(标签栏末尾的幽灵标签):选项类型、默认值和校验。
 *
 * @关键设计:
 * - 选项和新建页相同,分模板和已检测到的 shell 两类。存 id 而不是副本,
 *   模板改名后这里自动跟随,模板被删时渲染端直接跳过。
 *
 * @对应文档章节: 软件定义书.md 2 (鼠标优先)
 *
 * @不要在这里做的事:
 * - 不要启动 session,启动在 renderer 的 useQuickLaunch.tsx,走和新建页相同的命令
 */

export interface QuickLaunchItem {
  kind: 'template' | 'shell';
  id: string;
}

/** 幽灵标签里最多放几个图标,再多会挤占真正的标签。 */
export const QUICK_LAUNCH_MAX_ITEMS = 8;

export const DEFAULT_QUICK_LAUNCH_ITEMS: readonly QuickLaunchItem[] = [
  { kind: 'template', id: 'claude-code' },
  { kind: 'template', id: 'codex' },
];

export function quickLaunchItemKey(item: QuickLaunchItem): string {
  return `${item.kind}:${item.id}`;
}

/** 校验设置里的选项列表:类型正确、id 非空、无重复、不超过上限。 */
export function isValidQuickLaunchItems(value: unknown): value is QuickLaunchItem[] {
  if (!Array.isArray(value) || value.length > QUICK_LAUNCH_MAX_ITEMS) return false;
  const seen = new Set<string>();
  for (const item of value as Array<Partial<QuickLaunchItem> | null>) {
    if (!item || (item.kind !== 'template' && item.kind !== 'shell')) return false;
    if (typeof item.id !== 'string' || item.id.length === 0) return false;
    const key = quickLaunchItemKey(item as QuickLaunchItem);
    if (seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}

/** 勾选或取消一个选项。已达上限时再勾选会原样返回,新选项排在末尾。 */
export function toggleQuickLaunchItem(
  items: readonly QuickLaunchItem[],
  item: QuickLaunchItem,
): QuickLaunchItem[] {
  const key = quickLaunchItemKey(item);
  const without = items.filter((existing) => quickLaunchItemKey(existing) !== key);
  if (without.length !== items.length) return without;
  return items.length >= QUICK_LAUNCH_MAX_ITEMS ? [...items] : [...items, item];
}
