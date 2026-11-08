/**
 * @file src/shared/beamer-themes.test.ts
 * @purpose 检查 Beamer 主题的配色规则。每条规则一个测试,在所有主题上循环,
 *   失败时列出全部不达标的主题和颜色。这些状态色是手工调的,目测看不出 4.3:1
 *   和 4.5:1 的差别。
 *
 * @不在 src/renderer 写的原因:同 css-var-fallback.test.ts,vitest 不收集 renderer。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BEAMER_THEMES, BEAMER_THEME_IDS, type TerminalPalette } from './beamer-themes';

const RENDERER = resolve(__dirname, '../renderer');
const CSS = readFileSync(resolve(RENDERER, 'styles/beamer-themes.css'), 'utf8');
const AA = 4.5;
/** MD3 hover 状态层:当前文字色 8% 叠在背景上 (material.css --md-state-hover) */
const HOVER_LAYER = 8;

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
  return start < 0 ? '' : CSS.slice(start, CSS.indexOf('}', start));
}

function tokensOf(id: string): Record<string, string> {
  const tokens: Record<string, string> = {};
  for (const [, name, value] of blockFor(id).matchAll(/(--[\w-]+):\s*([^;]+);/g)) {
    tokens[name!] = value!.trim();
  }
  return tokens;
}

function rgb(hex: string): number[] {
  const full = hex.length === 4 ? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}` : hex;
  return [1, 3, 5].map((i) => parseInt(full.slice(i, i + 2), 16));
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

/** 收集所有低于 AA 的颜色对,让一次失败列出全部问题。 */
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

const THEMES = BEAMER_THEMES.map((theme) => {
  const t = tokensOf(theme.id);
  const accent = t['--md-primary'] ?? t['--color-accent-special']!;
  const onSurface = t['--color-text-primary']!;
  return {
    theme,
    t,
    surfaces: [t['--color-bg-primary']!, t['--color-bg-secondary']!],
    accent,
    onSurface,
    primaryText: mix(accent, onSurface, parseInt(t['--md-primary-text-weight'] ?? '100%', 10)),
    errorText: mix(
      t['--color-danger']!,
      onSurface,
      parseInt(t['--md-error-text-weight'] ?? '100%', 10),
    ),
  };
});

describe('beamer themes', () => {
  it('lists every id once and defines every token', () => {
    expect(BEAMER_THEMES.map((t) => t.id)).toEqual([...BEAMER_THEME_IDS]);
    for (const { theme, t } of THEMES) {
      for (const name of REQUIRED_TOKENS) {
        expect(t[name], `${theme.id} ${name}`).toMatch(/^#[0-9a-f]{6}$/);
      }
    }
  });

  it('loads after material.css, which it overrides at equal specificity', () => {
    const entry = readFileSync(resolve(RENDERER, 'index.tsx'), 'utf8');
    const material = entry.indexOf("import './styles/material.css'");
    expect(material).toBeGreaterThanOrEqual(0);
    expect(entry.indexOf("import './styles/beamer-themes.css'")).toBeGreaterThan(material);
  });

  it('matches its tone, and shares base colors with the terminal', () => {
    for (const { theme, t } of THEMES) {
      const light = theme.tone === '浅色';
      expect(luminance(t['--color-bg-primary']!) > 0.5, theme.id).toBe(light);
      expect(/color-scheme:\s*light/.test(blockFor(theme.id)), theme.id).toBe(light);
      expect(theme.terminal.background, theme.id).toBe(t['--color-bg-primary']);
      expect(theme.terminal.foreground, theme.id).toBe(t['--color-text-primary']);
    }
  });

  it('keeps text and status colors readable on primary and secondary surfaces', () => {
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
      for (const { theme, t, surfaces } of THEMES) {
        for (const name of names) {
          for (const bg of surfaces) check(`${theme.id} ${name}`, t[name]!, bg);
        }
      }
    });
    expect(failures).toEqual([]);
  });

  it('keeps primary text readable on elevated, hover and selected backgrounds', () => {
    const failures = collectUnreadable((check) => {
      for (const { theme, t, accent, onSurface, surfaces } of THEMES) {
        const selected = t['--md-secondary-container'] ?? mix(accent, surfaces[1]!, 24);
        const backgrounds = [
          t['--color-bg-elevated']!,
          t['--color-bg-hover']!,
          t['--color-bg-active']!,
          selected,
        ];
        for (const bg of backgrounds) check(theme.id, onSurface, bg);
      }
    });
    expect(failures).toEqual([]);
  });

  it('keeps accent and error text readable, including under the hover layer', () => {
    const failures = collectUnreadable((check) => {
      for (const { theme, surfaces, primaryText, errorText } of THEMES) {
        for (const bg of surfaces) {
          check(`${theme.id} primary`, primaryText, bg);
          check(`${theme.id} error`, errorText, bg);
          check(`${theme.id} primary hover`, primaryText, mix(primaryText, bg, HOVER_LAYER));
          check(`${theme.id} error hover`, errorText, mix(errorText, bg, HOVER_LAYER));
        }
      }
    });
    expect(failures).toEqual([]);
  });

  it('keeps filled button labels readable, including under the hover layer', () => {
    const failures = collectUnreadable((check) => {
      for (const { theme, t, accent, surfaces } of THEMES) {
        const onPrimary = t['--md-on-primary'] ?? surfaces[0]!;
        const onError = t['--md-on-error'] ?? surfaces[0]!;
        const danger = t['--color-danger']!;
        check(`${theme.id} on-primary`, onPrimary, accent);
        check(`${theme.id} on-primary hover`, onPrimary, mix(onPrimary, accent, HOVER_LAYER));
        check(`${theme.id} on-error`, onError, danger);
      }
    });
    expect(failures).toEqual([]);
  });

  it('keeps terminal colors readable, also on a selection', () => {
    const notText = ['background', 'cursor', 'cursorAccent', 'selectionBackground'];
    const failures = collectUnreadable((check) => {
      for (const { theme } of THEMES) {
        const { terminal } = theme;
        const roles = Object.keys(terminal) as Array<keyof TerminalPalette>;
        for (const role of roles) {
          // 深色主题的 black 本来就贴近底色,用作背景块而不是文字
          if (notText.includes(role) || (role === 'black' && theme.tone === '深色')) continue;
          check(`${theme.id} ${role}`, terminal[role], terminal.background);
        }
        check(`${theme.id} selection`, terminal.foreground, terminal.selectionBackground);
      }
    });
    expect(failures).toEqual([]);
  });
});
