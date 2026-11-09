/**
 * @file src/shared/pili-themes.test.ts
 * @purpose 核对 Pili 主题系列(ADR-031):生成文件与现算结果一致、色板算法符合 PiliPlus 的
 *   material3Legacy 规则、界面和终端配色守 Legado MD3 系列同样的对比度下限。
 *
 * @关键设计:
 * - token 读自 pili-themes.css 文本,不启动浏览器;色板由 pili-scheme.ts 现算后与 pili-themes.ts
 *   里存的比对,再由 legado-palette.ts 算 token 与 CSS 比对,三者必须一致,改了算法忘了重新生成
 *   就会在这里失败。
 * - 算法检查用 HCT 反推:主色的色相要等于种子色相、色调等于 40 / 80,浅色页面色调 99、深色 10,
 *   深色标签页等于色调 10 叠 5% onSurfaceVariant。这些是 PiliPlus 默认算法的可见特征。
 * - 对比度规则与 legado-themes.test.ts 相同,每条规则一个测试,失败时列出全部不达标的组合。
 *
 * @不在 src/renderer 写的原因:vitest 不收集 renderer。
 *
 * @对应文档章节:软件定义书.md 5.1.9 节、ADR-031
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { argbFromHex, Hct } from '@material/material-color-utilities';
import { describe, expect, it } from 'vitest';
import { PILI_THEMES, PILI_THEME_IDS } from './pili-themes';
import { PILI_DARK_CARD_TINT, PILI_SEEDS, generatePiliScheme } from './pili-scheme';
import { contrast, legadoLook, mix, type LegadoScheme } from './legado-palette';
import type { TerminalPalette } from './beamer-themes';

const RENDERER = resolve(__dirname, '../renderer');
const CSS = readFileSync(resolve(RENDERER, 'styles/pili-themes.css'), 'utf8');
const AA = 4.5;
/** MD3 hover 状态层:当前文字色 8% 叠在背景上 (material.css --md-state-hover) */
const HOVER_LAYER = 8;

function blockFor(id: string): string {
  const start = CSS.indexOf(`[data-theme='${id}'] {`);
  return start < 0 ? '' : CSS.slice(start, CSS.indexOf('}', start));
}

function tokensOf(id: string): Record<string, string> {
  const tokens: Record<string, string> = {};
  for (const [, name, value] of blockFor(id).matchAll(/(--[\w-]+):\s*([^;]+);/g)) {
    tokens[name!] = value!.trim();
  }
  return tokens;
}

function hct(hex: string): Hct {
  return Hct.fromInt(argbFromHex(hex));
}

/** 色相差,考虑 360° 回绕 */
function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return Math.min(d, 360 - d);
}

function collectUnreadable(
  visit: (check: (label: string, fg: string, bg: string) => void) => void,
): string[] {
  const failures: string[] = [];
  visit((label, fg, bg) => {
    const ratio = contrast(fg, bg);
    if (ratio < AA) failures.push(`${label}: ${fg} on ${bg} is ${ratio.toFixed(2)}`);
  });
  return failures;
}

const THEMES = PILI_THEMES.map((theme) => {
  const t = tokensOf(theme.id);
  const onSurface = t['--color-text-primary']!;
  const weight = (name: string): number => parseInt(t[name] ?? '100%', 10);
  return {
    ...theme,
    t,
    surfaces: [t['--color-bg-primary']!, t['--color-bg-secondary']!],
    menu: t['--md-surface-container-high']!,
    primaryText: mix(t['--md-primary']!, onSurface, weight('--md-primary-text-weight')),
    errorText: mix(t['--color-danger']!, onSurface, weight('--md-error-text-weight')),
  };
});

