/**
 * @file src/main/settings-manager.test.ts
 * @purpose SettingsManager 单元测试。覆盖 deep-merge、validate、changedKeys
 *   diff、初始化容错。
 *
 * @对应文档章节: AGENTS.md 5.3 (SettingsManager 必测;读/写/合并/默认值/版本迁移);
 *   软件定义书.md 6.6、11.1
 */
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SETTINGS,
  SettingsError,
  SettingsManager,
  deepMerge,
  diffKeys,
  validateSettings,
  stripUnknownLegacyFields,
} from './settings-manager';
import { BEAMER_THEME_IDS } from '@shared/beamer-themes';
import { LEGADO_THEME_IDS } from '@shared/legado-themes';
import type { Settings } from '@shared/types';
import type { JsonStore } from './persistence';

class FakeJsonStore<T> {
  private current: T | null = null;
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
  async flush(): Promise<void> {}
  destroy(): void {}
}

function makeManager(initial?: Partial<Settings>): {
  mgr: SettingsManager;
  store: FakeJsonStore<Settings>;
} {
  const store = new FakeJsonStore<Settings>();
  if (initial) store.setInitial(initial as Settings);
  const mgr = new SettingsManager(store as unknown as JsonStore<Settings>);
  return { mgr, store };
}

describe('deepMerge', () => {
  it('扁平对象浅替换', () => {
    expect(deepMerge({ a: 1, b: 2 }, { a: 99 })).toEqual({ a: 99, b: 2 });
  });

  it('嵌套对象递归合并', () => {
    expect(deepMerge({ x: { p: 1, q: 2 }, y: 'untouched' }, { x: { p: 99 } })).toEqual({
      x: { p: 99, q: 2 },
      y: 'untouched',
    });
  });

  it('数组整体替换不合并', () => {
    expect(deepMerge({ list: [1, 2, 3] }, { list: [9] })).toEqual({ list: [9] });
  });

  it('partial 中 undefined 不覆盖原值', () => {
    expect(deepMerge({ a: 1 }, { a: undefined } as never)).toEqual({ a: 1 });
  });

  it('partial 整体为 undefined 时返回原 target', () => {
    expect(deepMerge({ a: 1 }, undefined)).toEqual({ a: 1 });
  });

  it('null 在 partial 中视为合法新值 (覆盖)', () => {
    expect(deepMerge({ a: { p: 1 } }, { a: null as never })).toEqual({ a: null });
  });

  it('不修改原对象 (immutability)', () => {
    const orig = { x: { p: 1 } };
    deepMerge(orig, { x: { p: 99 } });
    expect(orig.x.p).toBe(1);
  });
});

describe('diffKeys', () => {
  it('完全相同 → 空数组', () => {
    expect(diffKeys('', { a: 1, b: 2 }, { a: 1, b: 2 })).toEqual([]);
  });

  it('叶子值不同 → 一个 dotted path', () => {
    expect(diffKeys('', { a: 1 }, { a: 2 })).toEqual(['a']);
  });

  it('嵌套字段差异', () => {
    const result = diffKeys('', { a: { p: 1, q: 2 } }, { a: { p: 99, q: 2 } });
    expect(result).toEqual(['a.p']);
  });

  it('多层 + 多个 diff', () => {
    const result = diffKeys('', { a: { p: 1 }, b: 2, c: 3 }, { a: { p: 99 }, b: 2, c: 999 });
    expect(result.sort()).toEqual(['a.p', 'c'].sort());
  });

  it('数组差异 (整体一项)', () => {
    expect(diffKeys('', { list: [1, 2] }, { list: [1, 2, 3] })).toEqual(['list']);
  });
});

