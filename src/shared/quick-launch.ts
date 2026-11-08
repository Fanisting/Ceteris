/**
 * @file src/shared/quick-launch.ts
 * @purpose 右键 + 号弹出的快捷启动:选项类型、默认值、校验,以及环绕布局的几何计算。
 *
 * @关键设计:
 * - 选项和新建页相同,分模板和已检测到的 shell 两类。存 id 而不是副本,
 *   模板改名后这里自动跟随,模板被删时渲染端直接跳过。
 * - + 号在窗口左上角,所以选项在它右下方展开成一个扇形:几层同心弧,从里往外排,
 *   内层放满再放外层。全部在 + 号右侧,不会盖住左边的侧栏。
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

/** 扇形从 + 号正右偏下 30 度开始,到正下方结束。起点压低,最上面的圆也不会盖住同一行的标签文字。 */
const FAN_START_RAD = (30 * Math.PI) / 180;
const FAN_END_RAD = Math.PI / 2;
/** 最内层弧的半径:两个默认选项正好放在这一层。 */
const FIRST_RING_RADIUS_PX = 80;
/** 相邻两层弧的间距:一个圆 (42px) 加它下方的文字标签,再留一点空隙。 */
const RING_GAP_PX = 74;
/** 同一层上相邻两圆圆心的最小间距,要容得下一个文字标签 (标签最宽 76px,见 quick-launch.css)。 */
const ITEM_SPACING_PX = 78;
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
 * 计算各选项圆心位置:在 anchor 右下方排成一个扇形。
 *
 * 扇形由几层同心弧组成,张角固定为 30 到 90 度。每层能放下的数量取决于它的弧长,
 * 内层放满再放外层,所以 8 个选项也只用三层,最远约 230px,鼠标不用走太远。
 * 同一层的圆在整段张角上均匀分布,只有一个时放在正中间。
 *
 * @param count 选项数量
 * @param anchor + 号中心,视口坐标
 * @param viewportWidth 视口宽度
 * @returns 圆心坐标,内层到外层、每层从上到下;贴窗口右边时整组向左平移,不被裁掉
 */
export function radialPositions(count: number, anchor: Point, viewportWidth: number): Point[] {
  if (count <= 0) return [];
  const span = FAN_END_RAD - FAN_START_RAD;
  const points: Point[] = [];
  for (let ring = 0; points.length < count; ring += 1) {
    const radius = FIRST_RING_RADIUS_PX + ring * RING_GAP_PX;
    // 弧长 = 半径 × 张角,相邻两圆至少隔 ITEM_SPACING_PX
    const capacity = Math.floor((radius * span) / ITEM_SPACING_PX) + 1;
    const inRing = Math.min(capacity, count - points.length);
    for (let i = 0; i < inRing; i += 1) {
      const angle =
        inRing === 1 ? FAN_START_RAD + span / 2 : FAN_START_RAD + (span * i) / (inRing - 1);
      points.push({
        x: anchor.x + radius * Math.cos(angle),
        y: anchor.y + radius * Math.sin(angle),
      });
    }
  }
  return keepInViewport(points, viewportWidth);
}

/** 整组水平平移,让每个圆离窗口左右边缘都至少有 VIEWPORT_MARGIN_PX。窄到放不下时居中。 */
function keepInViewport(points: Point[], viewportWidth: number): Point[] {
  const reach = ITEM_RADIUS_PX + VIEWPORT_MARGIN_PX;
  const minX = Math.min(...points.map((p) => p.x)) - reach;
  const maxX = Math.max(...points.map((p) => p.x)) + reach;
  let shift = 0;
  if (maxX - minX > viewportWidth) shift = (viewportWidth - (maxX + minX)) / 2;
  else if (maxX > viewportWidth) shift = viewportWidth - maxX;
  else if (minX < 0) shift = -minX;
  return points.map((p) => ({ x: p.x + shift, y: p.y }));
}
