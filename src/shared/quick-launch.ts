/**
 * @file src/shared/quick-launch.ts
 * @purpose 右键 + 号弹出的快捷启动:选项类型、默认值、校验,以及环绕布局的几何计算。
 *
 * @关键设计:
 * - 选项和新建页相同,分模板和已检测到的 shell 两类。存 id 而不是副本,
 *   模板改名后这里自动跟随,模板被删时渲染端直接跳过。
 * - 选项在 + 号右侧展开成一个扇形,以穿过 + 号的水平线为对称轴:几层同心弧,
 *   从里往外排,内层放满再放外层。全部在 + 号右侧,不会盖住左边的侧栏。
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

/** 最内层弧的半径。 */
const FIRST_RING_RADIUS_PX = 80;
/** 相邻两层弧的间距:一个圆 (42px) 加它下方的文字标签,再留一点空隙。 */
const RING_GAP_PX = 74;
/** 同一层上相邻两圆的竖直间距:一个圆加它下方的标签,两圆不会碰到。 */
const ROW_SPACING_PX = 70;
const VIEWPORT_MARGIN_PX = 4;
const ITEM_RADIUS_PX = 21;
/** 圆下方文字标签占的高度 (见 quick-launch.css)。 */
const LABEL_HEIGHT_PX = 20;

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
 * 计算各选项圆心位置:在 anchor 右侧排成一个扇形,以穿过 anchor 的水平线为对称轴。
 *
 * 扇形由几层同心弧组成,圆心都在以 anchor 为圆心的弧上。第 k 层最多放 k + 2 个,
 * 内层放满再放外层,同一层的圆竖直方向等距、上下对称,所以越往外越宽,像一把扇子。
 *
 * 对称轴永远是 anchor 所在的水平线,不会为了放进窗口而上下平移。+ 号贴近窗口顶部,
 * 上方只有几十像素,所以每层的高度受 anchor 上方 (和下方) 的空间限制:放不下时
 * 这一层少放几个,多出来的排到外层,扇形变扁、向右伸得更远。
 *
 * @param count 选项数量
 * @param anchor + 号中心,视口坐标
 * @param viewport 视口尺寸
 * @returns 圆心坐标,内层到外层、每层从上到下;贴窗口右边时整组向左平移
 */
export function radialPositions(
  count: number,
  anchor: Point,
  viewport: { width: number; height: number },
): Point[] {
  if (count <= 0) return [];
  // anchor 上下两侧能让圆心偏离对称轴多远,取较小的一侧,保证对称
  const room = Math.max(
    0,
    Math.min(
      anchor.y - ITEM_RADIUS_PX - VIEWPORT_MARGIN_PX,
      viewport.height - anchor.y - ITEM_RADIUS_PX - LABEL_HEIGHT_PX - VIEWPORT_MARGIN_PX,
    ),
  );
  // 一层里上下对称地放 m 个,最远的偏离 (m - 1) / 2 个间距
  const tallest = Math.floor((2 * room) / ROW_SPACING_PX) + 1;
  const points: Point[] = [];
  for (let ring = 0; points.length < count; ring += 1) {
    const radius = FIRST_RING_RADIUS_PX + ring * RING_GAP_PX;
    const inRing = Math.min(ring + 2, tallest, count - points.length);
    for (let i = 0; i < inRing; i += 1) {
      const dy = (i - (inRing - 1) / 2) * ROW_SPACING_PX;
      points.push({ x: anchor.x + Math.sqrt(radius * radius - dy * dy), y: anchor.y + dy });
    }
  }
  const dx = shiftIntoRange(
    points.map((p) => p.x),
    ITEM_RADIUS_PX + VIEWPORT_MARGIN_PX,
    viewport.width,
  );
  return points.map((p) => ({ x: p.x + dx, y: p.y }));
}

/**
 * 一组坐标需要平移多少,才能让每个圆离 0 和 size 两端都至少有 reach。
 * 放不下时居中,而不是让一端被裁掉得更多。
 */
function shiftIntoRange(values: number[], reach: number, size: number): number {
  const min = Math.min(...values) - reach;
  const max = Math.max(...values) + reach;
  if (max - min > size) return (size - (max + min)) / 2;
  if (min < 0) return -min;
  if (max > size) return size - max;
  return 0;
}
