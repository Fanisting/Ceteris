/**
 * @file src/main/path-manager.test.ts
 * @purpose PathManager 单元测试。覆盖文件夹列表的增删改查、旧数据并入、标签、错误码。
 *
 * @关键设计:
 * - 用 in-memory FakeJsonStore 替代真实 JsonStore,避免 fs I/O 影响测试
 *   速度;persistence 自身的 atomic / debounce 由 persistence.test.ts
 *   单独覆盖,这里只验证 PathManager 调对了 store.set
 * - 每个测试用 new PathManager 隔离状态,绝不共享
 *
 * @对应文档章节: AGENTS.md 5.3 (PathManager 增删改查);软件定义书.md ADR-015
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';
import type { BookmarksFile, RecentFile } from '@shared/types';
import { PathManager, PathManagerError, normalizePath } from './path-manager';
import type { JsonStore } from './persistence';

/**
 * 内存 JsonStore 替身。只关心 load() 返回什么 + set() 被调用时存的值。
 */
class FakeJsonStore<T> {
  private current: T | null = null;
  /** 给测试断言用,记录每次 set 的内容 */
  public readonly setHistory: T[] = [];

  setInitial(value: T): void {
    this.current = value;
  }

  async load(defaultValue: T): Promise<{ value: T; source: 'main' | 'bak' | 'default' }> {
    if (this.current !== null) return { value: this.current, source: 'main' };
    return { value: defaultValue, source: 'default' };
  }

  set(value: T): void {
    this.current = value;
    this.setHistory.push(value);
  }

  getInMemory(): T | null {
    return this.current;
  }

  async flush(): Promise<void> {
    /* no-op */
  }

  destroy(): void {
    /* no-op */
  }
}

function makeManager(opts?: {
  initialBookmarks?: BookmarksFile;
  initialRecent?: RecentFile;
}): {
  mgr: PathManager;
  bookmarksStore: FakeJsonStore<BookmarksFile>;
  recentStore: FakeJsonStore<RecentFile>;
} {
  const bookmarksStore = new FakeJsonStore<BookmarksFile>();
  const recentStore = new FakeJsonStore<RecentFile>();
  if (opts?.initialBookmarks) bookmarksStore.setInitial(opts.initialBookmarks);
  if (opts?.initialRecent) recentStore.setInitial(opts.initialRecent);
  const mgr = new PathManager(
    bookmarksStore as unknown as JsonStore<BookmarksFile>,
    recentStore as unknown as JsonStore<RecentFile>,
  );
  return { mgr, bookmarksStore, recentStore };
}

const TEST_PATH_A = process.platform === 'win32' ? 'C:\\projects\\a' : '/projects/a';
const TEST_PATH_B = process.platform === 'win32' ? 'C:\\projects\\b' : '/projects/b';
const TEST_PATH_C = process.platform === 'win32' ? 'C:\\projects\\c' : '/projects/c';

describe('normalizePath', () => {
  if (process.platform === 'win32') {
    it('Windows: 卷符大写化', () => {
      expect(normalizePath('c:\\foo\\bar')).toBe('C:\\foo\\bar');
      expect(normalizePath('C:\\foo\\bar')).toBe('C:\\foo\\bar');
    });

    it('Windows: 移除尾部反斜杠 (除根)', () => {
      expect(normalizePath('C:\\foo\\bar\\')).toBe('C:\\foo\\bar');
      // resolve('C:\\') 在 Windows 上规范化为 'C:\\',这是根,不剥离
      expect(normalizePath('C:\\').endsWith('\\')).toBe(true);
    });
  } else {
    it('POSIX: 移除尾部斜杠', () => {
      expect(normalizePath('/foo/bar/')).toBe('/foo/bar');
      expect(normalizePath('/')).toBe('/');
    });
  }

  it('相对路径 → 绝对', () => {
    const result = normalizePath('.');
    expect(result.length).toBeGreaterThan(1);
  });
});

