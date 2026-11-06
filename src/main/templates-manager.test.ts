/**
 * @file src/main/templates-manager.test.ts
 * @purpose TemplatesManager 单元测试。覆盖 initialize 加载 + mergeBuiltins
 *   补齐 + 默认 ID 校验、resolve 兜底、setDefault、emitUpdated。
 *
 * @关键设计:
 * - JsonStore 用 mock 而非真实 fs,避免测试时落盘
 * - mergeBuiltins 在 session-manager.test.ts 已有覆盖,这里只测 manager 集成
 *
 * @对应文档章节: AGENTS.md 5.3 必测 (持久化往返、损坏恢复、mergeBuiltins)。
 */
import { describe, expect, it, vi } from 'vitest';
import { BUILTIN_TEMPLATES, TemplatesManager, TemplatesManagerError } from './templates-manager';
import type { JsonStore } from './persistence';
import type { Template, TemplatesFile } from '@shared/types';

interface MockStore extends JsonStore<TemplatesFile> {
  __setLoadResult(value: TemplatesFile, source: 'main' | 'bak' | 'default'): void;
  __getSet(): TemplatesFile | null;
}

function makeMockStore(): MockStore {
  let loadValue: TemplatesFile = {
    version: 1,
    defaultTemplateId: 'shell',
    templates: [],
  };
  let loadSource: 'main' | 'bak' | 'default' = 'default';
  let lastSet: TemplatesFile | null = null;

  const stub = {
    async load(_defaults: TemplatesFile) {
      return { value: loadValue, source: loadSource };
    },
    set(value: TemplatesFile) {
      lastSet = value;
    },
    async flush() {
      // noop
    },
    __setLoadResult(value: TemplatesFile, source: 'main' | 'bak' | 'default') {
      loadValue = value;
      loadSource = source;
    },
    __getSet() {
      return lastSet;
    },
  };
  return stub as unknown as MockStore;
}

describe('TemplatesManager — initialize', () => {
  it('空 store 加载 → 内置模板齐全,defaultId=shell', async () => {
    const store = makeMockStore();
    const mgr = new TemplatesManager(store);
    const src = await mgr.initialize();
    expect(src).toBe('default');
    expect(mgr.list()).toHaveLength(BUILTIN_TEMPLATES.length);
    expect(mgr.list().map((t) => t.id)).toEqual(BUILTIN_TEMPLATES.map((b) => b.id));
    expect(mgr.getDefaultTemplateId()).toBe('shell');
  });

  it('用户改了内置模板 name → 加载后保留用户版本', async () => {
    const store = makeMockStore();
    const userShell: Template = {
      ...BUILTIN_TEMPLATES[0]!,
      name: 'My Shell',
    };
    store.__setLoadResult(
      {
        version: 1,
        defaultTemplateId: 'shell',
        templates: [userShell, ...BUILTIN_TEMPLATES.slice(1)],
      },
      'main',
    );
    const mgr = new TemplatesManager(store);
    await mgr.initialize();
    const shell = mgr.get('shell');
    expect(shell?.name).toBe('My Shell');
  });

  it('mergeBuiltins 检测到 mutated → 回写持久化', async () => {
    const store = makeMockStore();
    // 故意只给一个内置模板,触发 mergeBuiltins 补齐其他三个
    store.__setLoadResult(
      {
        version: 1,
        defaultTemplateId: 'shell',
        templates: [BUILTIN_TEMPLATES[0]!],
      },
      'main',
    );
    const mgr = new TemplatesManager(store);
    await mgr.initialize();
    const written = store.__getSet();
    expect(written).not.toBeNull();
    expect(written!.templates).toHaveLength(BUILTIN_TEMPLATES.length);
  });

  it('persistence 损坏 → 走默认值', async () => {
    const store = makeMockStore();
    store.__setLoadResult(
      { version: 1, defaultTemplateId: 'nonexistent', templates: [] },
      'bak',
    );
    const mgr = new TemplatesManager(store);
    const src = await mgr.initialize();
    expect(src).toBe('bak');
    // defaultId 应该回退到 shell
    expect(mgr.getDefaultTemplateId()).toBe('shell');
    // 4 个内置补齐
    expect(mgr.list()).toHaveLength(BUILTIN_TEMPLATES.length);
  });
});

