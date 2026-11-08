/**
 * @file src/main/pdf-reader.ts
 * @purpose 分块读取 PDF、图片、markdown 和文本给 renderer,本地文件走 fs,远端文件走 SFTP。
 *
 * @关键设计:
 * - 分块是为了 Ceteris Link:单帧上限 8 MiB,命令超时 30 秒,所以每块 1 MiB,
 *   1 Mbit/s 的线路也来得及。本地窗口走同一条路,只有一套逻辑。
 * - 这条命令能读磁盘,所以只读普通文件,限定扩展名,每次都检查 %PDF- 文件头,
 *   不能用非零偏移绕过,也不能当任意文件读取用。
 * - Pictures and markdown are limited by extension only. They have no fixed header worth
 *   checking, and the renderer shows them as an image or as text with raw HTML turned off.
 * - 远端不落临时文件:SFTP 能按偏移读,用完即弃,不用管清理。
 * - 自动刷新靠 stat:renderer 轮询 size + mtime,变了才重读。stat 永远是安静请求,
 *   不跳过 SFTP 失败缓存,也不允许弹登录提示,所以轮询不会打扰用户。
 * - Text has no size limit. The limit protects renderer memory from whole-file reads, and a
 *   large text file is read one page at a time, so a read here stays one chunk long.
 *
 * @对应文档章节: 软件定义书.md 14.6
 *
 * @不要在这里做的事:
 * - 不要在这里写文件,保存文本见 text-writer.ts
 */
import { promises as fs } from 'node:fs';
import { isAbsolute } from 'node:path';
import {
  fileViewKind,
  PDF_MAX_BYTES,
  type ReadPdfResponse,
  type StatFileResponse,
} from '@shared/file-tree';
import { logger } from './logger';
import { failureFrom, type SftpPool, type SftpRequestOptions } from './sftp-client';

export const PDF_CHUNK_BYTES = 1024 * 1024;
/** 规范允许文件头前有少量垃圾字节,这里与主流阅读器一样只看开头 1 KiB。 */
const HEADER_WINDOW_BYTES = 1024;

function isValidOffset(offset: number): boolean {
  return Number.isSafeInteger(offset) && offset >= 0;
}

/** Only text can exceed PDF_MAX_BYTES, see the design note above. */
function isTooLarge(path: string, size: number): boolean {
  return size > PDF_MAX_BYTES && fileViewKind(path) !== 'text';
}

/** One chunk at most: the caller's length is a request, not a way around the Link frame limit. */
function clampLength(length: number | undefined): number {
  if (length === undefined || !Number.isSafeInteger(length) || length <= 0) return PDF_CHUNK_BYTES;
  return Math.min(length, PDF_CHUNK_BYTES);
}

function failureOf(err: unknown): { ok: false; reason: 'not-found' | 'denied' | 'unknown' } {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  if (code === 'ENOENT' || code === 'ENOTDIR') return { ok: false, reason: 'not-found' };
  if (code === 'EACCES' || code === 'EPERM' || code === 'EBUSY') {
    return { ok: false, reason: 'denied' };
  }
  return { ok: false, reason: 'unknown' };
}

/** read-pdf 和 stat-file 共用的路径门槛:绝对路径、可查看的扩展名。 */
function isViewablePath(path: string): boolean {
  return isAbsolute(path) && fileViewKind(path) !== null;
}

/**
 * 本地和远端共用的检查与打包。
 *
 * @param path 决定是否按 PDF 校验文件头
 * @param head 文件开头的字节,PDF 每次都校验
 */
function toResponse(
  path: string,
  chunk: Buffer,
  head: Buffer,
  size: number,
  offset: number,
  mtimeMs: number | null,
): ReadPdfResponse {
  if (isTooLarge(path, size)) return { ok: false, reason: 'too-large' };
  if (fileViewKind(path) === 'pdf' && !head.subarray(0, HEADER_WINDOW_BYTES).includes('%PDF-')) {
    return { ok: false, reason: 'not-pdf' };
  }
  const end = offset + chunk.length;
  // 没读完却读不到内容:文件被截短了。当成读完会显示一份残缺的 PDF
  if (chunk.length === 0 && end < size) return { ok: false, reason: 'unknown' };
  return {
    ok: true,
    base64: chunk.toString('base64'),
    size,
    nextOffset: end < size ? end : null,
    mtimeMs,
  };
}

