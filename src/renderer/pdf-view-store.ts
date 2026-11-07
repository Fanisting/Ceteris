/**
 * @file src/renderer/pdf-view-store.ts
 * @purpose 记录每个 session 正在显示哪个 PDF、图片或 markdown,把文件分块读进内存,
 *   并在文件变化时自动重读。
 *
 * @关键设计:
 * - A view belongs to a session, or to a folder while that folder has no terminal to
 *   cover (folderPdfKey). Every function here takes that key.
 * - 按 session 记录,不放进 AppState:这是本窗口的临时视图状态,切到别的 session
 *   再切回来时 PDF 还在,而且不会让全局 reducer 每次加载进度都重渲染。
 * - PDF 留 Blob 给 pdf.js,图片留 blob URL,markdown 留文本。blob URL 在这里创建和回收,
 *   PdfOverlay 卸载时不回收,否则切一次 session 就要重新下载。session 销毁时由
 *   prunePdfViews 回收。
 * - generation 让旧的加载作废:加载途中关闭或换文件,晚到的数据块直接丢弃。
 * - 不信任响应:Link 对端可能出错,偏移必须紧接上一块,大小不能变,最后要刚好读满。
 * - 最多留 MAX_READY_VIEWS 份:每份可能有 256 MiB。淘汰最久没显示的那份。
 * - 自动刷新:PdfOverlay 显示着某个 view 时 watchPdf 开始轮询 cmd:fs:stat-file
 *   (本地 1.5 秒,远端 3 秒,窗口不可见时跳过)。size 或 mtime 和读取时不同,并且
 *   连续两轮相同(文件写完了,不是 LaTeX 写到一半),才重读。重读不经过 loading,
 *   直接用新内容替换,revision 加一,查看器据此换文档并保持页码。重读失败(读到一半、
 *   不是 PDF、暂时不存在)保留旧内容,显示一个可点的"无法刷新",等 stat 再变再试。
 *   轮询和自动重读都不传 fresh:它们不能触发 SFTP 登录提示,也不能跳过失败缓存。
 *
 * @对应文档章节: 软件定义书.md 14.6
 *
 * @不要在这里做的事:
 * - 不要解析文件内容,PdfOverlay / PdfJsViewer 负责显示
 */
import { useSyncExternalStore } from 'react';
import { COMMAND_CHANNELS } from '@shared/protocol';
import {
  fileViewKind,
  fileViewMime,
  PDF_MAX_BYTES,
  sameFileStat,
  type FileStat,
  type ReadPdfFailure,
  type ReadPdfPayload,
  type ReadPdfResponse,
  type StatFilePayload,
  type StatFileResponse,
} from '@shared/file-tree';

export interface PdfSource {
  name: string;
  path: string;
  sshProfileId?: string;
}

export interface ReadyPdfView {
  status: 'ready';
  /** 图片的 blob URL;PDF 和 markdown 为 null */
  url: string | null;
  /** markdown 的文本 */
  text: string | null;
  /** PDF 的字节,交给 pdf.js */
  blob: Blob | null;
  /** 每次重读加一。查看器据此换文档,同一份内容不会重新渲染 */
  revision: number;
  /** 读取时的大小和修改时间,轮询拿它比较 */
  fileStat: FileStat;
  /** 最近一次自动刷新失败的原因;成功后清空 */
  refreshError: ReadPdfFailure | null;
  /** 正在重读 */
  refreshing: boolean;
}

export type PdfView = { source: PdfSource; generation: number } & (
  | { status: 'loading' }
  | ReadyPdfView
  | { status: 'error'; reason: ReadPdfFailure }
);

const MAX_READY_VIEWS = 3;
const FOLDER_KEY_PREFIX = 'path:';
const LOCAL_POLL_MS = 1500;
const REMOTE_POLL_MS = 3000;

/** The view key of a PDF shown in a folder with no terminal open. */
export function folderPdfKey(pathId: string): string {
  return `${FOLDER_KEY_PREFIX}${pathId}`;
}