describe('TemplatesManager — resolve', () => {
  it('已知 id → 返回该模板', async () => {
    const mgr = new TemplatesManager(makeMockStore());
    await mgr.initialize();
    const t = mgr.resolve('claude-code');
    expect(t.id).toBe('claude-code');
    expect(t.command).toBe('claude');
  });

  it('未知 id → 兜底到默认 (shell)', async () => {
    const mgr = new TemplatesManager(makeMockStore());
    await mgr.initialize();
    expect(mgr.resolve('nope').id).toBe('shell');
    expect(mgr.resolve(undefined).id).toBe('shell');
    expect(mgr.resolve(null).id).toBe('shell');
  });
});

describe('TemplatesManager — setDefault', () => {
  it('已知 id → 更新默认 + emit + persist', async () => {
    const mgr = new TemplatesManager(makeMockStore());
    await mgr.initialize();
    const listener = vi.fn();
    mgr.on('templatesUpdated', listener);
    mgr.setDefault('claude-code');
    expect(mgr.getDefaultTemplateId()).toBe('claude-code');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('未知 id → throw TemplateNotFound', async () => {
    const mgr = new TemplatesManager(makeMockStore());
    await mgr.initialize();
    expect(() => mgr.setDefault('nope')).toThrowError(TemplatesManagerError);
    expect(() => mgr.setDefault('nope')).toThrowError(/TemplateNotFound/);
  });

  it('设为相同 id → 不 emit', async () => {
    const mgr = new TemplatesManager(makeMockStore());
    await mgr.initialize();
    const listener = vi.fn();
    mgr.on('templatesUpdated', listener);
    mgr.setDefault('shell'); // 已经是 shell
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('TemplatesManager — list / get', () => {
  it('list 返回深拷贝,修改不影响内部', async () => {
    const mgr = new TemplatesManager(makeMockStore());
    await mgr.initialize();
    const list = mgr.list();
    list[0]!.name = 'mutated';
    expect(mgr.list()[0]!.name).not.toBe('mutated');
  });

  it('get 不存在的 id → null', async () => {
    const mgr = new TemplatesManager(makeMockStore());
    await mgr.initialize();
    expect(mgr.get('nope')).toBeNull();
  });
});

describe('TemplatesManager — add / update / delete (CP-4)', () => {
  function baseInput() {
    return {
      name: 'My Custom',
      icon: '🔧',
      command: 'echo',
      args: ['hello'],
      env: { FOO: 'bar' },
      shellFirst: true,
      postExitAction: 'keep_shell' as const,
    };
  }

  it('add 新建自定义模板,自动分配 UUID,isBuiltin=false', async () => {
    const mgr = new TemplatesManager(makeMockStore());
    await mgr.initialize();
    const t = mgr.add(baseInput());
    expect(t.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(t.isBuiltin).toBe(false);
    expect(t.name).toBe('My Custom');
    expect(mgr.list().some((x) => x.id === t.id)).toBe(true);
  });

  it('add emit templatesUpdated', async () => {
    const mgr = new TemplatesManager(makeMockStore());
    await mgr.initialize();
    const listener = vi.fn();
    mgr.on('templatesUpdated', listener);
    mgr.add(baseInput());
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('add 同 id 重复 → InvalidTemplate', async () => {
    const mgr = new TemplatesManager(makeMockStore());
    await mgr.initialize();
    mgr.add({ ...baseInput(), id: 'fixed-id' } as never);
    expect(() =>
      mgr.add({ ...baseInput(), id: 'fixed-id' } as never),
    ).toThrowError(/InvalidTemplate.*已存在/);
  });

  it('add 校验 name 非空', async () => {
    const mgr = new TemplatesManager(makeMockStore());
    await mgr.initialize();
    expect(() => mgr.add({ ...baseInput(), name: '' })).toThrowError(
      /InvalidTemplate.*name/,
    );
  });

  it('add 校验 postExitAction 枚举', async () => {
    const mgr = new TemplatesManager(makeMockStore());
    await mgr.initialize();
    expect(() =>
      mgr.add({ ...baseInput(), postExitAction: 'invalid' as never }),
    ).toThrowError(/InvalidTemplate.*postExitAction/);
  });

  it('update 修改 name + 强制保留 isBuiltin', async () => {
    const mgr = new TemplatesManager(makeMockStore());
    await mgr.initialize();
    const updated = mgr.update('shell', { name: 'Renamed' });
    expect(updated.name).toBe('Renamed');
    expect(updated.isBuiltin).toBe(true); // shell 是内置,不可降级
  });

  it('update 不存在 id → TemplateNotFound', async () => {
    const mgr = new TemplatesManager(makeMockStore());
    await mgr.initialize();
    expect(() => mgr.update('nope', { name: 'x' })).toThrowError(
      /TemplateNotFound/,
    );
  });

  it('update 校验合并后字段', async () => {
    const mgr = new TemplatesManager(makeMockStore());
    await mgr.initialize();
    expect(() => mgr.update('shell', { name: '' })).toThrowError(
      /InvalidTemplate/,
    );
  });

  it('delete 自定义模板', async () => {
    const mgr = new TemplatesManager(makeMockStore());
    await mgr.initialize();
    const t = mgr.add(baseInput());
    mgr.delete(t.id);
    expect(mgr.list().some((x) => x.id === t.id)).toBe(false);
  });

  it('delete 内置模板 → CannotDeleteBuiltin', async () => {
    const mgr = new TemplatesManager(makeMockStore());
    await mgr.initialize();
    expect(() => mgr.delete('shell')).toThrowError(/CannotDeleteBuiltin/);
  });

  it('delete 当前默认模板 → 自动回退到 shell', async () => {
    const mgr = new TemplatesManager(makeMockStore());
    await mgr.initialize();
    const t = mgr.add(baseInput());
    mgr.setDefault(t.id);
    expect(mgr.getDefaultTemplateId()).toBe(t.id);
    mgr.delete(t.id);
    expect(mgr.getDefaultTemplateId()).toBe('shell');
  });

  it('delete 不存在 id → TemplateNotFound', async () => {
    const mgr = new TemplatesManager(makeMockStore());
    await mgr.initialize();
    expect(() => mgr.delete('nope')).toThrowError(/TemplateNotFound/);
  });

  describe('显示和隐藏', () => {
    async function ready(): Promise<TemplatesManager> {
      const manager = new TemplatesManager(makeMockStore());
      await manager.initialize();
      return manager;
    }

    it('内置模板可以隐藏,也可以再显示', async () => {
      const manager = await ready();
      expect(manager.update('aider', { hidden: true }).hidden).toBe(true);
      expect(manager.update('aider', { hidden: false }).hidden).toBe(false);
    });

    it('隐藏后仍然在列表里,不是删除', async () => {
      const manager = await ready();
      manager.update('codex', { hidden: true });
      expect(manager.get('codex')?.command).toBe('codex');
    });

    it('默认模板不能隐藏', async () => {
      const manager = await ready();
      expect(() => manager.update('shell', { hidden: true })).toThrow(/默认模板/);
    });

    it('把隐藏的模板设为默认时自动显示', async () => {
      const manager = await ready();
      manager.update('aider', { hidden: true });
      manager.setDefault('aider');
      expect(manager.get('aider')?.hidden).toBe(false);
    });

    it('编辑其他字段不会改变隐藏状态', async () => {
      const manager = await ready();
      manager.update('aider', { hidden: true });
      expect(manager.update('aider', { name: 'My Aider' }).hidden).toBe(true);
    });
  });

  it('新增的内置模板用的是各工具当前的命令', () => {
    const commands = Object.fromEntries(BUILTIN_TEMPLATES.map((b) => [b.id, b.command]));
    expect(commands).toMatchObject({
      'gemini-cli': 'gemini',
      'github-copilot': 'copilot',
      cursor: 'agent',
      aider: 'aider',
    });
  });
});