/**
 * 读取本地 PDF 的一块。
 *
 * @param offset 字节偏移
 * @param length 想读的字节数,不超过一块
 * @returns nextOffset 为 null 表示读完了
 */
export async function readPdfChunk(
  path: string,
  offset: number,
  length?: number,
): Promise<ReadPdfResponse> {
  if (!isViewablePath(path) || !isValidOffset(offset)) {
    return { ok: false, reason: 'not-found' };
  }
  let handle;
  try {
    handle = await fs.open(path, 'r');
    const stat = await handle.stat();
    if (!stat.isFile()) return { ok: false, reason: 'not-found' };
    const { size } = stat;
    if (isTooLarge(path, size)) return { ok: false, reason: 'too-large' };
    const head = Buffer.alloc(Math.min(HEADER_WINDOW_BYTES, size));
    await handle.read(head, 0, head.length, 0);
    const buffer = Buffer.alloc(Math.min(clampLength(length), Math.max(0, size - offset)));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
    return toResponse(path, buffer.subarray(0, bytesRead), head, size, offset, stat.mtimeMs);
  } catch (err) {
    logger.warn('Pdf', `readPdfChunk failed: path="${path}" offset=${offset}`, err);
    return failureOf(err);
  } finally {
    await handle?.close();
  }
}

/**
 * 读取远端 PDF 的一块。
 *
 * @param path 远端绝对路径
 * @param offset 字节偏移
 * @param options 用户刚点击时传 fresh + interactive,自动刷新重读时什么都不传;
 *   length 是想读的字节数(文本翻页),不超过一块
 * @returns 与 readPdfChunk 相同
 */
export async function readRemotePdfChunk(
  pool: Pick<SftpPool, 'readChunk'>,
  profileId: string,
  path: string,
  offset: number,
  options: SftpRequestOptions & { length?: number } = {},
): Promise<ReadPdfResponse> {
  const { length, ...sftpOptions } = options;
  const kind = fileViewKind(path);
  if (!kind || !isValidOffset(offset)) return { ok: false, reason: 'not-found' };
  try {
    const { chunk, size, mtimeMs } = await pool.readChunk(
      profileId,
      path,
      offset,
      clampLength(length),
      { ...sftpOptions, ...(kind === 'text' ? {} : { maxSize: PDF_MAX_BYTES }) },
    );
    if (isTooLarge(path, size)) return { ok: false, reason: 'too-large' };
    // Paging through text must not cost a second round trip per page for an unused header.
    const head =
      offset === 0 || kind === 'text'
        ? chunk
        : (await pool.readChunk(profileId, path, 0, HEADER_WINDOW_BYTES)).chunk;
    return toResponse(path, chunk, head, size, offset, mtimeMs);
  } catch (err) {
    return { ok: false, reason: failureFrom(err, `read pdf "${path}"`) };
  }
}

/**
 * 查本地可查看文件的大小和修改时间。门槛与 readPdfChunk 相同,这条命令同样不能用来探测
 * 任意文件是否存在。
 */
export async function statViewFile(path: string): Promise<StatFileResponse> {
  if (!isViewablePath(path)) return { ok: false, reason: 'not-found' };
  try {
    const stat = await fs.stat(path);
    if (!stat.isFile()) return { ok: false, reason: 'not-found' };
    if (isTooLarge(path, stat.size)) return { ok: false, reason: 'too-large' };
    return { ok: true, size: stat.size, mtimeMs: stat.mtimeMs };
  } catch (err) {
    return failureOf(err);
  }
}

/**
 * 查远端可查看文件的大小和修改时间。安静请求:不传 fresh,也不传 interactive,
 * 连接失败时按缓存的原因返回,不会触发登录提示。
 */
export async function statRemoteViewFile(
  pool: Pick<SftpPool, 'stat'>,
  profileId: string,
  path: string,
  options: Pick<SftpRequestOptions, 'windowId'> = {},
): Promise<StatFileResponse> {
  if (!fileViewKind(path)) return { ok: false, reason: 'not-found' };
  try {
    const { size, mtimeMs } = await pool.stat(profileId, path, options);
    if (isTooLarge(path, size)) return { ok: false, reason: 'too-large' };
    return { ok: true, size, mtimeMs };
  } catch (err) {
    return { ok: false, reason: failureFrom(err, `stat "${path}"`) };
  }
}
