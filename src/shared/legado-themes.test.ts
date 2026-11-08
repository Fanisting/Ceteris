/**
 * @file src/shared/legado-themes.test.ts
 * @purpose 核对 Legado MD3 主题:CSS 按 Legado 的角色分工取色,且文字、状态色和终端色达到对比度下限。
 *
 * @关键设计:
 * - 解析 legado-themes.css 的文本,不启动浏览器。每条规则一个测试,在 22 款主题上循环,
 *   失败时一次列出全部不达标的组合。
 * - 角色分工见 legado-themes.css 头注释。这里核对的是"与源色板一致",改生成规则时一起改。
 *
 * @不在 src/renderer 写的原因:vitest 不收集 renderer。
 *
 * @对应文档章节:软件定义书.md 5.1.9 节
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LEGADO_THEMES, LEGADO_THEME_IDS, type LegadoScheme } from './legado-themes';
import type { TerminalPalette } from './beamer-themes';

const RENDERER = resolve(__dirname, '../renderer');
const CSS = readFileSync(resolve(RENDERER, 'styles/legado-themes.css'), 'utf8');
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

function rgb(hex: string): number[] {
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

const THEMES = LEGADO_THEMES.map((theme) => {
  const t = tokensOf(theme.id);
  const onSurface = t['--color-text-primary']!;
  const weight = (name: string): number => parseInt(t[name] ?? '100%', 10);
  return {
    theme,
    t,
    surfaces: [t['--color-bg-primary']!, t['--color-bg-secondary']!],
    menu: t['--md-surface-container-high']!,
    primaryText: mix(t['--md-primary']!, onSurface, weight('--md-primary-text-weight')),
    errorText: mix(t['--color-danger']!, onSurface, weight('--md-error-text-weight')),
  };
});

describe('legado md3 themes', () => {
  it('lists every id once, defines each in CSS, and loads after material.css', () => {
    expect(LEGADO_THEMES.map((t) => t.id)).toEqual([...LEGADO_THEME_IDS]);
    expect(new Set(LEGADO_THEME_IDS).size).toBe(LEGADO_THEME_IDS.length);
    const missing = LEGADO_THEME_IDS.filter((id) => blockFor(id) === '');
    expect(missing).toEqual([]);
    const notHex = THEMES.flatMap(({ theme, t }) =>
      Object.entries(t)
        .filter(([name, value]) => !name.endsWith('-weight') && !/^#[0-9a-f]{6}$/.test(value))
        .map(([name, value]) => `${theme.id} ${name}=${value}`),
    );
    expect(notHex).toEqual([]);
    const entry = readFileSync(resolve(RENDERER, 'index.tsx'), 'utf8');
    const material = entry.indexOf("import './styles/material.css'");
    expect(material).toBeGreaterThanOrEqual(0);
    expect(entry.indexOf("import './styles/legado-themes.css'")).toBeGreaterThan(material);
  });

  it('colours each surface and text role the way Legado does', () => {
    // CSS token → Legado MD3 角色。--md-secondary-container 不在表里:Elink 为了对比度调过。
    const roles: Array<[string, keyof LegadoScheme]> = [
      ['--color-bg-primary', 'surfaceContainerLow'],
      ['--color-bg-secondary', 'background'],
      ['--md-surface-container-high', 'surfaceContainer'],
      ['--md-surface-container-highest', 'surfaceContainerHighest'],
      ['--color-bg-hover', 'surfaceContainerHigh'],
      ['--color-text-primary', 'onSurface'],
      ['--color-text-secondary', 'onSurfaceVariant'],
      ['--color-danger', 'error'],
      ['--md-primary', 'primary'],
      ['--md-on-primary', 'onPrimary'],
      ['--md-outline', 'outline'],
      ['--md-outline-variant', 'outlineVariant'],
    ];
    const wrong: string[] = [];
    for (const { theme, t } of THEMES) {
      for (const [token, role] of roles) {
        if (t[token] !== theme.scheme[role]) {
          wrong.push(`${theme.id} ${token}=${t[token]} expected ${role}=${theme.scheme[role]}`);
        }
      }
      if (/color-scheme:\s*light/.test(blockFor(theme.id)) === theme.dark) {
        wrong.push(`${theme.id} color-scheme`);
      }
      if (luminance(t['--color-bg-primary']!) > 0.5 === theme.dark) wrong.push(`${theme.id} tone`);
      if (theme.terminal.background !== t['--color-bg-primary']) wrong.push(`${theme.id} term bg`);
      if (theme.terminal.foreground !== t['--color-text-primary'])
        wrong.push(`${theme.id} term fg`);
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
      for (const { theme, t, surfaces, menu } of THEMES) {
        for (const name of names) {
          for (const bg of [...surfaces, menu]) check(`${theme.id} ${name}`, t[name]!, bg);
        }
      }
    });
    expect(failures).toEqual([]);
  });

  it('keeps labels readable on hover, selected and filled backgrounds', () => {
    const failures = collectUnreadable((check) => {
      for (const { theme, t, surfaces, menu, primaryText, errorText } of THEMES) {
        const onSurface = t['--color-text-primary']!;
        const selected = t['--md-secondary-container']!;
        for (const bg of [t['--color-bg-hover']!, t['--color-bg-active']!, selected]) {
          check(`${theme.id} text`, onSurface, bg);
        }
        check(`${theme.id} on-selected`, t['--md-on-secondary-container']!, selected);
        const accent = t['--md-primary']!;
        const onPrimary = t['--md-on-primary']!;
        check(`${theme.id} on-primary`, onPrimary, accent);
        check(`${theme.id} on-primary hover`, onPrimary, mix(onPrimary, accent, HOVER_LAYER));
        check(`${theme.id} on-error`, t['--md-on-error']!, t['--color-danger']!);
        // 强调色和错误色文字也出现在菜单和悬停底上
        for (const bg of [...surfaces, menu, t['--color-bg-hover']!]) {
          check(`${theme.id} primary text`, primaryText, bg);
          check(`${theme.id} error text`, errorText, bg);
          check(`${theme.id} primary hover`, primaryText, mix(primaryText, bg, HOVER_LAYER));
          check(`${theme.id} error hover`, errorText, mix(errorText, bg, HOVER_LAYER));
        }
      }
    });
    expect(failures).toEqual([]);
  });

  it('keeps terminal colours readable, also on a selection', () => {
    const notText = ['background', 'cursor', 'cursorAccent', 'selectionBackground'];
    const failures = collectUnreadable((check) => {
      for (const { theme } of THEMES) {
        const { terminal } = theme;
        for (const role of Object.keys(terminal) as Array<keyof TerminalPalette>) {
          // 深色主题的 black 贴近底色,用作背景块而不是文字
          if (notText.includes(role) || (role === 'black' && theme.dark)) continue;
          check(`${theme.id} ${role}`, terminal[role], terminal.background);
        }
        check(`${theme.id} selection`, terminal.foreground, terminal.selectionBackground);
      }
    });
    expect(failures).toEqual([]);
  });
});
