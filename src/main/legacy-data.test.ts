/**
 * @file src/main/legacy-data.test.ts
 * @purpose 守护从 Marina 数据目录到 Ceteris 的一次性复制:旧目录只读,新目录不被覆盖,
 *   解密密码所需的 Local State 一定跟过来。全部在临时目录里运行。
 */
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { copyLegacyData, legacyAppName } from './legacy-data';

let root: string;
let from: string;
let to: string;

async function put(dir: string, relative: string, content: string): Promise<void> {
  const path = join(dir, relative);
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, content);
}

async function listAll(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await fs.readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    out[path.slice(dir.length + 1).replace(/\\/g, '/')] = await fs.readFile(path, 'utf8');
  }
  return out;
}

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'marina-test-'));
  from = join(root, 'old');
  to = join(root, 'new');
  await fs.mkdir(from);
  await fs.mkdir(to);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('legacyAppName', () => {
  it.each([
    ['Ceteris', 'Marina'],
    ['Ceteris (dev)', 'Marina (dev)'],
    ['Ceteris Beta', 'Marina Beta'],
    ['Ceteris (portable)', 'Marina (portable)'],
  ])('%s 对应 %s', (name, legacy) => {
    expect(legacyAppName(name)).toBe(legacy);
  });

  it('其他名字没有旧目录', () => {
    expect(legacyAppName('Electron')).toBeNull();
  });
});

describe('copyLegacyData', () => {
  it('复制配置、备份和浏览器存储', async () => {
    await put(from, 'settings.json', '{"a":1}');
    await put(from, 'settings.json.bak', '{"a":0}');
    await put(from, 'ssh-profiles.json', '[]');
    await put(from, 'session-data/Local Storage/leveldb/000003.log', 'prefs');

    const res = await copyLegacyData(from, to);

    expect(res.skipped).toBeNull();
    expect(res.failed).toEqual([]);
    expect(await listAll(to)).toEqual({
      'settings.json': '{"a":1}',
      'settings.json.bak': '{"a":0}',
      'ssh-profiles.json': '[]',
      'session-data/Local Storage/leveldb/000003.log': 'prefs',
    });
  });

  it('带上 Local State,否则保存的 SSH 密码无法解密', async () => {
    await put(from, 'ssh-profiles.json', '[]');
    await put(from, 'session-data/Local State', '{"os_crypt":{"encrypted_key":"k"}}');

    await copyLegacyData(from, to);

    expect(await fs.readFile(join(to, 'session-data', 'Local State'), 'utf8')).toContain('os_crypt');
  });

  it('只有 Local State 在根目录的旧版本也能带上', async () => {
    await put(from, 'ssh-profiles.json', '[]');
    await put(from, 'Local State', 'root');

    await copyLegacyData(from, to);

    expect(await fs.readFile(join(to, 'Local State'), 'utf8')).toBe('root');
  });

  it('旧目录完全不变', async () => {
    await put(from, 'settings.json', '{"a":1}');
    await put(from, 'session-data/Local State', 'key');
    await put(from, 'session-data/Cache/data_0', 'cache');
    const before = await listAll(from);

    await copyLegacyData(from, to);

    expect(await listAll(from)).toEqual(before);
  });

  it('不复制缓存、日志和单实例锁', async () => {
    await put(from, 'settings.json', '{}');
    await put(from, 'logs/main.log', 'log');
    await put(from, 'session-data/Cache/data_0', 'cache');
    await put(from, 'session-data/GPUCache/index', 'cache');
    await put(from, 'lockfile', 'lock');

    await copyLegacyData(from, to);

    expect(Object.keys(await listAll(to))).toEqual(['settings.json']);
  });

  it('新目录已有数据时什么都不做', async () => {
    await put(from, 'settings.json', 'old');
    await put(from, 'bookmarks.json', 'old');
    await put(to, 'bookmarks.json', 'new');

    const res = await copyLegacyData(from, to);

    expect(res).toEqual({ skipped: 'already-has-data', copied: [], failed: [] });
    expect(await listAll(to)).toEqual({ 'bookmarks.json': 'new' });
  });

  it('第二次启动不会覆盖用户改过的数据', async () => {
    await put(from, 'settings.json', 'old');
    await copyLegacyData(from, to);
    await fs.writeFile(join(to, 'settings.json'), 'changed in Ceteris');

    const res = await copyLegacyData(from, to);

    expect(res.skipped).toBe('already-has-data');
    expect(await fs.readFile(join(to, 'settings.json'), 'utf8')).toBe('changed in Ceteris');
  });

  it('新目录里已有的浏览器文件不被覆盖', async () => {
    await put(from, 'settings.json', '{}');
    await put(from, 'session-data/Local State', 'old key');
    await put(to, 'session-data/Local State', 'fresh key');

    await copyLegacyData(from, to);

    expect(await fs.readFile(join(to, 'session-data', 'Local State'), 'utf8')).toBe('fresh key');
  });

  it('旧目录不存在或没有配置时跳过', async () => {
    expect((await copyLegacyData(join(root, 'missing'), to)).skipped).toBe('no-legacy-data');
    await put(from, 'logs/main.log', 'log');
    expect((await copyLegacyData(from, to)).skipped).toBe('no-legacy-data');
    expect(await listAll(to)).toEqual({});
  });

  it('一项失败不影响其他项', async () => {
    await put(from, 'recent.json', '[]');
    await put(from, 'settings.json', '{}');
    // A file where a folder is needed makes the copy of this one item fail.
    await put(to, 'session-data', 'not a folder');
    await put(from, 'session-data/Local State', 'key');

    const res = await copyLegacyData(from, to);

    expect(res.copied).toEqual(expect.arrayContaining(['recent.json', 'settings.json']));
    expect(res.failed.map((f) => f.item.replace(/\\/g, '/'))).toEqual(['session-data/Local State']);
  });
});
