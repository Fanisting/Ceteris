/**
 * @file src/main/file-tree.ts
 * @purpose 侧栏文件树的文件系统操作:列目录、重命名条目。
 *
 * @关键设计:
 * - 按需列单层目录,不递归,所以 node_modules 这样的大目录只有被展开时才有开销。
 * - 用户操作的常规失败 (同名、被占用、已删除) 走返回值的 reason,不 throw。
 * - 不写 process.platform 判断 (AGENTS.md 8.1):同一套逻辑在各平台成立。
 *
 * @对应文档章节: 软件定义书.md 14.6
 *
 * @不要在这里做的事:
 * - 不要提供删除、移动、写文件 (内置文件编辑器在 13.2 永远不做列表里)
 * - 不要访问 SSH 路径,远端文件浏览不做,判断在 resolveFileTreeRoot
 *
 * @常见问题排查:
 * - 重命名文件夹返回 denied → 通常是有 shell 的 cwd 在里面,Windows 不允许改名
 * - 目录显示 not-found 但实际存在 → 看日志里的路径,WSL 路径应为 UNC 形式
 */
import { promises as fs } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import {
  FILE_TREE_MAX_ENTRIES,
  isValidEntryName,
  sortEntries,
  type FileTreeEntry,
  type FileTreeFailure,
  type ListDirResponse,
  type RenameEntryResponse,
} from '@shared/file-tree';
import { logger } from './logger';

function failureReason(err: unknown): FileTreeFailure {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  if (code === 'ENOENT' || code === 'ENOTDIR') return 'not-found';
  if (code === 'EACCES' || code === 'EPERM' || code === 'EBUSY') return 'denied';
  return 'unknown';
}

/** Dirent 对符号链接和 junction 不说明目标类型,要再 stat 一次;断链按文件显示。 */
async function resolvesToDirectory(fullPath: string): Promise<boolean> {
  try {
    return (await fs.stat(fullPath)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 列出一层目录。
 *
 * @param dirPath 目录绝对路径
 * @param maxEntries 条目上限,超过时截断并标记 truncated
 * @returns 排好序的条目
 */
export async function listDirectory(
  dirPath: string,
  maxEntries: number = FILE_TREE_MAX_ENTRIES,
): Promise<ListDirResponse> {
  if (!isAbsolute(dirPath)) return { ok: false, reason: 'not-found' };
  try {
    const dirents = await fs.readdir(dirPath, { withFileTypes: true });
    const entries: FileTreeEntry[] = await Promise.all(
      dirents.map(async (dirent) => {
        const fullPath = join(dirPath, dirent.name);
        const isDirectory = dirent.isSymbolicLink()
          ? await resolvesToDirectory(fullPath)
          : dirent.isDirectory();
        return { name: dirent.name, path: fullPath, isDirectory };
      }),
    );
    const sorted = sortEntries(entries);
    return {
      ok: true,
      entries: sorted.slice(0, maxEntries),
      truncated: sorted.length > maxEntries,
    };
  } catch (err) {
    logger.warn('FileTree', `listDirectory failed: path="${dirPath}"`, err);
    return { ok: false, reason: failureReason(err) };
  }
}

/**
 * 判断 target 是否是另一个已存在的条目。
 *
 * foo 改成 Foo 在大小写不敏感的文件系统上 lstat(target) 会命中自身,这种情况要放行。
 * 名字大小写相同还要比 inode:大小写敏感的文件系统上 foo 和 Foo 可以是两个文件。
 */
async function targetBlocksRename(sourcePath: string, targetPath: string): Promise<boolean> {
  let target;
  try {
    target = await fs.lstat(targetPath, { bigint: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
  if (sourcePath.toLowerCase() !== targetPath.toLowerCase()) return true;
  const source = await fs.lstat(sourcePath, { bigint: true });
  return source.ino !== target.ino || source.dev !== target.dev;
}

/**
 * 在原目录内重命名一个文件或文件夹。
 *
 * @param sourcePath 条目绝对路径
 * @param newName 新文件名,不含路径
 * @returns 成功时返回新路径
 *
 * @副作用: 改动磁盘。目标存在时绝不覆盖:Windows 上 fs.rename 会静默替换同名
 *   文件,所以必须先检查。检查和改名之间有极小的竞争窗口,这里接受它,因为
 *   Node 没有提供不覆盖的原子重命名。
 */
export async function renameEntry(
  sourcePath: string,
  newName: string,
): Promise<RenameEntryResponse> {
  if (!isAbsolute(sourcePath) || !isValidEntryName(newName)) {
    return { ok: false, reason: 'invalid-name' };
  }
  const targetPath = join(dirname(sourcePath), newName);
  if (targetPath === sourcePath) return { ok: true, path: sourcePath };

  try {
    await fs.lstat(sourcePath);
    if (await targetBlocksRename(sourcePath, targetPath)) {
      return { ok: false, reason: 'exists' };
    }
    await fs.rename(sourcePath, targetPath);
    logger.info('FileTree', `renamed: "${sourcePath}" -> "${targetPath}"`);
    return { ok: true, path: targetPath };
  } catch (err) {
    logger.warn('FileTree', `renameEntry failed: path="${sourcePath}" newName="${newName}"`, err);
    return { ok: false, reason: failureReason(err) };
  }
}
