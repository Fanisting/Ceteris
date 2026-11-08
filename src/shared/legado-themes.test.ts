/**
 * @file src/shared/legado-themes.test.ts
 * @purpose 核对 Legado MD3 主题:CSS 按 Legado 的角色分工取色,文字、状态色和终端色达到对比度下限;
 *   用种子色实时生成的主题(ADR-030)守同样的规则。
 *
 * @关键设计:
 * - 22 款固定主题的 token 读自 legado-themes.css 文本,不启动浏览器;实时主题的 token 由
 *   legado-palette.ts 现算。每条规则一个测试,在全部主题上循环,失败时一次列出全部不达标的组合。
 * - 角色分工见 legado-themes.css 头注释。这里核对的是"与源色板一致",改换算规则时一起改。
 *
 * @不在 src/renderer 写的原因:vitest 不收集 renderer。
 *
 * @对应文档章节:软件定义书.md 5.1.9 节、ADR-030
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LEGADO_THEMES, LEGADO_THEME_IDS } from './legado-themes';
import { contrast, legadoLook, mix, type LegadoScheme } from './legado-palette';
import { generateLegadoScheme } from './legado-dynamic';
import {
  LEGADO_CONTRAST_LEVELS,
  LEGADO_PALETTE_STYLES,
  type LegadoContrast,
} from './legado-dynamic-ids';
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

/** 浅色主题的页面亮度高于中灰,用相对亮度比较,不依赖 legado-palette 的实现 */
function isLightPage(hex: string): boolean {
  return contrast(hex, '#000000') > contrast(hex, '#ffffff');
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

interface Case {
  id: string;
  dark: boolean;
  scheme: LegadoScheme;
  t: Record<string, string>;
  terminal: TerminalPalette;
}

function withDerived(c: Case) {
  const { t } = c;
  const onSurface = t['--color-text-primary']!;
  const weight = (name: string): number => parseInt(t[name] ?? '100%', 10);
  return {
    ...c,
    surfaces: [t['--color-bg-primary']!, t['--color-bg-secondary']!],
    menu: t['--md-surface-container-high']!,
    primaryText: mix(t['--md-primary']!, onSurface, weight('--md-primary-text-weight')),
    errorText: mix(t['--color-danger']!, onSurface, weight('--md-error-text-weight')),
  };
}

/** 22 款固定主题:token 读自 CSS 文件 */
const FIXED = LEGADO_THEMES.map((theme) =>
  withDerived({ ...theme, t: tokensOf(theme.id), terminal: theme.terminal }),
);

/**
 * 实时生成的主题(ADR-030):几种性质各异的种子色(蓝、黄、纯红、灰、近黑、近白)
 * 乘九种风格、三档对比度、明暗,共 324 套,都要守同样的规则。
 */
const SEEDS = ['#3b608f', '#e8b923', '#ff0000', '#808080', '#101010', '#f4f4f4'];
const LEVELS = Object.keys(LEGADO_CONTRAST_LEVELS) as LegadoContrast[];
const GENERATED = SEEDS.flatMap((seed) =>
  LEGADO_PALETTE_STYLES.flatMap((style) =>
    LEVELS.flatMap((level) =>
      [false, true].map((dark) => {
        const scheme = generateLegadoScheme(seed, style, level, dark);
        const { tokens, terminal } = legadoLook(scheme, dark);
        const id = `${seed} ${style} ${level}${dark ? ' dark' : ''}`;
        return withDerived({ id, dark, scheme, t: tokens, terminal });
      }),
    ),
  ),
);

const THEMES = [...FIXED, ...GENERATED];

describe('legado md3 themes', () => {
  it('lists every id once, matches the shared palette code, and loads after material.css', () => {
    expect(LEGADO_THEMES.map((t) => t.id)).toEqual([...LEGADO_THEME_IDS]);
    expect(new Set(LEGADO_THEME_IDS).size).toBe(LEGADO_THEME_IDS.length);
    expect(LEGADO_THEME_IDS.filter((id) => blockFor(id) === '')).toEqual([]);
    expect([FIXED.length, GENERATED.length]).toEqual([22, 324]);
    const notHex = THEMES.flatMap(({ id, t }) =>
      Object.entries(t)
        .filter(([name, value]) => !name.endsWith('-weight') && !/^#[0-9a-f]{6}$/.test(value))
        .map(([name, value]) => `${id} ${name}=${value}`),
    );
    expect(notHex).toEqual([]);
    // 固定主题的 CSS 和终端配色必须就是 legado-palette.ts 算出的结果,实时主题才和它们一致
    const drift = FIXED.filter(({ scheme, dark, t, terminal }) => {
      const look = legadoLook(scheme, dark);
      return (
        JSON.stringify(look.tokens) !== JSON.stringify(t) ||
        JSON.stringify(look.terminal) !== JSON.stringify(terminal)
      );
    }).map((c) => c.id);
    expect(drift).toEqual([]);
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
    for (const { id, dark, scheme, t, terminal } of THEMES) {
      for (const [token, role] of roles) {
        if (t[token] !== scheme[role]) {
          wrong.push(`${id} ${token}=${t[token]} expected ${role}=${scheme[role]}`);
        }
      }
      if (isLightPage(t['--color-bg-primary']!) === dark) wrong.push(`${id} tone`);
      if (terminal.background !== t['--color-bg-primary']) wrong.push(`${id} term bg`);
      if (terminal.foreground !== t['--color-text-primary']) wrong.push(`${id} term fg`);
    }
    for (const { id, dark } of FIXED) {
      if (/color-scheme:\s*light/.test(blockFor(id)) === dark) wrong.push(`${id} color-scheme`);
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
        // 强调色和错误色文字也出现在菜单和悬停底上
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