describe('PathManager — 初始化', () => {
  it('空 store 时 tree 为空', async () => {
    const { mgr } = makeManager();
    await mgr.initialize();
    expect(mgr.getTree()).toEqual({ bookmarks: [], temporary: [] });
  });

  it('从持久化恢复 bookmarks', async () => {
    const { mgr } = makeManager({
      initialBookmarks: {
        version: 1,
        paths: [
          { id: 'b1', path: TEST_PATH_A, addedAt: 1 },
          { id: 'b2', path: TEST_PATH_B, displayName: 'Project B', addedAt: 2 },
        ],
      },
    });
    await mgr.initialize();
    const tree = mgr.getTree();
    expect(tree.bookmarks).toHaveLength(2);
    expect(tree.bookmarks[0]!.path).toBe(TEST_PATH_A);
    expect(tree.bookmarks[1]!.displayName).toBe('Project B');
  });

  it('旧的最近文件夹并入列表,最近用过的在前,已有的不重复', async () => {
    const { mgr, recentStore } = makeManager({
      initialBookmarks: {
        version: 1,
        paths: [{ id: 'kept', path: TEST_PATH_C, addedAt: 1 }],
      },
      initialRecent: {
        version: 1,
        paths: [
          { path: TEST_PATH_A, lastUsedAt: 100, useCount: 1 },
          { path: TEST_PATH_B, lastUsedAt: 300, useCount: 5 },
          { path: TEST_PATH_C, lastUsedAt: 200, useCount: 2 },
        ],
      },
    });
    await mgr.initialize();
    expect(mgr.getTree().bookmarks.map((n) => n.path)).toEqual([
      TEST_PATH_C,
      TEST_PATH_B,
      TEST_PATH_A,
    ]);
    expect(recentStore.getInMemory()?.paths).toEqual([]);
  });

  it('并入后再次启动不会让已移除的文件夹回来', async () => {
    const { mgr, bookmarksStore, recentStore } = makeManager({
      initialRecent: {
        version: 1,
        paths: [{ path: TEST_PATH_A, lastUsedAt: 100, useCount: 1 }],
      },
    });
    await mgr.initialize();
    mgr.removeBookmark(TEST_PATH_A);

    const next = new PathManager(
      bookmarksStore as unknown as JsonStore<BookmarksFile>,
      recentStore as unknown as JsonStore<RecentFile>,
    );
    await next.initialize();
    expect(next.getTree().bookmarks).toEqual([]);
  });

  // ──────────────────────────────────────────────────────────────────
  // SSH 方案 v2.1 §II.1:磁盘迁移不变式 — 老 schema(kind 缺失)、损坏
  // schema(kind=ssh 缺 sshProfileId)都要能让 Ceteris 启动起来。
  // ──────────────────────────────────────────────────────────────────

  it('迁移:旧 bookmark 缺 kind → 自动按 local 加载', async () => {
    const { mgr } = makeManager({
      initialBookmarks: {
        version: 1,
        paths: [{ id: 'legacy', path: TEST_PATH_A, addedAt: 1 }],
      },
    });
    await mgr.initialize();
    const tree = mgr.getTree();
    expect(tree.bookmarks).toHaveLength(1);
    expect(tree.bookmarks[0]!.kind).toBe('local');
  });

  it('迁移:旧 recent 缺 kind → 按 local 并入', async () => {
    const { mgr } = makeManager({
      initialRecent: {
        version: 1,
        paths: [{ path: TEST_PATH_A, lastUsedAt: 100, useCount: 1 }],
      },
    });
    await mgr.initialize();
    expect(mgr.getTree().bookmarks[0]?.kind).toBe('local');
  });

  it('迁移:kind=ssh 但缺 sshProfileId 的 bookmark → 启动期静默丢弃', async () => {
    const { mgr } = makeManager({
      initialBookmarks: {
        version: 1,
        paths: [
          { id: 'ok', path: TEST_PATH_A, addedAt: 1 },
          { id: 'broken', path: '~/x', kind: 'ssh', addedAt: 2 },
        ],
      },
    });
    await mgr.initialize();
    const tree = mgr.getTree();
    expect(tree.bookmarks).toHaveLength(1);
    expect(tree.bookmarks[0]!.id).toBe(normalizePath(TEST_PATH_A));
  });

  it('迁移:kind=ssh 完整 bookmark 正常加载,narrow 出 sshProfileId', async () => {
    const { mgr } = makeManager({
      initialBookmarks: {
        version: 1,
        paths: [
          {
            id: 'r',
            path: '~/repo',
            kind: 'ssh',
            sshProfileId: 'profile-a',
            addedAt: 1,
          },
        ],
      },
    });
    await mgr.initialize();
    const tree = mgr.getTree();
    expect(tree.bookmarks).toHaveLength(1);
    const node = tree.bookmarks[0]!;
    expect(node.kind).toBe('ssh');
    if (node.kind === 'ssh') {
      expect(node.sshProfileId).toBe('profile-a');
    }
  });
});