describe('validateSettings', () => {
  it('默认设置自身合法', () => {
    expect(() => validateSettings(DEFAULT_SETTINGS)).not.toThrow();
  });

  it('remoteSetupGuideSeen 必须是布尔值', () => {
    const bad = structuredClone(DEFAULT_SETTINGS);
    (bad.behavior as { remoteSetupGuideSeen: unknown }).remoteSetupGuideSeen = 'yes';
    expect(() => validateSettings(bad)).toThrowError(/remoteSetupGuideSeen/);
    (bad.behavior as { remoteSetupGuideSeen: unknown }).remoteSetupGuideSeen = true;
    expect(() => validateSettings(bad)).not.toThrow();
  });

  it('非法 theme throw InvalidSettings', () => {
    const bad = structuredClone(DEFAULT_SETTINGS);
    (bad.appearance as { theme: string }).theme = 'nonexistent';
    expect(() => validateSettings(bad)).toThrowError(/InvalidSettings/);
    // 用户主题只看 id 格式,文件是否存在由 renderer 回退处理
    (bad.appearance as { theme: string }).theme = 'custom:Bad Name';
    expect(() => validateSettings(bad)).toThrowError(/InvalidSettings/);
    (bad.appearance as { theme: string }).theme = 'custom:my-theme';
    expect(() => validateSettings(bad)).not.toThrow();
  });

  it('quickLaunch 默认是 Claude Code 和 Codex', () => {
    expect(DEFAULT_SETTINGS.behavior.quickLaunch).toEqual([
      { kind: 'template', id: 'claude-code' },
      { kind: 'template', id: 'codex' },
    ]);
  });

  it('非法 quickLaunch throw', () => {
    const bad = structuredClone(DEFAULT_SETTINGS);
    (bad.behavior as { quickLaunch: unknown }).quickLaunch = [{ kind: 'command', id: 'x' }];
    expect(() => validateSettings(bad)).toThrowError(/behavior\.quickLaunch/);
  });

  it('字号越界 throw', () => {
    const bad = structuredClone(DEFAULT_SETTINGS);
    bad.appearance.terminalFontSize = 5;
    expect(() => validateSettings(bad)).toThrowError(/terminalFontSize=5 越界/);
    bad.appearance.terminalFontSize = 100;
    expect(() => validateSettings(bad)).toThrowError(/越界/);
  });

  it('行高越界 throw', () => {
    const bad = structuredClone(DEFAULT_SETTINGS);
    bad.appearance.terminalLineHeight = 0.5;
    expect(() => validateSettings(bad)).toThrowError(/terminalLineHeight=0.5/);
  });

  it('uiZoom 越界 throw', () => {
    const bad = structuredClone(DEFAULT_SETTINGS);
    bad.appearance.uiZoom = 2.0;
    expect(() => validateSettings(bad)).toThrowError(/uiZoom=2/);
  });

  it('logLevel 非法 throw', () => {
    const bad = structuredClone(DEFAULT_SETTINGS);
    (bad.advanced as { logLevel: string }).logLevel = 'TRACE';
    expect(() => validateSettings(bad)).toThrowError(/logLevel/);
  });

  it('terminalRightClick 非法 throw', () => {
    const bad = structuredClone(DEFAULT_SETTINGS);
    (bad.behavior as { terminalRightClick: string }).terminalRightClick = 'pop';
    expect(() => validateSettings(bad)).toThrowError(/terminalRightClick/);
  });

  it('behavior.shelveIdleAfterHours 默认 0(关),越界 throw', () => {
    expect(DEFAULT_SETTINGS.behavior.shelveIdleAfterHours).toBe(0);
    const bad = structuredClone(DEFAULT_SETTINGS);
    bad.behavior.shelveIdleAfterHours = -1;
    expect(() => validateSettings(bad)).toThrowError(/shelveIdleAfterHours/);
    bad.behavior.shelveIdleAfterHours = 24 * 31;
    expect(() => validateSettings(bad)).toThrowError(/shelveIdleAfterHours/);
    bad.behavior.shelveIdleAfterHours = 120;
    expect(() => validateSettings(bad)).not.toThrow();
  });

  it('systemIntegration.explorerOpenIn 默认 new-window', () => {
    expect(DEFAULT_SETTINGS.systemIntegration.explorerOpenIn).toBe('new-window');
  });

  it('systemIntegration.explorerOpenIn 非法 throw', () => {
    const bad = structuredClone(DEFAULT_SETTINGS);
    (bad.systemIntegration as { explorerOpenIn: string }).explorerOpenIn = 'detached';
    expect(() => validateSettings(bad)).toThrowError(/explorerOpenIn/);
  });
});

