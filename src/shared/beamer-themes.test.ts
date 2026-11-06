/**
 * @file src/shared/beamer-themes.test.ts
 * @purpose 检查 Beamer 主题的界面配色和终端配色:token 完整、两边底色一致、
 *   文字达到 WCAG AA。这些主题的状态色是手工调的,目测看不出 4.3:1 和 4.5:1 的差别。
 *
 * @不在 src/renderer 写的原因:同 css-var-fallback.test.ts,vitest 不收集 renderer。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BEAMER_THEMES, BEAMER_THEME_IDS, type TerminalPalette } from './beamer-themes';

const CSS = readFileSync(resolve(__dirname, '../renderer/styles/beamer-themes.css'), 'utf8');
const AA = 4.5;

const REQUIRED_TOKENS = [
  '--color-bg-primary',
  '--color-bg-secondary',
  '--color-bg-elevated',
  '--color-bg-hover',
  '--color-bg-active',
  '--color-bg-strong',
  '--color-text-primary',
  '--color-text-secondary',
  '--color-text-muted',
  '--color-danger',
  '--color-warning',
  '--color-success',
  '--color-info',
  '--color-accent-secondary',
  '--color-accent-special',
];

function blockFor(id: string): string {
  const start = CSS.indexOf(`[data-theme='${id}'] {`);
  expect(start, `no CSS block for ${id}`).toBeGreaterThanOrEqual(0);
  return CSS.slice(start, CSS.indexOf('}', start));
}

function tokensOf(id: string): Record<string, string> {
  const tokens: Record<string, string> = {};
  for (const [, name, value] of blockFor(id).matchAll(/(--[\w-]+):\s*([^;]+);/g)) {
    tokens[name!] = value!.trim();
  }
  return tokens;
}

function rgb(hex: string): number[] {
  if (hex.length === 4) hex = `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`;
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
}

function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

/** 等同 CSS 的 color-mix(in srgb, a weight%, b) */
function mix(a: string, b: string, weight: number): string {
  const [ca, cb] = [rgb(a), rgb(b)];
  const channels = ca.map((v, i) => Math.round((v * weight + cb[i]! * (100 - weight)) / 100));
  return `#${channels.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

function textWeight(tokens: Record<string, string>, name: string): number {
  return parseInt(tokens[name] ?? '100%', 10);
}

describe('beamer themes', () => {
  it('lists every id exactly once', () => {
    expect(BEAMER_THEMES.map((t) => t.id)).toEqual([...BEAMER_THEME_IDS]);
  });

  describe.each(BEAMER_THEMES)('$id', (theme) => {
    const tokens = tokensOf(theme.id);
    const bgPrimary = tokens['--color-bg-primary']!;
    const bgSecondary = tokens['--color-bg-secondary']!;
    const surfaces = [bgPrimary, bgSecondary];

    it('defines every semantic token', () => {
      for (const name of REQUIRED_TOKENS) expect(tokens[name], name).toMatch(/^#[0-9a-f]{6}$/);
    });

    it('declares color-scheme only for light themes', () => {
      expect(tokens['color-scheme']).toBeUndefined();
      expect(/color-scheme:\s*light/.test(blockFor(theme.id))).toBe(theme.tone === '浅色');
    });

    it('matches its tone by background brightness', () => {
      expect(luminance(bgPrimary) > 0.5).toBe(theme.tone === '浅色');
    });

    it('uses the same base colors in the UI and the terminal', () => {
      expect(theme.terminal.background).toBe(bgPrimary);
      expect(theme.terminal.foreground).toBe(tokens['--color-text-primary']);
    });

    it.each(['--color-text-primary', '--color-text-secondary', '--color-text-muted'])(
      '%s is readable on primary and secondary surfaces',
      (name) => {
        for (const bg of surfaces) expect(contrast(tokens[name]!, bg)).toBeGreaterThanOrEqual(AA);
      },
    );

    it('keeps primary text readable on hover and selected rows', () => {
      const selected =
        tokens['--md-secondary-container'] ?? mix(tokens['--color-accent-special']!, bgSecondary, 24);
      const backgrounds = [
        tokens['--color-bg-elevated']!,
        tokens['--color-bg-hover']!,
        tokens['--color-bg-active']!,
        selected,
      ];
      for (const bg of backgrounds) {
        expect(contrast(tokens['--color-text-primary']!, bg), bg).toBeGreaterThanOrEqual(AA);
      }
    });

    it.each(['--color-warning', '--color-success', '--color-info'])(
      '%s is readable on primary and secondary surfaces',
      (name) => {
        for (const bg of surfaces) expect(contrast(tokens[name]!, bg)).toBeGreaterThanOrEqual(AA);
      },
    );

    it('keeps accent and error text readable after the weight mix', () => {
      const onSurface = tokens['--color-text-primary']!;
      const primaryText = mix(
        tokens['--color-accent-special']!,
        onSurface,
        textWeight(tokens, '--md-primary-text-weight'),
      );
      const errorText = mix(
        tokens['--color-danger']!,
        onSurface,
        textWeight(tokens, '--md-error-text-weight'),
      );
      for (const bg of surfaces) {
        expect(contrast(primaryText, bg), 'primary text').toBeGreaterThanOrEqual(AA);
        expect(contrast(errorText, bg), 'error text').toBeGreaterThanOrEqual(AA);
      }
    });

    it('keeps filled button labels readable', () => {
      const onPrimary = tokens['--md-on-primary'] ?? bgPrimary;
      const onError = tokens['--md-on-error'] ?? bgPrimary;
      expect(contrast(onPrimary, tokens['--color-accent-special']!)).toBeGreaterThanOrEqual(AA);
      expect(contrast(onError, tokens['--color-danger']!)).toBeGreaterThanOrEqual(AA);
    });

    it('keeps terminal colors readable on the terminal background', () => {
      // 深色主题的 black 本来就贴近底色,用作背景块而不是文字
      const skipped = theme.tone === '深色' ? ['black'] : [];
      const roles = Object.keys(theme.terminal).filter(
        (key) =>
          !['background', 'cursor', 'cursorAccent', 'selectionBackground'].includes(key) &&
          !skipped.includes(key),
      ) as Array<keyof TerminalPalette>;
      expect(roles).toHaveLength(theme.tone === '深色' ? 16 : 17);
      for (const role of roles) {
        expect(
          contrast(theme.terminal[role], theme.terminal.background),
          role,
        ).toBeGreaterThanOrEqual(AA);
      }
    });

    it('keeps terminal text readable while selected', () => {
      expect(
        contrast(theme.terminal.foreground, theme.terminal.selectionBackground),
      ).toBeGreaterThanOrEqual(AA);
    });
  });
});
