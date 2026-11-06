/**
 * @file src/main/file-tree.test.ts
 * @purpose 用真实临时目录验证列目录和重命名,重点是"绝不覆盖已有文件"。
 *   只操作 os.tmpdir() 下的临时目录 (AGENTS.md 9.1)。
 */
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listDirectory, renameEntry } from './file-tree';

vi.mock('./logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'ceteris-test-'));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('listDirectory', () => {
  it('文件夹排在文件前面,并返回绝对路径', async () => {
    await fs.mkdir(join(root, 'src'));
    await fs.writeFile(join(root, 'a.txt'), 'x');

    const res = await listDirectory(root);

    expect(res).toEqual({
      ok: true,
      truncated: false,
      entries: [
        { name: 'src', path: join(root, 'src'), isDirectory: true },
        { name: 'a.txt', path: join(root, 'a.txt'), isDirectory: false },
      ],
    });
  });

  it('空目录返回空列表', async () => {
    expect(await listDirectory(root)).toEqual({ ok: true, entries: [], truncated: false });
  });

  it('目录不存在时返回 not-found', async () => {
    expect(await listDirectory(join(root, 'gone'))).toEqual({ ok: false, reason: 'not-found' });
  });

  it('传入文件路径时返回 not-found', async () => {
    await fs.writeFile(join(root, 'a.txt'), 'x');
    expect(await listDirectory(join(root, 'a.txt'))).toEqual({ ok: false, reason: 'not-found' });
  });

  it('拒绝相对路径', async () => {
    expect(await listDirectory('relative\\path')).toEqual({ ok: false, reason: 'not-found' });
  });

  it('超过上限时截断并标记', async () => {
    // 上限用参数注入:写几千个真实文件的磁盘负载会干扰同时运行的计时测试
    await Promise.all(['a', 'b', 'c'].map((n) => fs.writeFile(join(root, n), '')));

    const res = await listDirectory(root, 2);

    expect(res.ok && res.entries.map((e) => e.name)).toEqual(['a', 'b']);
    expect(res.ok && res.truncated).toBe(true);
  });

  it('条目数正好等于上限时不算截断', async () => {
    await Promise.all(['a', 'b'].map((n) => fs.writeFile(join(root, n), '')));

    const res = await listDirectory(root, 2);

    expect(res.ok && res.truncated).toBe(false);
  });
});

describe('renameEntry', () => {
  it('重命名文件并保留内容', async () => {
    const source = join(root, 'old.txt');
    await fs.writeFile(source, 'content');

    const res = await renameEntry(source, 'new.txt');

    expect(res).toEqual({ ok: true, path: join(root, 'new.txt') });
    expect(await fs.readFile(join(root, 'new.txt'), 'utf-8')).toBe('content');
    await expect(fs.access(source)).rejects.toThrow();
  });

  it('重命名文件夹并保留子项', async () => {
    await fs.mkdir(join(root, 'old'));
    await fs.writeFile(join(root, 'old', 'child.txt'), 'x');

    await renameEntry(join(root, 'old'), 'new');

    expect(await fs.readFile(join(root, 'new', 'child.txt'), 'utf-8')).toBe('x');
  });

  it('目标已存在时绝不覆盖,两个文件都不变', async () => {
    await fs.writeFile(join(root, 'a.txt'), 'A');
    await fs.writeFile(join(root, 'b.txt'), 'B');

    const res = await renameEntry(join(root, 'a.txt'), 'b.txt');

    expect(res).toEqual({ ok: false, reason: 'exists' });
    expect(await fs.readFile(join(root, 'a.txt'), 'utf-8')).toBe('A');
    expect(await fs.readFile(join(root, 'b.txt'), 'utf-8')).toBe('B');
  });

  it('文件不能覆盖同名文件夹', async () => {
    await fs.writeFile(join(root, 'a.txt'), 'A');
    await fs.mkdir(join(root, 'dir'));

    expect(await renameEntry(join(root, 'a.txt'), 'dir')).toEqual({ ok: false, reason: 'exists' });
  });

  it('允许只改大小写', async () => {
    await fs.writeFile(join(root, 'readme.md'), 'x');

    const res = await renameEntry(join(root, 'readme.md'), 'README.md');

    expect(res).toEqual({ ok: true, path: join(root, 'README.md') });
    expect(await fs.readdir(root)).toEqual(['README.md']);
  });

  it('新旧名字相同时不动磁盘,直接成功', async () => {
    await fs.writeFile(join(root, 'a.txt'), 'x');
    expect(await renameEntry(join(root, 'a.txt'), 'a.txt')).toEqual({
      ok: true,
      path: join(root, 'a.txt'),
    });
  });

  it('源文件已被删除时返回 not-found', async () => {
    expect(await renameEntry(join(root, 'gone.txt'), 'x.txt')).toEqual({
      ok: false,
      reason: 'not-found',
    });
  });

  it.each(['..\\escape.txt', '../escape.txt', 'sub\\x.txt', '', 'CON', 'bad:name'])(
    '拒绝非法文件名 %j,文件留在原处',
    async (newName) => {
      await fs.writeFile(join(root, 'a.txt'), 'x');

      const res = await renameEntry(join(root, 'a.txt'), newName);

      expect(res).toEqual({ ok: false, reason: 'invalid-name' });
      expect(await fs.readdir(root)).toEqual(['a.txt']);
    },
  );

  it('拒绝相对的源路径', async () => {
    expect(await renameEntry('a.txt', 'b.txt')).toEqual({ ok: false, reason: 'invalid-name' });
  });
});