describe('SettingsManager — initialize', () => {
  it('空 store → DEFAULT_SETTINGS', async () => {
    const { mgr } = makeManager();
    const source = await mgr.initialize();
    expect(source).toBe('default');
    expect(mgr.get()).toEqual(DEFAULT_SETTINGS);
  });

  it('部分字段缺失的旧文件 → 自动用默认值填充 (deep merge)', async () => {
    const { mgr } = makeManager({
      version: 1,
      appearance: {
        theme: 'cutie',
        // 其它 appearance 字段缺失
      },
      // 整个 shell / behavior / systemIntegration / advanced 块缺失
    } as unknown as Settings);
    await mgr.initialize();
    const settings = mgr.get();
    expect(settings.appearance.theme).toBe('cutie');
    expect(settings.appearance.terminalFontSize).toBe(13); // 来自默认
    expect(settings.behavior.confirmOnQuit).toBe(true); // 来自默认
    // 老用户升级后也看一次 "右键 + 号" 首次引导
    expect(settings.behavior.quickLaunchTipSeen).toBe(false);
    // 远程设置引导 (ADR-032) 同样补 false,升级后没配远端的用户会被问一次
    expect(settings.behavior.remoteSetupGuideSeen).toBe(false);
    expect(settings.advanced.logLevel).toBe('INFO');
  });

  it('未来版本 throw IncompatibleVersion', async () => {
    const { mgr } = makeManager({ version: 999, appearance: {} } as unknown as Settings);
    await expect(mgr.initialize()).rejects.toThrow(/IncompatibleVersion/);
  });

  it('get 返回深拷贝,修改不影响内部', async () => {
    const { mgr } = makeManager();
    await mgr.initialize();
    const s = mgr.get();
    s.appearance.theme = 'business';
    expect(mgr.get().appearance.theme).toBe('light-pink'); // 内部仍是默认
  });
});

describe('SettingsManager — update', () => {
  it('合法 partial 更新触发 settingsChanged 事件', async () => {
    const { mgr, store } = makeManager();
    await mgr.initialize();
    const listener = vi.fn();
    mgr.on('settingsChanged', listener);

    mgr.update({ appearance: { theme: 'rose-pine-dawn' } });

    expect(mgr.get().appearance.theme).toBe('rose-pine-dawn');
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0]![0]).toMatchObject({
      changedKeys: ['appearance.theme'],
    });
    expect(store.setHistory).toHaveLength(1);
  });

  it('完全相同的 partial 不广播也不写盘', async () => {
    const { mgr, store } = makeManager();
    await mgr.initialize();
    const listener = vi.fn();
    mgr.on('settingsChanged', listener);

    mgr.update({ appearance: { theme: 'light-pink' } }); // 与默认相同
    expect(listener).not.toHaveBeenCalled();
    expect(store.setHistory).toHaveLength(0);
  });

  it('非法值不更新 throw InvalidSettings', async () => {
    const { mgr, store } = makeManager();
    await mgr.initialize();

    expect(() => mgr.update({ appearance: { theme: 'nonexistent' as never } })).toThrowError(
      /InvalidSettings/,
    );
    // 仍是原值
    expect(mgr.get().appearance.theme).toBe('light-pink');
    // 没写盘
    expect(store.setHistory).toHaveLength(0);
  });

  it('Legado 实时主题的种子色、风格、对比度只收合法值 (ADR-030)', async () => {
    const { mgr } = makeManager();
    await mgr.initialize();
    const bad = [
      { legadoSeedColor: 'blue' },
      { legadoSeedColor: '#12345' },
      { legadoPaletteStyle: 'pastel' as never },
      { legadoContrast: 'max' as never },
    ];
    const accepted = bad.filter((patch) => {
      try {
        mgr.update({ appearance: patch });
        return true;
      } catch {
        return false;
      }
    });
    expect(accepted).toEqual([]);
    mgr.update({ appearance: { legadoSeedColor: '#AbCdEf', legadoContrast: 'high' } });
    expect(mgr.get().appearance.legadoContrast).toBe('high');
  });

  it.each([
    'ceteris-dark',
    'ceteris-light',
    'rose-pine',
    'rose-pine-dawn',
    'rose-pine-moon',
    'cutie',
    'business',
    'ubuntu',
    'windows-terminal',
    ...BEAMER_THEME_IDS,
    // 一个就够证明 Legado 系列登记进了 VALID_THEMES
    LEGADO_THEME_IDS[0],
  ] as const)('合法主题 %s 通过校验', async (theme) => {
    const { mgr } = makeManager();
    await mgr.initialize();
    expect(() => mgr.update({ appearance: { theme } })).not.toThrow();
    expect(mgr.get().appearance.theme).toBe(theme);
  });

  it('多个字段同时更新 → changedKeys 都列', async () => {
    const { mgr } = makeManager();
    await mgr.initialize();
    const listener = vi.fn();
    mgr.on('settingsChanged', listener);

    mgr.update({
      appearance: { theme: 'business', terminalFontSize: 16 },
      behavior: { confirmOnQuit: false },
    });

    const payload = listener.mock.calls[0]![0] as { changedKeys: string[] };
    expect(payload.changedKeys.sort()).toEqual(
      ['appearance.theme', 'appearance.terminalFontSize', 'behavior.confirmOnQuit'].sort(),
    );
  });

  it('partial 不是对象 throw InvalidSettings', async () => {
    const { mgr } = makeManager();
    await mgr.initialize();
    expect(() => mgr.update(null as never)).toThrowError(/InvalidSettings/);
    expect(() => mgr.update('hello' as never)).toThrowError(/InvalidSettings/);
    expect(() => mgr.update([] as never)).toThrowError(/InvalidSettings/);
  });
});