describe('PathManager — addBookmark / removeBookmark', () => {
  it('addBookmark 添加新条目并落盘', async () => {
    const { mgr, bookmarksStore } = makeManager();
    await mgr.initialize();

    const b = mgr.addBookmark({ path: TEST_PATH_A, displayName: 'Alpha' });
    expect(b.path).toBe(TEST_PATH_A);
    expect(b.displayName).toBe('Alpha');
    expect(b.id).toMatch(/^[0-9a-f-]{36}$/);

    const tree = mgr.getTree();
    expect(tree.bookmarks).toHaveLength(1);
    expect(bookmarksStore.setHistory).toHaveLength(1);
    expect(bookmarksStore.setHistory[0]!.paths[0]!.path).toBe(TEST_PATH_A);
  });

  it('addBookmark 重复路径 throw BookmarkAlreadyExists', async () => {
    const { mgr } = makeManager();
    await mgr.initialize();
    mgr.addBookmark({ path: TEST_PATH_A });
    expect(() => mgr.addBookmark({ path: TEST_PATH_A })).toThrowError(
      /BookmarkAlreadyExists/,
    );
  });

  it('removeBookmark 后文件夹离开列表', async () => {
    const { mgr } = makeManager();
    await mgr.initialize();
    mgr.addBookmark({ path: TEST_PATH_A });
    mgr.removeBookmark(TEST_PATH_A);
    expect(mgr.getTree()).toEqual({ bookmarks: [], temporary: [] });
  });

  it('removeBookmark 时若有 session → 终端关闭前仍显示,之后消失', async () => {
    const { mgr } = makeManager();
    await mgr.initialize();
    mgr.addBookmark({ path: TEST_PATH_A });
    mgr.attachSession('s1', TEST_PATH_A);
    mgr.removeBookmark(TEST_PATH_A);
    expect(mgr.getTree().temporary.map((n) => n.path)).toEqual([TEST_PATH_A]);

    mgr.detachSession('s1');
    expect(mgr.getTree()).toEqual({ bookmarks: [], temporary: [] });
  });

  it('removeBookmark 不存在 throw BookmarkNotFound', async () => {
    const { mgr } = makeManager();
    await mgr.initialize();
    expect(() => mgr.removeBookmark(TEST_PATH_A)).toThrowError(/BookmarkNotFound/);
  });
});

