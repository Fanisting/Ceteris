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
 * @对应文档章节: 软件定义书.md 14.6
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

/**
 * SFTP 连接层面的失败原因。显示文案在 fileTree.error.<reason>。
 *
 * login-required:服务器要用户回答登录提示(密码 / Duo 验证码 / 主机密钥确认),
 * 而这次连接是后台轮询发起的,不能弹窗,所以在发出任何凭据之前就断开了。
 * 用户点"重试"或点击文件后,连接会以交互方式重建并弹出提示。
 */
export type SftpFailure =
  | 'no-client'
  | 'auth'
  | 'host-key'
  | 'connect'
  | 'no-sftp'
  | 'login-required';

/** 列目录可能的失败:本地的文件错误,或者 SFTP 连接错误。 */
export type DirFailure = FileTreeFailure | SftpFailure;

/** 这些是用户操作的常规失败结果,用返回值而不是 throw,renderer 按 reason 显示文案。 */
export type ListDirResponse =
  /** path 是展开 ~ 后的目录,只有 SFTP 会返回 */
  | { ok: true; entries: FileTreeEntry[]; truncated: boolean; path?: string }
  | { ok: false; reason: DirFailure };

export type RenameEntryResponse =
  | { ok: true; path: string }
  | { ok: false; reason: FileTreeFailure };

export interface ListDirPayload {
  path: string;
  /** 有值时通过 SFTP 列这个 profile 上的目录,没有时列本机目录 */
  sshProfileId?: string;
  /** 用户主动操作时为 true:跳过 SFTP 失败缓存立即重连。轮询不要设置 */
  fresh?: boolean;
  /**
   * 为 true 时允许 SFTP 连接在登录时向用户弹出提示(密码 / Duo / 主机密钥)。
   * 只有用户能看到结果的操作才设置:挂载文件树、点重试、打开选择框。
   * 定时轮询不要设置,否则服务器的一个提示会在用户没操作时凭空弹窗。
   */
  interactive?: boolean;
}

export type ReadPdfFailure = DirFailure | 'not-pdf' | 'too-large';

/** 能打开的 PDF 上限。main 和 renderer 都检查:renderer 不能信任 Link 对端。 */
export const PDF_MAX_BYTES = 256 * 1024 * 1024;

export interface ReadPdfPayload {
  path: string;
  sshProfileId?: string;
  /** 字节偏移,从 0 开始,之后用上一次返回的 nextOffset */
  offset: number;
  /**
   * 用户刚点击了文件:跳过 SFTP 失败缓存,并允许登录提示弹窗。
   * 自动刷新重读文件时不要设置,它必须保持安静。
   */
  fresh?: boolean;
}

export type ReadPdfResponse =
  /**
   * base64 是这一块的内容;nextOffset 为 null 表示读完了。
   * mtimeMs 是读取时文件的修改时间,自动刷新拿它和 size 做基线;服务器不给时为 null。
   */
  | { ok: true; base64: string; size: number; nextOffset: number | null; mtimeMs: number | null }
  | { ok: false; reason: ReadPdfFailure };

export interface StatFilePayload {
  path: string;
  sshProfileId?: string;
}

/** 自动刷新用来判断文件是否变化的两个量。 */
export interface FileStat {
  size: number;
  /** 服务器省略 ACMODTIME 时为 null,这时只看 size */
  mtimeMs: number | null;
}

/**
 * 查询可查看文件的大小和修改时间。永远是安静请求:不弹登录提示,不跳过失败缓存。
 * 限制与 read-pdf 相同:绝对路径、可查看的扩展名、普通文件。
 */
export type StatFileResponse = ({ ok: true } & FileStat) | { ok: false; reason: ReadPdfFailure };

/** 两次 stat 是否表示同一份内容。 */
export function sameFileStat(a: FileStat | null, b: FileStat | null): boolean {
  if (a === null || b === null) return a === b;
  return a.size === b.size && a.mtimeMs === b.mtimeMs;
}

export interface RenameEntryPayload {
  path: string;
  newName: string;
}

const entryCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export type FileViewKind = 'pdf' | 'image' | 'markdown';

const VIEW_MIME_TYPES: Record<string, { kind: FileViewKind; mime: string }> = {
  pdf: { kind: 'pdf', mime: 'application/pdf' },
  md: { kind: 'markdown', mime: 'text/markdown' },
  markdown: { kind: 'markdown', mime: 'text/markdown' },
  png: { kind: 'image', mime: 'image/png' },
  jpg: { kind: 'image', mime: 'image/jpeg' },
  jpeg: { kind: 'image', mime: 'image/jpeg' },
  gif: { kind: 'image', mime: 'image/gif' },
  webp: { kind: 'image', mime: 'image/webp' },
  bmp: { kind: 'image', mime: 'image/bmp' },
  svg: { kind: 'image', mime: 'image/svg+xml' },
};

function viewEntry(name: string): { kind: FileViewKind; mime: string } | null {
  const ext = /\.([a-z]+)$/i.exec(name)?.[1]?.toLowerCase();
  return (ext && VIEW_MIME_TYPES[ext]) || null;
}

/** How the file tree shows a clicked file. Null means clicking only selects it. */
export function fileViewKind(name: string): FileViewKind | null {
  return viewEntry(name)?.kind ?? null;
}

export function fileViewMime(name: string): string {
  return viewEntry(name)?.mime ?? 'application/octet-stream';
}

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

const WSL_UNC_PATH = /^\\\\(?:wsl\$|wsl\.localhost)\\/i;

function pathStyle(p: string): 'unc' | 'posix' | 'drive' {
  if (p.startsWith('\\\\')) return 'unc';
  return p.startsWith('/') ? 'posix' : 'drive';
}

/**
 * 推导文件树要显示的根目录。返回 null 表示没有可浏览的目录。
 *
 * SSH session 的 currentCwd 只有在远端 shell 上报过时才是绝对路径。上报的路径在
 * Windows 上可能被 normalizeCwd 改成 C:\home\x,所以不是 / 开头就用 originalCwd,
 * 也就是路径节点上的远程路径。
 *
 * WSL 要特殊处理:shell 上报的 /home/x 经 normalizeCwd 的 path.resolve 后变成
 * C:\home\x,这个路径在 Windows 上不存在或者指向别的目录。此时 originalCwd
 * (\\wsl$\... 这样的 UNC 路径) 才是可信的。从 C:\proj cd 到 \\nas\share 这种
 * 普通的跨盘切换不受影响,树照常跟随。
 */
export function resolveFileTreeRoot(
  session: Pick<SessionInfo, 'currentCwd' | 'originalCwd'> | null,
  node: Pick<PathNode, 'kind'> | null,
): string | null {
  if (!session || !node) return null;
  const { currentCwd, originalCwd } = session;
  if (node.kind === 'ssh') return currentCwd.startsWith('/') ? currentCwd : originalCwd || '~';
  if (!currentCwd) return originalCwd || null;
  const currentStyle = pathStyle(currentCwd);
  if (WSL_UNC_PATH.test(originalCwd)) return currentStyle === 'unc' ? currentCwd : originalCwd;
  return (currentStyle === 'posix') === (pathStyle(originalCwd) === 'posix')
    ? currentCwd
    : originalCwd;
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
  // 防御远端数据:一个条目的路径等于祖先目录时不能无限递归
  const visited = new Set<string>();
  const visit = (dir: string, depth: number): void => {
    if (visited.has(dir)) return;
    visited.add(dir);
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