describe('SettingsManager — reset', () => {
  it('恢复默认值并广播', async () => {
    const { mgr } = makeManager();
    await mgr.initialize();
    mgr.update({ appearance: { theme: 'cutie' } });
    const listener = vi.fn();
    mgr.on('settingsChanged', listener);
    mgr.reset();
    expect(mgr.get()).toEqual(DEFAULT_SETTINGS);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('reset 已是默认时不广播', async () => {
    const { mgr } = makeManager();
    await mgr.initialize();
    const listener = vi.fn();
    mgr.on('settingsChanged', listener);
    mgr.reset();
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('SettingsError', () => {
  it('暴露 code + details', () => {
    const err = new SettingsError('InvalidSettings', 'foo', { field: 'theme' });
    expect(err.code).toBe('InvalidSettings');
    expect(err.details).toEqual({ field: 'theme' });
  });
});

describe('stripUnknownLegacyFields: advanced.enableRemote', () => {
  it('丢弃老文件里的开关,保留其它高级设置', () => {
    const raw = { advanced: { enableRemote: false, logLevel: 'DEBUG' } };
    expect(stripUnknownLegacyFields(raw)).toEqual({ advanced: { logLevel: 'DEBUG' } });
    expect(raw.advanced.enableRemote).toBe(false);
  });
});

describe('next prompt key moved out of settings.json (ADR-025)', () => {
  it('hands an old plain text key over once and leaves no copy in settings.json or .bak', async () => {
    const { mkdtemp, readFile, rm, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { JsonStore: RealStore } = await import('./persistence');
    const dir = await mkdtemp(join(tmpdir(), 'ceteris-test-'));
    try {
      const file = join(dir, 'settings.json');
      const old = structuredClone(DEFAULT_SETTINGS) as unknown as {
        ai: { nextPrompt: Record<string, unknown> };
      };
      old.ai.nextPrompt['apiKey'] = 'sk-or-plain';
      delete old.ai.nextPrompt['keySaved'];
      await writeFile(file, JSON.stringify(old));

      const mgr = new SettingsManager(new RealStore<Settings>(file, 0));
      await mgr.initialize();
      expect(mgr.takeLegacyNextPromptKey()).toBe('sk-or-plain');
      expect(mgr.takeLegacyNextPromptKey()).toBe('');
      expect(mgr.get().ai.nextPrompt).not.toHaveProperty('apiKey');

      mgr.update({ ai: { nextPrompt: { keySaved: true } } });
      await mgr.rewriteBothCopies();
      expect(await readFile(file, 'utf8')).not.toContain('sk-or-plain');
      expect(await readFile(`${file}.bak`, 'utf8')).not.toContain('sk-or-plain');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