describe('PathManager — renameBookmark / reorderBookmarks / setDefaultTemplate', () => {
  beforeEach(() => {
    /* placeholder */
  });

  it('renameBookmark 修改 displayName', async () => {
    const { mgr } = makeManager();
    await mgr.initialize();
    mgr.addBookmark({ path: TEST_PATH_A });
    mgr.renameBookmark(TEST_PATH_A, 'My Alpha');
    expect(mgr.getTree().bookmarks[0]!.displayName).toBe('My Alpha');
  });

  it('renameBookmark 空字符串 → 清掉 displayName', async () => {
    const { mgr } = makeManager();
    await mgr.initialize();
    mgr.addBookmark({ path: TEST_PATH_A, displayName: 'Old' });
    mgr.renameBookmark(TEST_PATH_A, '');
    expect(mgr.getTree().bookmarks[0]!.displayName).toBeUndefined();
  });

  it('renameBookmark 超长 / 非字符串 throw InvalidName', async () => {
    const { mgr } = makeManager();
    await mgr.initialize();
    mgr.addBookmark({ path: TEST_PATH_A });
    expect(() => mgr.renameBookmark(TEST_PATH_A, 'x'.repeat(101))).toThrowError(
      /InvalidName/,
    );
    expect(() => mgr.renameBookmark(TEST_PATH_A, 123 as unknown as string)).toThrowError(
      /InvalidName/,
    );
  });

  it('reorderBookmarks 改顺序', async () => {
    const { mgr } = makeManager();
    await mgr.initialize();
    mgr.addBookmark({ path: TEST_PATH_A });
    mgr.addBookmark({ path: TEST_PATH_B });
    mgr.addBookmark({ path: TEST_PATH_C });
    mgr.reorderBookmarks([TEST_PATH_C, TEST_PATH_A, TEST_PATH_B]);
    const tree = mgr.getTree();
    expect(tree.bookmarks.map((b) => b.path)).toEqual([
      TEST_PATH_C,
      TEST_PATH_A,
      TEST_PATH_B,
    ]);
  });

  it('reorderBookmarks 数量不匹配 throw InvalidOrderList', async () => {
    const { mgr } = makeManager();
    await mgr.initialize();
    mgr.addBookmark({ path: TEST_PATH_A });
    mgr.addBookmark({ path: TEST_PATH_B });
    expect(() => mgr.reorderBookmarks([TEST_PATH_A])).toThrowError(/InvalidOrderList/);
  });

  it('reorderBookmarks 含未知 path throw InvalidOrderList', async () => {
    const { mgr } = makeManager();
    await mgr.initialize();
    mgr.addBookmark({ path: TEST_PATH_A });
    mgr.addBookmark({ path: TEST_PATH_B });
    expect(() => mgr.reorderBookmarks([TEST_PATH_A, TEST_PATH_C])).toThrowError(
      /InvalidOrderList/,
    );
  });

  it('reorderBookmarks 重复 id throw InvalidOrderList', async () => {
    const { mgr } = makeManager();
    await mgr.initialize();
    mgr.addBookmark({ path: TEST_PATH_A });
    mgr.addBookmark({ path: TEST_PATH_B });
    expect(() => mgr.reorderBookmarks([TEST_PATH_A, TEST_PATH_A])).toThrowError(
      /InvalidOrderList/,
    );
  });

  it('setDefaultTemplate 设置和清空', async () => {
    const { mgr } = makeManager();
    await mgr.initialize();
    mgr.addBookmark({ path: TEST_PATH_A });
    mgr.setDefaultTemplate(TEST_PATH_A, 'claude-code');
    expect(mgr.getTree().bookmarks[0]!.defaultTemplateId).toBe('claude-code');
    mgr.setDefaultTemplate(TEST_PATH_A, null);
    expect(mgr.getTree().bookmarks[0]!.defaultTemplateId).toBeUndefined();
  });
});

describe('PathManager — Session attach / detach', () => {
  it('在列表外的文件夹 attach session → 加入列表并保留', async () => {
    const { mgr, bookmarksStore } = makeManager();
    await mgr.initialize();
    mgr.attachSession('s1', TEST_PATH_A);
    expect(mgr.getTree().bookmarks.map((n) => n.path)).toEqual([TEST_PATH_A]);
    expect(bookmarksStore.getInMemory()?.paths).toHaveLength(1);

    mgr.detachSession('s1');
    const [folder] = mgr.getTree().bookmarks;
    expect(folder?.path).toBe(TEST_PATH_A);
    expect(folder?.sessionIds).toEqual([]);
  });

  it('在列表内的文件夹 attach session → 不重复出现', async () => {
    const { mgr } = makeManager();
    await mgr.initialize();
    mgr.addBookmark({ path: TEST_PATH_A });
    mgr.attachSession('s1', TEST_PATH_A);
    mgr.attachSession('s2', TEST_PATH_A);

    const tree = mgr.getTree();
    expect(tree.bookmarks).toHaveLength(1);
    expect(tree.bookmarks[0]?.sessionIds.sort()).toEqual(['s1', 's2']);
    expect(tree.temporary).toEqual([]);
  });

  it('attach 已在的 session 到不同 path → 自动从旧 path detach', async () => {
    const { mgr } = makeManager();
    await mgr.initialize();
    mgr.attachSession('s1', TEST_PATH_A);
    mgr.attachSession('s1', TEST_PATH_B);

    const nodes = mgr.getTree().bookmarks;
    expect(nodes.find((n) => n.path === TEST_PATH_A)?.sessionIds).toEqual([]);
    expect(nodes.find((n) => n.path === TEST_PATH_B)?.sessionIds).toEqual(['s1']);
  });

  it('detach 不存在的 sessionId 不报错 (幂等)', async () => {
    const { mgr } = makeManager();
    await mgr.initialize();
    expect(() => mgr.detachSession('nope')).not.toThrow();
  });
});

