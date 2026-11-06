/**
 * @file src/shared/link-theme.test.ts
 * @purpose 覆盖 Link 远程窗口的主题规则:本机主题覆盖 Host 设置,且不影响其余字段。
 */
import { describe, expect, it } from 'vitest';
import { applyLocalThemeToResult, splitThemeUpdate, withLocalTheme } from './link-theme';
import { COMMAND_CHANNELS } from './protocol';
import type { Settings } from './types';

const hostSettings = {
  version: 1,
  appearance: { theme: 'dracula', terminalFontSize: 18 },
  behavior: { confirmOnQuit: false },
} as unknown as Settings;

describe('withLocalTheme', () => {
  it('只替换主题,保留 Host 的其余外观设置,且不修改入参', () => {
    const result = withLocalTheme(hostSettings, 'ceteris-dark');

    expect(result.appearance.theme).toBe('ceteris-dark');
    expect(result.appearance.terminalFontSize).toBe(18);
    expect(result.behavior).toBe(hostSettings.behavior);
    expect(hostSettings.appearance.theme).toBe('dracula');
  });
});

describe('applyLocalThemeToResult', () => {
  it.each([COMMAND_CHANNELS.SETTINGS_GET, COMMAND_CHANNELS.APP_GET_SNAPSHOT])(
    '%s 的结果被覆盖',
    (channel) => {
      const result = applyLocalThemeToResult(
        channel,
        { settings: hostSettings, other: 1 },
        'ceteris-dark',
      ) as { settings: Settings; other: number };

      expect(result.settings.appearance.theme).toBe('ceteris-dark');
      expect(result.other).toBe(1);
    },
  );

  it('其它 channel 原样返回,哪怕结果里碰巧有 settings 字段', () => {
    const result = { settings: hostSettings };
    expect(applyLocalThemeToResult(COMMAND_CHANNELS.SESSION_CREATE, result, 'ceteris-dark')).toBe(
      result,
    );
  });

  it('容忍空结果', () => {
    expect(applyLocalThemeToResult(COMMAND_CHANNELS.SETTINGS_GET, null, 'ceteris-dark')).toBeNull();
  });
});

describe('splitThemeUpdate', () => {
  it('只改主题时不需要转发', () => {
    expect(splitThemeUpdate({ appearance: { theme: 'cutie' } })).toEqual({
      theme: 'cutie',
      rest: null,
    });
  });

  it('不含主题时整体转发', () => {
    const partial = { behavior: { confirmOnQuit: true } };
    expect(splitThemeUpdate(partial)).toEqual({ theme: undefined, rest: partial });
  });

  it('混合更新时拆开,其余字段留给 Host', () => {
    expect(
      splitThemeUpdate({
        appearance: { theme: 'cutie', terminalFontSize: 14 },
        behavior: { confirmOnQuit: true },
      }),
    ).toEqual({
      theme: 'cutie',
      rest: { appearance: { terminalFontSize: 14 }, behavior: { confirmOnQuit: true } },
    });
  });

  it('外观里只有主题时,转发部分不留空的 appearance', () => {
    expect(
      splitThemeUpdate({ appearance: { theme: 'cutie' }, behavior: { confirmOnQuit: true } }),
    ).toEqual({ theme: 'cutie', rest: { behavior: { confirmOnQuit: true } } });
  });

  it('不修改入参', () => {
    const partial = { appearance: { theme: 'cutie' as const, terminalFontSize: 14 } };
    splitThemeUpdate(partial);
    expect(partial.appearance.theme).toBe('cutie');
  });
});
