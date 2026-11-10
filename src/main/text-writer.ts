/**
 * @file src/main/text-writer.ts
 * @purpose Saves a .txt, .json, .tex, .sql, .hive or Markdown file edited in the viewer. A save either replaces the whole
 *   file or leaves it exactly as it was.
 *
 * @关键设计:
 * - Written to a temporary file beside the target, flushed, then renamed over it. A crash or a
 *   full disk mid-write leaves the original intact, which writing in place cannot promise.
 * - A save carries the modified time and size the editor loaded. If either differs, something
 *   else changed the file, often an agent in a terminal, and the save is refused so the user
 *   decides. Passing null skips the check: that is the user choosing to overwrite.
 * - Symbolic links are resolved first. Renaming over the link would replace it with a file.
 * - The original's mode is copied, since the temporary file starts with default permissions.
 * - Limited to editable text files (isEditableTextFile): over Link this command writes to the
 *   host's disk.
 *
 * @对应文档章节: 软件定义书.md 14.6, ADR-016, ADR-028
 *
 * @不要在这里做的事:
 * - 不要创建新文件:目标必须已存在,这里只保存编辑
 * - 不要支持 SFTP:远端文件树是只读的,见 sftp-client.ts
 *
 * @常见问题排查:
 * - 总是 denied → 另一个程序锁着文件 (Windows 上不能替换打开中的文件),或文件是只读
 * - 总是 changed → 有程序在持续写这个文件
 * - 目录里残留 .ceteris-tmp → 进程在 rename 前被杀,可以直接删除
 */
import { randomBytes } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import {
  isEditableTextFile,
  type WriteTextPayload,
  type WriteTextResponse,
} from '@shared/file-tree';
import { TEXT_WRITE_MAX_BYTES } from '@shared/text-file';
import { logger } from './logger';

function failureOf(err: unknown): WriteTextResponse {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  if (code === 'ENOENT' || code === 'ENOTDIR') return { ok: false, reason: 'not-found' };
  if (code === 'EACCES' || code === 'EPERM' || code === 'EBUSY' || code === 'EROFS') {
    return { ok: false, reason: 'denied' };
  }
  return { ok: false, reason: 'unknown' };
}

/**
 * Replaces a text file's contents.
 *
 * @returns the new modified time and size, which the next save must quote
 * @副作用: 改动磁盘,目录里短暂出现一个临时文件
 */
export async function writeTextFile(payload: WriteTextPayload): Promise<WriteTextResponse> {
  const { path, base64, expected } = payload;
  if (!isAbsolute(path) || !isEditableTextFile(path)) return { ok: false, reason: 'not-found' };
  // Checked on the encoded length first, so an oversized payload is never decoded.
  if (base64.length > ((TEXT_WRITE_MAX_BYTES + 2) / 3) * 4) {
    return { ok: false, reason: 'too-large' };
  }
  const bytes = Buffer.from(base64, 'base64');
  let temporary: string | null = null;
  try {
    const target = await fs.realpath(path);
    const stat = await fs.stat(target);
    if (!stat.isFile()) return { ok: false, reason: 'not-found' };
    if (expected && (stat.mtimeMs !== expected.mtimeMs || stat.size !== expected.size)) {
      return { ok: false, reason: 'changed' };
    }
    // rename ignores the target's permissions on POSIX, so a read-only file needs this.
    await fs.access(target, constants.W_OK);

    const id = randomBytes(6).toString('hex');
    temporary = join(dirname(target), `.${basename(target)}.${id}.ceteris-tmp`);
    const handle = await fs.open(temporary, 'wx', stat.mode);
    try {
      await handle.writeFile(bytes);
      await handle.chmod(stat.mode);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, target);
    temporary = null;
    const saved = await fs.stat(target);
    logger.info('TextWriter', `saved: path="${target}" bytes=${bytes.length}`);
    return { ok: true, mtimeMs: saved.mtimeMs, size: saved.size };
  } catch (err) {
    logger.warn('TextWriter', `save failed: path="${path}"`, err);
    return failureOf(err);
  } finally {
    if (temporary) await fs.unlink(temporary).catch(() => undefined);
  }
}