describe('pili themes', () => {
  it('lists every seed in light and dark once, in PiliPlus order', () => {
    expect(PILI_THEMES.map((t) => t.id)).toEqual([...PILI_THEME_IDS]);
    expect(new Set(PILI_THEME_IDS).size).toBe(PILI_THEME_IDS.length);
    expect(PILI_THEME_IDS.length).toBe(PILI_SEEDS.length * 2);
    expect(PILI_SEEDS.length).toBe(19);
    const expected = PILI_SEEDS.flatMap((s) => [`pili-${s.key}`, `pili-${s.key}-dark`]);
    expect([...PILI_THEME_IDS]).toEqual(expected);
    const seeds = PILI_THEMES.map((t) => [t.id, t.seed, t.note, t.dark]);
    const fromList = PILI_SEEDS.flatMap((s) => [
      [`pili-${s.key}`, s.seed, s.note, false],
      [`pili-${s.key}-dark`, s.seed, s.note, true],
    ]);
    expect(seeds).toEqual(fromList);
    expect(
      PILI_THEMES.filter((t) => t.dark !== t.label.endsWith(' Dark')).map((t) => t.id),
    ).toEqual([]);
  });

  it('matches the generator: scheme from pili-scheme.ts, tokens and terminal from legado-palette.ts', () => {
    expect(PILI_THEME_IDS.filter((id) => blockFor(id) === '')).toEqual([]);
    const schemeDrift = PILI_THEMES.filter(
      (th) => JSON.stringify(generatePiliScheme(th.seed, th.dark)) !== JSON.stringify(th.scheme),
    ).map((th) => th.id);
    expect(schemeDrift).toEqual([]);
    const lookDrift = THEMES.filter(({ scheme, dark, t, terminal }) => {
      const look = legadoLook(scheme, dark);
      return (
        JSON.stringify(look.tokens) !== JSON.stringify(t) ||
        JSON.stringify(look.terminal) !== JSON.stringify(terminal)
      );
    }).map((c) => c.id);
    expect(lookDrift).toEqual([]);
    const notHex = THEMES.flatMap(({ id, t }) =>
      Object.entries(t)
        .filter(([name, value]) => !name.endsWith('-weight') && !/^#[0-9a-f]{6}$/.test(value))
        .map(([name, value]) => `${id} ${name}=${value}`),
    );
    expect(notHex).toEqual([]);
    for (const { id, dark } of PILI_THEMES) {
      expect(/color-scheme:\s*light/.test(blockFor(id))).toBe(!dark);
    }
    const entry = readFileSync(resolve(RENDERER, 'index.tsx'), 'utf8');
    const material = entry.indexOf("import './styles/material.css'");
    expect(material).toBeGreaterThanOrEqual(0);
    expect(entry.indexOf("import './styles/pili-themes.css'")).toBeGreaterThan(material);
  });

  it('follows the PiliPlus material3Legacy rules: seed hue, tone 40 / 80 primary, page tone 99 / 10', () => {
    const wrong: string[] = [];
    for (const { id, seed, dark, scheme } of PILI_THEMES) {
      const seedHue = hct(seed).hue;
      const primary = hct(scheme.primary);
      if (hueDistance(primary.hue, seedHue) > 2) wrong.push(`${id} primary hue ${primary.hue}`);
      if (Math.abs(primary.tone - (dark ? 80 : 40)) > 1)
        wrong.push(`${id} primary tone ${primary.tone}`);
      // 请求的色度是 48;HCT 把色域外的颜色压回 sRGB,有些色相在色调 40 / 80 上只剩 30 左右,
      // 与 Flutter 一致。这里只排除退成灰色的情况,精确值由上面的生成结果比对保证
      if (primary.chroma < 25) wrong.push(`${id} primary chroma ${primary.chroma}`);
      const surface = hct(scheme.surface);
      if (Math.abs(surface.tone - (dark ? 10 : 99)) > 1)
        wrong.push(`${id} surface tone ${surface.tone}`);
      if (scheme.background !== scheme.surface) wrong.push(`${id} background`);
      const tertiary = hct(scheme.tertiary);
      if (hueDistance(tertiary.hue, seedHue + 60) > 3)
        wrong.push(`${id} tertiary hue ${tertiary.hue}`);
      const error = hct(scheme.error);
      if (hueDistance(error.hue, 25) > 3) wrong.push(`${id} error hue ${error.hue}`);
      if (!dark && scheme.onPrimary !== '#ffffff')
        wrong.push(`${id} onPrimary ${scheme.onPrimary}`);
      if (dark) {
        // 深色标签页 = PiliPlus 深色卡片:色调 10 叠 5% onSurfaceVariant
        const expected = mix(scheme.onSurfaceVariant, scheme.surface, PILI_DARK_CARD_TINT);
        if (scheme.surfaceContainerLow !== expected) {
          wrong.push(`${id} dark card ${scheme.surfaceContainerLow} expected ${expected}`);
        }
        if (contrast(scheme.surfaceContainerLow, scheme.surface) < 1.05)
          wrong.push(`${id} flat dark`);
      } else {
        const low = hct(scheme.surfaceContainerLow);
        if (Math.abs(low.tone - 96) > 1) wrong.push(`${id} card tone ${low.tone}`);
      }
    }
    expect(wrong).toEqual([]);
    // 灰色种子的主色也带色相(PiliPlus 的 material3Legacy 不认灰色),不是灰的
    const grey = PILI_THEMES.find((t) => t.id === 'pili-grey')!;
    expect(hct(grey.scheme.primary).chroma).toBeGreaterThan(30);
  });

  it('colours each surface and text role the way the Legado MD3 series does', () => {
    const roles: Array<[string, keyof LegadoScheme]> = [
      ['--color-bg-primary', 'surfaceContainerLow'],
      ['--color-bg-secondary', 'surface'],
      ['--md-surface-container-high', 'surfaceContainer'],
      ['--md-surface-container-highest', 'surfaceContainerHighest'],
      ['--color-bg-hover', 'surfaceContainerHigh'],
      ['--color-text-primary', 'onSurface'],
      ['--color-text-secondary', 'onSurfaceVariant'],
      ['--color-danger', 'error'],
      ['--md-primary', 'primary'],
      ['--md-on-primary', 'onPrimary'],
      ['--md-secondary-container', 'secondaryContainer'],
      ['--md-on-secondary-container', 'onSecondaryContainer'],
      ['--md-outline', 'outline'],
      ['--md-outline-variant', 'outlineVariant'],
    ];
    const wrong: string[] = [];
    for (const { id, scheme, t, terminal } of THEMES) {
      for (const [token, role] of roles) {
        if (t[token] !== scheme[role]) {
          wrong.push(`${id} ${token}=${t[token]} expected ${role}=${scheme[role]}`);
        }
      }
      if (terminal.background !== t['--color-bg-primary']) wrong.push(`${id} term bg`);
      if (terminal.foreground !== t['--color-text-primary']) wrong.push(`${id} term fg`);
    }
    expect(wrong).toEqual([]);
  });

  it('keeps text and status colours readable on the page, frame and menus', () => {
    const names = [
      '--color-text-primary',
      '--color-text-secondary',
      '--color-text-muted',
      '--color-danger',
      '--color-warning',
      '--color-success',
      '--color-info',
    ];
    const failures = collectUnreadable((check) => {
      for (const { id, t, surfaces, menu } of THEMES) {
        for (const name of names) {
          for (const bg of [...surfaces, menu]) check(`${id} ${name}`, t[name]!, bg);
        }
      }
    });
    expect(failures).toEqual([]);
  });

  it('keeps labels readable on hover, selected and filled backgrounds', () => {
    const failures = collectUnreadable((check) => {
      for (const { id, t, surfaces, menu, primaryText, errorText } of THEMES) {
        const onSurface = t['--color-text-primary']!;
        const selected = t['--md-secondary-container']!;
        for (const bg of [t['--color-bg-hover']!, t['--color-bg-active']!, selected]) {
          check(`${id} text`, onSurface, bg);
        }
        check(`${id} on-selected`, t['--md-on-secondary-container']!, selected);
        const accent = t['--md-primary']!;
        const onPrimary = t['--md-on-primary']!;
        check(`${id} on-primary`, onPrimary, accent);
        check(`${id} on-primary hover`, onPrimary, mix(onPrimary, accent, HOVER_LAYER));
        check(`${id} on-error`, t['--md-on-error']!, t['--color-danger']!);
        for (const bg of [...surfaces, menu, t['--color-bg-hover']!]) {
          check(`${id} primary text`, primaryText, bg);
          check(`${id} error text`, errorText, bg);
          check(`${id} primary hover`, primaryText, mix(primaryText, bg, HOVER_LAYER));
          check(`${id} error hover`, errorText, mix(errorText, bg, HOVER_LAYER));
        }
      }
    });
    expect(failures).toEqual([]);
  });

  it('keeps terminal colours readable, also on a selection', () => {
    const notText = ['background', 'cursor', 'cursorAccent', 'selectionBackground'];
    const failures = collectUnreadable((check) => {
      for (const { id, dark, terminal } of THEMES) {
        for (const role of Object.keys(terminal) as Array<keyof TerminalPalette>) {
          // 深色主题的 black 贴近底色,用作背景块而不是文字
          if (notText.includes(role) || (role === 'black' && dark)) continue;
          check(`${id} ${role}`, terminal[role], terminal.background);
        }
        check(`${id} selection`, terminal.foreground, terminal.selectionBackground);
      }
    });
    expect(failures).toEqual([]);
  });
});