describe('PathManager — 标签', () => {
  it('setTags 清理后保存,并出现在 tree 和磁盘上', async () => {
    const { mgr, bookmarksStore } = makeManager();
    await mgr.initialize();
    mgr.addBookmark({ path: TEST_PATH_A });
    mgr.setTags(TEST_PATH_A, [' paper ', 'Paper', 'teaching']);

    expect(mgr.getTree().bookmarks[0]?.tags).toEqual(['paper', 'teaching']);
    expect(bookmarksStore.getInMemory()?.paths[0]?.tags).toEqual(['paper', 'teaching']);
  });

  it('空列表清掉标签字段', async () => {
    const { mgr } = makeManager();
    await mgr.initialize();
    mgr.addBookmark({ path: TEST_PATH_A });
    mgr.setTags(TEST_PATH_A, ['paper']);
    mgr.setTags(TEST_PATH_A, []);
    expect(mgr.getTree().bookmarks[0]).not.toHaveProperty('tags');
  });

  it('不在列表的文件夹 throw BookmarkNotFound', async () => {
    const { mgr } = makeManager();
    await mgr.initialize();
    expect(() => mgr.setTags(TEST_PATH_A, ['paper'])).toThrow(PathManagerError);
  });

  it('标签随重启和导入保留', async () => {
    const { mgr } = makeManager({
      initialBookmarks: {
        version: 1,
        paths: [{ id: 'a', path: TEST_PATH_A, addedAt: 1, tags: ['paper'] }],
      },
    });
    await mgr.initialize();
    expect(mgr.getTree().bookmarks[0]?.tags).toEqual(['paper']);

    mgr.replaceAll({
      bookmarks: [{ id: 'b', path: TEST_PATH_B, addedAt: 2, tags: ['teaching'] }],
      recent: [{ path: TEST_PATH_C, lastUsedAt: 3, useCount: 1 }],
    });
    const tree = mgr.getTree();
    expect(tree.bookmarks.map((n) => n.path)).toEqual([TEST_PATH_B, TEST_PATH_C]);
    expect(tree.bookmarks[0]?.tags).toEqual(['teaching']);
  });
});

describe('PathManager — 事件发射', () => {
  it('addBookmark 触发 pathTreeUpdated 与 bookmarksUpdated', async () => {
    const { mgr } = makeManager();
    await mgr.initialize();
    const treeListener = vi.fn();
    const bkListener = vi.fn();
    mgr.on('pathTreeUpdated', treeListener);
    mgr.on('bookmarksUpdated', bkListener);

    mgr.addBookmark({ path: TEST_PATH_A });
    expect(treeListener).toHaveBeenCalledTimes(1);
    expect(bkListener).toHaveBeenCalledTimes(1);
  });

  it('attachSession 触发 pathTreeUpdated', async () => {
    const { mgr } = makeManager();
    await mgr.initialize();
    const treeListener = vi.fn();
    mgr.on('pathTreeUpdated', treeListener);
    mgr.attachSession('s1', TEST_PATH_A);
    expect(treeListener).toHaveBeenCalledTimes(1);
  });

  it('attach 同一 sessionId + 同一 path 不重复触发', async () => {
    const { mgr } = makeManager();
    await mgr.initialize();
    mgr.attachSession('s1', TEST_PATH_A);
    const treeListener = vi.fn();
    mgr.on('pathTreeUpdated', treeListener);
    mgr.attachSession('s1', TEST_PATH_A);
    expect(treeListener).not.toHaveBeenCalled();
  });
});

describe('PathManager — flush', () => {
  it('flush 调用底层 store.flush', async () => {
    const { mgr, bookmarksStore, recentStore } = makeManager();
    const bkFlush = vi.spyOn(bookmarksStore, 'flush');
    const rcFlush = vi.spyOn(recentStore, 'flush');
    await mgr.initialize();
    await mgr.flush();
    expect(bkFlush).toHaveBeenCalled();
    expect(rcFlush).toHaveBeenCalled();
  });
});

describe('PathManagerError', () => {
  it('暴露 code 字段供 IPC 翻译', () => {
    const err = new PathManagerError('BookmarkNotFound', 'foo');
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('BookmarkNotFound');
    expect(err.message).toContain('BookmarkNotFound');
  });
});
