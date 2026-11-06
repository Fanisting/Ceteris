/**
 * @file src/renderer/pdf-view-store.ts
 * @purpose 记录每个 session 正在显示哪个 PDF,并把文件分块读进 blob URL。
 *
 * @关键设计:
 * - 按 session 记录,不放进 AppState:这是本窗口的临时视图状态,切到别的 session
 *   再切回来时 PDF 还在,而且不会让全局 reducer 每次加载进度都重渲染。
 * - blob URL 在这里创建和回收,PdfOverlay 卸载时不回收,否则切一次 session 就要
 *   重新下载。session 销毁时由 prunePdfViews 回收。
 * - generation 让旧的加载作废:加载途中关闭或换文件,晚到的数据块直接丢弃。
 * - 不信任响应:Link 对端可能出错,偏移必须紧接上一块,大小不能变,最后要刚好读满。
 * - 最多留 MAX_READY_VIEWS 份:每份可能有 256 MiB。淘汰最久没显示的那份。
 *
 * @对应文档章节: 软件定义书.md 14.6
 *
 * @不要在这里做的事:
 * - 不要解析 PDF 内容,显示交给 Chromium 内置的 PDF 查看器
 */
import { useSyncExternalStore } from 'react';
import { COMMAND_CHANNELS } from '@shared/protocol';
import {
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
  | { status: 'ready'; url: string }
  | { status: 'error'; reason: ReadPdfFailure }
);

const MAX_READY_VIEWS = 3;

const views = new Map<string, PdfView>();
/** sessionId → 最后一次显示的序号。序号大的是最近看过的。 */
const lastShown = new Map<string, number>();
let shownCounter = 0;
const listeners = new Set<() => void>();
let nextGeneration = 1;

function publish(sessionId: string, view: PdfView | null): void {
  const previous = views.get(sessionId);
  if (previous?.status === 'ready') URL.revokeObjectURL(previous.url);
  if (view) {
    views.set(sessionId, view);
  } else {
    views.delete(sessionId);
    lastShown.delete(sessionId);
  }
  for (const listener of listeners) listener();
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
export function markPdfShown(sessionId: string): void {
  shownCounter += 1;
  lastShown.set(sessionId, shownCounter);
}

/** 超过上限时关掉最久没显示的 PDF,不动刚打开的这个。 */
function evictOldViews(keepSessionId: string): void {
  const ready = [...views.entries()].filter(([, view]) => view.status === 'ready');
  const candidates = ready
    .map(([sessionId]) => sessionId)
    .filter((sessionId) => sessionId !== keepSessionId)
    .sort((a, b) => (lastShown.get(a) ?? 0) - (lastShown.get(b) ?? 0));
  for (const sessionId of candidates.slice(0, Math.max(0, ready.length - MAX_READY_VIEWS))) {
    publish(sessionId, null);
  }
}

/** 在该 session 的终端区域打开 PDF。已有的 PDF 被替换。 */
export async function openPdf(sessionId: string, source: PdfSource): Promise<void> {
  const generation = nextGeneration;
  nextGeneration += 1;
  const base = { source, generation };
  publish(sessionId, { ...base, status: 'loading' });
  const isStale = (): boolean => views.get(sessionId)?.generation !== generation;

  try {
    const chunks = await readAllChunks(source, isStale);
    if (!chunks) return;
    const url = URL.createObjectURL(new Blob(chunks, { type: 'application/pdf' }));
    publish(sessionId, { ...base, status: 'ready', url });
    evictOldViews(sessionId);
  } catch (err) {
    if (isStale()) return;
    const reason = err instanceof PdfReadError ? err.reason : 'unknown';
    publish(sessionId, { ...base, status: 'error', reason });
  }
}

/** 关闭 PDF,露出下面的终端。 */
export function closePdf(sessionId: string): void {
  if (views.has(sessionId)) publish(sessionId, null);
}

/** 回收已销毁 session 的 PDF。 */
export function prunePdfViews(liveSessionIds: ReadonlySet<string>): void {
  for (const sessionId of [...views.keys()]) {
    if (!liveSessionIds.has(sessionId)) publish(sessionId, null);
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function usePdfView(sessionId: string): PdfView | null {
  return useSyncExternalStore(subscribe, () => views.get(sessionId) ?? null);
}
