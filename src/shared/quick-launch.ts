/**
 * @file src/shared/quick-launch.ts
 * @purpose 右键 + 号弹出的快捷启动:选项类型、默认值、校验,以及环绕布局的几何计算。
 *
 * @关键设计:
 * - 选项和新建页相同,分模板和已检测到的 shell 两类。存 id 而不是副本,
 *   模板改名后这里自动跟随,模板被删时渲染端直接跳过。
 * - + 号在窗口顶部,所以选项排在它下方的一段弧上。数量多时加大半径,不让圆互相重叠。
 *
 * @对应文档章节: 软件定义书.md 2 (鼠标优先)
 *
 * @不要在这里做的事:
 * - 不要启动 session,启动在 QuickLaunchOverlay.tsx,走和新建页相同的命令
 */

export interface QuickLaunchItem {
  kind: 'template' | 'shell';
  id: string;
}

/** 弧上放得下的数量,再多半径过大,鼠标移动距离太长。 */
export const QUICK_LAUNCH_MAX_ITEMS = 8;

export const DEFAULT_QUICK_LAUNCH_ITEMS: readonly QuickLaunchItem[] = [
  { kind: 'template', id: 'claude-code' },
  { kind: 'template', id: 'codex' },
];

const MIN_RADIUS_PX = 64;
/** 相邻两圆圆心的最小间距,要容得下一个文字标签 (标签最宽 76px,见 quick-launch.css)。 */
const ITEM_SPACING_PX = 78;
/** 弧的最大张角:140 度,两端离 + 号的高度差仍大于圆的半径。 */
const MAX_ARC_RAD = (140 * Math.PI) / 180;
const VIEWPORT_MARGIN_PX = 12;
const ITEM_RADIUS_PX = 21;

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

export interface Point {
  x: number;
  y: number;
}

/**
 * 计算各选项圆心位置,在 anchor 下方排成一段弧。
 *
 * 弧不能铺满半圆:半圆两端和 + 号同高,圆会盖住标签文字和侧栏。
 * 数量多时加大半径,而不是把弧拉得更开。
 *
 * @param count 选项数量
 * @param anchor + 号中心,视口坐标
 * @param viewportWidth 视口宽度
 * @returns 圆心坐标,从左到右排列;整组向内平移,保证贴窗口边缘时也不被裁掉
 */
export function radialPositions(count: number, anchor: Point, viewportWidth: number): Point[] {
  if (count <= 0) return [];
  // 弧长 = 半径 × 夹角,每段弧长至少要有 ITEM_SPACING_PX
  const radius = Math.max(MIN_RADIUS_PX, (ITEM_SPACING_PX * (count - 1)) / MAX_ARC_RAD);
  const step = ITEM_SPACING_PX / radius;
  const arc = step * (count - 1);
  const halfWidth = radius * Math.sin(arc / 2);
  const centerX = clampCenterX(anchor.x, halfWidth, viewportWidth);
  return Array.from({ length: count }, (_, i) => {
    const angle = Math.PI / 2 + arc / 2 - step * i;
    return {
      x: centerX + radius * Math.cos(angle),
      y: anchor.y + radius * Math.sin(angle),
    };
  });
}

function clampCenterX(x: number, halfWidth: number, viewportWidth: number): number {
  const reach = halfWidth + ITEM_RADIUS_PX + VIEWPORT_MARGIN_PX;
  // 窗口窄到放不下时居中,而不是让 min 大于 max
  if (reach * 2 > viewportWidth) return viewportWidth / 2;
  return Math.min(Math.max(x, reach), viewportWidth - reach);
}
