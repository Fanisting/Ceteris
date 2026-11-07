/**
 * @file src/renderer/pdf-view-store.ts
 * @purpose 记录每个 session 正在显示哪个 PDF、图片、markdown 或文本,并把文件分块读进内存。
 *
 * @关键设计:
 * - A view belongs to a session, or to a folder while that folder has no terminal to
 *   cover (folderPdfKey). Every function here takes that key.
 * - 按 session 记录,不放进 AppState:这是本窗口的临时视图状态,切到别的 session
 *   再切回来时 PDF 还在,而且不会让全局 reducer 每次加载进度都重渲染。
 * - blob URL 在这里创建和回收,PdfOverlay 卸载时不回收,否则切一次 session 就要
 *   重新下载。session 销毁时由 prunePdfViews 回收。
 * - generation 让旧的加载作废:加载途中关闭或换文件,晚到的数据块直接丢弃。
 * - 不信任响应:Link 对端可能出错,偏移必须紧接上一块,大小不能变,最后要刚好读满。
 * - 最多留 MAX_READY_VIEWS 份:每份可能有 256 MiB。淘汰最久没显示的那份。
 * - Text is not loaded here: TextFileView reads what it needs, as a large file must never be
 *   read whole. Its unsaved edits live in text-drafts.ts, so closing a view cannot lose them.
 *
 * @对应文档章节: 软件定义书.md 14.6
 *
 * @不要在这里做的事:
 * - 不要解析文件内容,PdfOverlay 负责显示
 */
import { useSyncExternalStore } from 'react';
import { COMMAND_CHANNELS } from '@shared/protocol';
import {
  fileViewKind,
  fileViewMime,
  PDF_MAX_BYTES,
  type ReadPdfFailure,
  type ReadPdfPayload,
  type ReadPdfResponse,
} from '@shared/file-tree';

export interface PdfSource {
  name: string;
  path: string;
  sshProfileId?: string;
}

export type PdfView = { source: PdfSource; generation: number } & (
  | { status: 'loading' }
  /** Markdown keeps its text. Everything else is shown through a blob URL. */
  | { status: 'ready'; url: string | null; text: string | null }
  | { status: 'error'; reason: ReadPdfFailure }
);

const MAX_READY_VIEWS = 3;
const FOLDER_KEY_PREFIX = 'path:';

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
  if (previous?.status === 'ready' && previous.url) URL.revokeObjectURL(previous.url);
  if (view) {
    views.set(viewKey, view);
  } else {
    views.delete(viewKey);
    lastShown.delete(viewKey);
  }
  for (const listener of listeners) listener();
}

export type TextRange =
  | { ok: true; bytes: Uint8Array; size: number; mtimeMs: number | null }
  | { ok: false; reason: ReadPdfFailure };

/** Reads part of a text file. Does not trust the reply, as with the chunks below. */
export async function readTextRange(
  source: PdfSource,
  offset: number,
  length: number,
): Promise<TextRange> {
  const payload: ReadPdfPayload = {
    path: source.path,
    offset,
    length,
    ...(source.sshProfileId ? { sshProfileId: source.sshProfileId } : {}),
  };
  const res = await window.api
    .invoke<ReadPdfPayload, ReadPdfResponse>(COMMAND_CHANNELS.FS_READ_PDF, payload)
    .catch((): ReadPdfResponse => ({ ok: false, reason: 'unknown' }));
  if (!res.ok) return res;
  const bytes = decodeBase64(res.base64);
  if (bytes.length > length) return { ok: false, reason: 'unknown' };
  return { ok: true, bytes, size: res.size, mtimeMs: res.mtimeMs ?? null };
}

function decodeBase64(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * 分块读完整个文件。
 *
 * @returns 数据块;isStale 为真时返回 null
 * @throws Error 响应不合法。reason 见 PdfReadError
 */
async function readAllChunks(
  source: PdfSource,
  isStale: () => boolean,
): Promise<Array<Uint8Array<ArrayBuffer>> | null> {
  const chunks: Array<Uint8Array<ArrayBuffer>> = [];
  let total = 0;
  let expectedSize: number | null = null;
  let offset: number | null = 0;
  while (offset !== null) {
    const payload: ReadPdfPayload = {
      path: source.path,
      offset,
      ...(source.sshProfileId ? { sshProfileId: source.sshProfileId } : {}),
    };
    const res: ReadPdfResponse = await window.api
      .invoke<ReadPdfPayload, ReadPdfResponse>(COMMAND_CHANNELS.FS_READ_PDF, payload)
      .catch((): ReadPdfResponse => ({ ok: false, reason: 'unknown' }));
    if (isStale()) return null;
    if (!res.ok) throw new PdfReadError(res.reason);
    if (res.size > PDF_MAX_BYTES) throw new PdfReadError('too-large');
    if (expectedSize !== null && res.size !== expectedSize) throw new PdfReadError('unknown');
    expectedSize = res.size;
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
  if (total !== expectedSize) throw new PdfReadError('unknown');
  return chunks;
}

class PdfReadError extends Error {
  constructor(public readonly reason: ReadPdfFailure) {
    super(`[PdfView] read failed: ${reason}`);
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

/** 在该 session 或文件夹的主区域打开 PDF。已有的 PDF 被替换。 */
export async function openPdf(viewKey: string, source: PdfSource): Promise<void> {
  const generation = nextGeneration;
  nextGeneration += 1;
  const base = { source, generation };
  publish(viewKey, { ...base, status: 'loading' });
  const isStale = (): boolean => views.get(viewKey)?.generation !== generation;

  if (fileViewKind(source.name) === 'text') {
    publish(viewKey, { ...base, status: 'ready', url: null, text: null });
    evictOldViews(viewKey);
    return;
  }

  try {
    const chunks = await readAllChunks(source, isStale);
    if (!chunks) return;
    const blob = new Blob(chunks, { type: fileViewMime(source.name) });
    if (fileViewKind(source.name) === 'markdown') {
      const text = await blob.text();
      if (isStale()) return;
      publish(viewKey, { ...base, status: 'ready', url: null, text });
    } else {
      publish(viewKey, { ...base, status: 'ready', url: URL.createObjectURL(blob), text: null });
    }
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
 * Hands a folder's open file to the terminal just opened there, so it stays on screen beside
 * that terminal. A file still loading closes instead: its load only knows the old key.
 */
export function movePdfView(fromKey: string, toKey: string): void {
  const view = views.get(fromKey);
  if (!view) return;
  if (view.status !== 'ready' || views.has(toKey)) {
    publish(fromKey, null);
    return;
  }
  // Not through publish: that would revoke the blob URL the view is still showing.
  views.delete(fromKey);
  views.set(toKey, view);
  lastShown.set(toKey, lastShown.get(fromKey) ?? 0);
  lastShown.delete(fromKey);
  for (const listener of listeners) listener();
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

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function usePdfView(viewKey: string): PdfView | null {
  return useSyncExternalStore(subscribe, () => views.get(viewKey) ?? null);
}
