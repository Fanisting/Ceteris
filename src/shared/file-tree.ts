/**
 * @file src/shared/file-tree.ts
 * @purpose 侧栏文件树的纯逻辑:类型、文件名校验、根目录推导、慢速双击判定、
 *   可见行展开。main 和 renderer 共用,这里不碰 fs 也不碰 DOM,所以都能单测。
 *
 * @关键设计:
 * - 根目录优先取 session.currentCwd(跟随 cd),风格不一致时退回 originalCwd,
 *   原因见 resolveFileTreeRoot。
 * - 慢速双击与 Windows 资源管理器一致:第二次点在同一行的文件名上才进入重命名。
 *   快速双击不重命名,太晚的第二次点击当作普通点击。
 *
 * @对应文档章节: 软件定义书.md 14.6 (文件树只覆盖本地路径)
 *
 * @不要在这里做的事:
 * - 不要在这里做真实文件操作(那是 src/main/file-tree.ts 的职责)
 */
import type { PathNode, SessionInfo } from './types';

/** 单个目录最多返回的条目数。超过时截断,避免超大目录把 renderer 卡死。 */
export const FILE_TREE_MAX_ENTRIES = 5000;

/** 两次点击间隔小于此值视为快速双击 (ms),不触发重命名。 */
export const SLOW_CLICK_MIN_MS = 500;
/** 两次点击间隔大于此值视为互不相关的两次点击 (ms)。 */
export const SLOW_CLICK_MAX_MS = 1500;

export interface FileTreeEntry {
  name: string;
  /** 绝对路径,由 main 拼接,renderer 不自己拼路径分隔符 */
  path: string;
  isDirectory: boolean;
}

export type FileTreeFailure = 'invalid-name' | 'exists' | 'not-found' | 'denied' | 'unknown';

/** 这些是用户操作的常规失败结果,用返回值而不是 throw,renderer 按 reason 显示文案。 */
export type ListDirResponse =
  | { ok: true; entries: FileTreeEntry[]; truncated: boolean }
  | { ok: false; reason: FileTreeFailure };

export type RenameEntryResponse =
  | { ok: true; path: string }
  | { ok: false; reason: FileTreeFailure };

export interface ListDirPayload {
  path: string;
}

export interface RenameEntryPayload {
  path: string;
  newName: string;
}

const entryCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** 文件夹在前,同类按自然顺序排 (file2 排在 file10 之前)。不修改入参。 */
export function sortEntries(entries: readonly FileTreeEntry[]): FileTreeEntry[] {
  return [...entries].sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return entryCollator.compare(a.name, b.name);
  });
}

// eslint-disable-next-line no-control-regex
const ILLEGAL_NAME_CHARS = /[<>:"/\\|?*\u0000-\u001f]/;
const RESERVED_DEVICE_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/**
 * 判断文件名是否合法。规则取 Windows 的并集:V1 主平台是 Windows,其它平台上
 * 这些规则只是偏严,不会放过危险输入。拦截 "/" 和 "\" 也保证了重命名只能改名,
 * 不能借 "../x" 把文件移出当前目录。
 */
export function isValidEntryName(name: string): boolean {
  if (name.length === 0 || name.length > 255) return false;
  if (name === '.' || name === '..') return false;
  if (ILLEGAL_NAME_CHARS.test(name)) return false;
  if (/[. ]$/.test(name) || name !== name.trimStart()) return false;
  return !RESERVED_DEVICE_NAME.test(name);
}

function pathStyle(p: string): 'unc' | 'posix' | 'drive' {
  if (p.startsWith('\\\\')) return 'unc';
  return p.startsWith('/') ? 'posix' : 'drive';
}

/**
 * 推导文件树要显示的根目录。返回 null 表示没有可浏览的本地目录。
 *
 * SSH session 一律返回 null:软件定义书 14.6 明确不做远端文件浏览。
 *
 * 风格判断是为 WSL:shell 上报的 /home/x 经 normalizeCwd 的 path.resolve 后变成
 * C:\home\x,这个路径在 Windows 上不存在或者指向别的目录。此时 originalCwd
 * (\\wsl$\... 这样的 UNC 路径) 才是可信的。
 */
export function resolveFileTreeRoot(
  session: Pick<SessionInfo, 'currentCwd' | 'originalCwd'> | null,
  node: Pick<PathNode, 'kind'> | null,
): string | null {
  if (!session || !node || node.kind === 'ssh') return null;
  const { currentCwd, originalCwd } = session;
  if (!currentCwd) return originalCwd || null;
  return pathStyle(currentCwd) === pathStyle(originalCwd) ? currentCwd : originalCwd;
}

export interface LastRowClick {
  path: string;
  at: number;
}

export type RowClickAction = 'activate' | 'rename' | 'ignore';

/**
 * 判定一次行点击的含义。
 *
 * @param last 上一次行点击,没有则为 null
 * @param path 本次点击的行
 * @param now 本次点击时间 (ms)
 * @param onName 是否点在文件名文字上
 * @returns activate = 选中/展开;rename = 进入重命名;ignore = 快速双击的第二下,
 *   忽略它才不会把刚展开的文件夹又折叠回去
 */
export function classifyRowClick(
  last: LastRowClick | null,
  path: string,
  now: number,
  onName: boolean,
): RowClickAction {
  if (!last || last.path !== path) return 'activate';
  const elapsed = now - last.at;
  if (elapsed < SLOW_CLICK_MIN_MS) return 'ignore';
  return elapsed <= SLOW_CLICK_MAX_MS && onName ? 'rename' : 'activate';
}

export interface FileTreeRow {
  entry: FileTreeEntry;
  depth: number;
  parentPath: string;
}

/** 把已加载的目录展开成扁平行。尚未加载的文件夹只显示自身,不算错误。 */
export function flattenVisibleRows(
  rootPath: string,
  entriesByDir: ReadonlyMap<string, readonly FileTreeEntry[]>,
  expanded: ReadonlySet<string>,
): FileTreeRow[] {
  const rows: FileTreeRow[] = [];
  const visit = (dir: string, depth: number): void => {
    for (const entry of entriesByDir.get(dir) ?? []) {
      rows.push({ entry, depth, parentPath: dir });
      if (entry.isDirectory && expanded.has(entry.path)) visit(entry.path, depth + 1);
    }
  };
  visit(rootPath, 0);
  return rows;
}

/** 重命名后修正路径:命中 from 本身或其子路径时替换前缀,其余原样返回。 */
export function remapPath(target: string, from: string, to: string): string {
  if (target === from) return to;
  const separator = target[from.length];
  const isChild = target.startsWith(from) && (separator === '/' || separator === '\\');
  return isChild ? to + target.slice(from.length) : target;
}