const views = new Map<string, PdfView>();
/** view key → 最后一次显示的序号。序号大的是最近看过的。 */
const lastShown = new Map<string, number>();
let shownCounter = 0;
const listeners = new Set<() => void>();
let nextGeneration = 1;

function publish(viewKey: string, view: PdfView | null): void {
  const previous = views.get(viewKey);
  // 同一个 URL 只是换了别的字段时不能回收,否则图片就空了
  if (previous?.status === 'ready' && previous.url && previous.url !== viewUrl(view)) {
    URL.revokeObjectURL(previous.url);
  }
  if (view) {
    views.set(viewKey, view);
  } else {
    views.delete(viewKey);
    lastShown.delete(viewKey);
  }
  for (const listener of listeners) listener();
}

function viewUrl(view: PdfView | null): string | null {
  return view?.status === 'ready' ? view.url : null;
}

function decodeBase64(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

class PdfReadError extends Error {
  constructor(public readonly reason: ReadPdfFailure) {
    super(`[PdfView] read failed: ${reason}`);
  }
}

interface ReadResult {
  chunks: Array<Uint8Array<ArrayBuffer>>;
  stat: FileStat;
}

/**
 * 分块读完整个文件。
 *
 * @param fresh 用户刚点击:跳过 SFTP 失败缓存并允许登录提示。自动刷新传 false
 * @returns 数据块和读取时的 stat;isStale 为真时返回 null
 * @throws PdfReadError 响应不合法或读取失败
 */
async function readAllChunks(
  source: PdfSource,
  isStale: () => boolean,
  fresh: boolean,
): Promise<ReadResult | null> {
  const chunks: Array<Uint8Array<ArrayBuffer>> = [];
  let total = 0;
  let expectedSize: number | null = null;
  let mtimeMs: number | null = null;
  let offset: number | null = 0;
  while (offset !== null) {
    const payload: ReadPdfPayload = {
      path: source.path,
      offset,
      ...(source.sshProfileId ? { sshProfileId: source.sshProfileId } : {}),
      // 只有第一块是用户点击的直接结果,后面的块都是接着读
      ...(fresh && offset === 0 ? { fresh: true } : {}),
    };
    const res: ReadPdfResponse = await window.api
      .invoke<ReadPdfPayload, ReadPdfResponse>(COMMAND_CHANNELS.FS_READ_PDF, payload)
      .catch((): ReadPdfResponse => ({ ok: false, reason: 'unknown' }));
    if (isStale()) return null;
    if (!res.ok) throw new PdfReadError(res.reason);
    if (res.size > PDF_MAX_BYTES) throw new PdfReadError('too-large');
    if (expectedSize !== null && res.size !== expectedSize) throw new PdfReadError('unknown');
    expectedSize = res.size;
    if (offset === 0) mtimeMs = res.mtimeMs;
    const chunk = decodeBase64(res.base64);
    total += chunk.length;
    if (total > PDF_MAX_BYTES) throw new PdfReadError('too-large');
    const end: number = offset + chunk.length;
    if (res.nextOffset !== null && (chunk.length === 0 || res.nextOffset !== end)) {
      throw new PdfReadError('unknown');
    }
    chunks.push(chunk);
    offset = res.nextOffset;
  }
  if (expectedSize === null || total !== expectedSize) throw new PdfReadError('unknown');
  return { chunks, stat: { size: expectedSize, mtimeMs } };
}

/** 把读到的字节按文件种类变成可显示的内容。 */
async function toContent(
  source: PdfSource,
  chunks: Array<Uint8Array<ArrayBuffer>>,
): Promise<Pick<ReadyPdfView, 'url' | 'text' | 'blob'>> {
  const blob = new Blob(chunks, { type: fileViewMime(source.name) });
  switch (fileViewKind(source.name)) {
    case 'markdown':
      return { url: null, text: await blob.text(), blob: null };
    case 'image':
      return { url: URL.createObjectURL(blob), text: null, blob: null };
    default:
      return { url: null, text: null, blob };
  }
}

/** PdfOverlay 显示某个 session 的 PDF 时调用,淘汰时据此保留正在看的那份。 */
export function markPdfShown(viewKey: string): void {
  shownCounter += 1;
  lastShown.set(viewKey, shownCounter);
}

/** 超过上限时关掉最久没显示的 PDF,不动刚打开的这个。 */
function evictOldViews(keepSessionId: string): void {
  const ready = [...views.entries()].filter(([, view]) => view.status === 'ready');
  const candidates = ready
    .map(([viewKey]) => viewKey)
    .filter((viewKey) => viewKey !== keepSessionId)
    .sort((a, b) => (lastShown.get(a) ?? 0) - (lastShown.get(b) ?? 0));
  for (const viewKey of candidates.slice(0, Math.max(0, ready.length - MAX_READY_VIEWS))) {
    publish(viewKey, null);
  }
}

/**
 * 在该 session 或文件夹的主区域打开文件。已有的被替换。
 *
 * 这是用户点击,所以读取带 fresh:远端连接会跳过失败缓存,需要时弹登录提示。
 */
export async function openPdf(viewKey: string, source: PdfSource): Promise<void> {
  const generation = nextGeneration;
  nextGeneration += 1;
  const base = { source, generation };
  publish(viewKey, { ...base, status: 'loading' });
  const isStale = (): boolean => views.get(viewKey)?.generation !== generation;

  try {
    const result = await readAllChunks(source, isStale, true);
    if (!result) return;
    const content = await toContent(source, result.chunks);
    if (isStale()) {
      if (content.url) URL.revokeObjectURL(content.url);
      return;
    }
    publish(viewKey, {
      ...base,
      status: 'ready',
      ...content,
      revision: 1,
      fileStat: result.stat,
      refreshError: null,
      refreshing: false,
    });
    evictOldViews(viewKey);
  } catch (err) {
    if (isStale()) return;
    const reason = err instanceof PdfReadError ? err.reason : 'unknown';
    publish(viewKey, { ...base, status: 'error', reason });
  }
}

/** 关闭 PDF,露出下面的内容。 */
export function closePdf(viewKey: string): void {
  if (views.has(viewKey)) publish(viewKey, null);
}

/**
 * 回收已销毁 session 的 PDF,以及已移除文件夹的 PDF。
 *
 * @param isLive answers for a session id, or for a folder id once the prefix is removed
 */
export function prunePdfViews(isLive: (id: string) => boolean): void {
  for (const viewKey of [...views.keys()]) {
    const id = viewKey.startsWith(FOLDER_KEY_PREFIX)
      ? viewKey.slice(FOLDER_KEY_PREFIX.length)
      : viewKey;
    if (!isLive(id)) publish(viewKey, null);
  }
}

// ──────────────────────────────────────────────────────────────────
// 自动刷新
// ──────────────────────────────────────────────────────────────────

interface Watcher {
  timer: number;
  /** 正在显示这个 view 的 PdfOverlay 数量,0 时停止轮询 */
  refs: number;
  inFlight: boolean;
  /** 上一轮看到的、和 fileStat 不同的 stat。连续两轮相同才重读 */
  candidate: FileStat | null;
  /** 按这个 stat 重读失败过,它不变就不再试 */
  failedStat: FileStat | null;
}

const watchers = new Map<string, Watcher>();

function readyView(viewKey: string): (PdfView & ReadyPdfView) | null {
  const view = views.get(viewKey);
  return view?.status === 'ready' ? view : null;
}

/**
 * 重读文件并替换内容,页码由查看器保持。
 *
 * @param options.fresh 用户点了"重试":允许登录提示并跳过失败缓存。自动刷新传 false
 */
export async function refreshPdf(viewKey: string, options: { fresh: boolean }): Promise<void> {
  const view = readyView(viewKey);
  if (!view || view.refreshing) return;
  const { generation, source } = view;
  const isStale = (): boolean => views.get(viewKey)?.generation !== generation;
  publish(viewKey, { ...view, refreshing: true });
  const watcher = watchers.get(viewKey);
  try {
    const result = await readAllChunks(source, isStale, options.fresh);
    if (!result) return;
    const content = await toContent(source, result.chunks);
    const current = readyView(viewKey);
    if (isStale() || !current) {
      if (content.url) URL.revokeObjectURL(content.url);
      return;
    }
    if (watcher) {
      watcher.candidate = null;
      watcher.failedStat = null;
    }
    publish(viewKey, {
      ...current,
      ...content,
      revision: current.revision + 1,
      fileStat: result.stat,
      refreshError: null,
      refreshing: false,
    });
  } catch (err) {
    const current = readyView(viewKey);
    if (isStale() || !current) return;
    const reason = err instanceof PdfReadError ? err.reason : 'unknown';
    if (watcher) {
      // 这个状态的文件读不了,等它再变
      watcher.failedStat = watcher.candidate;
      watcher.candidate = null;
    }
    publish(viewKey, { ...current, refreshError: reason, refreshing: false });
  }
}

async function tick(viewKey: string): Promise<void> {
  const watcher = watchers.get(viewKey);
  const view = readyView(viewKey);
  if (!watcher || !view || watcher.inFlight || view.refreshing) return;
  if (document.visibilityState !== 'visible') return;
  watcher.inFlight = true;
  const { generation, source } = view;
  const payload: StatFilePayload = {
    path: source.path,
    ...(source.sshProfileId ? { sshProfileId: source.sshProfileId } : {}),
  };
  const res = await window.api
    .invoke<StatFilePayload, StatFileResponse>(COMMAND_CHANNELS.FS_STAT_FILE, payload)
    .catch((): StatFileResponse => ({ ok: false, reason: 'unknown' }));
  watcher.inFlight = false;
  const current = readyView(viewKey);
  if (!current || current.generation !== generation || !watchers.has(viewKey)) return;
  if (!res.ok) {
    watcher.candidate = null;
    if (current.refreshError !== res.reason)
      publish(viewKey, { ...current, refreshError: res.reason });
    return;
  }
  const stat: FileStat = { size: res.size, mtimeMs: res.mtimeMs };
  if (sameFileStat(stat, current.fileStat)) {
    watcher.candidate = null;
    if (current.refreshError && !watcher.failedStat) {
      publish(viewKey, { ...current, refreshError: null });
    }
    return;
  }
  if (sameFileStat(stat, watcher.failedStat)) return;
  if (!sameFileStat(stat, watcher.candidate)) {
    watcher.candidate = stat;
    return;
  }
  await refreshPdf(viewKey, { fresh: false });
}

/**
 * PdfOverlay 显示某个 view 时开始轮询它的文件,返回停止函数。
 * 同一个 view 可能同时显示在两个窗格里,按计数管理。
 */
export function watchPdf(viewKey: string): () => void {
  let watcher = watchers.get(viewKey);
  if (!watcher) {
    const remote = Boolean(views.get(viewKey)?.source.sshProfileId);
    const created: Watcher = {
      timer: window.setInterval(() => void tick(viewKey), remote ? REMOTE_POLL_MS : LOCAL_POLL_MS),
      refs: 0,
      inFlight: false,
      candidate: null,
      failedStat: null,
    };
    watchers.set(viewKey, created);
    watcher = created;
  }
  watcher.refs += 1;
  const mine = watcher;
  return () => {
    mine.refs -= 1;
    if (mine.refs > 0 || watchers.get(viewKey) !== mine) return;
    window.clearInterval(mine.timer);
    watchers.delete(viewKey);
  };
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function usePdfView(viewKey: string): PdfView | null {
  return useSyncExternalStore(subscribe, () => views.get(viewKey) ?? null);
}
