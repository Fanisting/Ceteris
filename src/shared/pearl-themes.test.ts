/**
 * @file src/shared/pearl-themes.test.ts
 * @purpose 核对珠光系列主题的对比度,改 pearl-themes.css 的色值后由这里报出不达标的组合。
 *
 * @关键设计:
 * - 直接解析 CSS 文本里每个 [data-theme='pearl-*'] 块的 --color-* 声明,不启动浏览器。
 * - 文字色(text-*)在 bg-primary 和 bg-secondary 上 >= 4.5:1(WCAG AA 正文)。
 * - 状态色和强调色在两种底色上 >= 3:1(WCAG 1.4.11 非文字元素)。
 *
 * @对应文档章节:软件定义书.md 5.1.9 节
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const CSS = readFileSync(resolve(__dirname, '../renderer/styles/pearl-themes.css'), 'utf8');

function parseThemes(css: string): Map<string, Record<string, string>> {
  const themes = new Map<string, Record<string, string>>();
  for (const [, id = '', body = ''] of css.matchAll(
    /\[data-theme='(pearl-[a-z]+)'\]\s*\{([^}]*)\}/g,
  )) {
    const vars: Record<string, string> = {};
    for (const [, token = '', hex = ''] of body.matchAll(/--color-([a-z-]+):\s*(#[0-9a-f]{6})/g)) {
      vars[token] = hex;
    }
    themes.set(id, vars);
  }
  return themes;
}

function channel(hex: string, offset: number): number {
  const v = parseInt(hex.slice(offset, offset + 2), 16) / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  return 0.2126 * channel(hex, 1) + 0.7152 * channel(hex, 3) + 0.0722 * channel(hex, 5);
}

function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const THEMES = parseThemes(CSS);
const RULES: Array<[string, number]> = [
  ['text-primary', 4.5],
  ['text-secondary', 4.5],
  ['text-muted', 4.5],
  ['danger', 3],
  ['warning', 3],
  ['success', 3],
  ['info', 3],
  ['accent-secondary', 3],
  ['accent-special', 3],
];

describe('pearl themes', () => {
  it('前景色在 bg-primary 和 bg-secondary 上达到对比度下限', () => {
    expect(THEMES.size).toBe(7);
    const failures: string[] = [];
    for (const [id, vars] of THEMES) {
      for (const [token, min] of RULES) {
        for (const bg of ['bg-primary', 'bg-secondary']) {
          const fg = vars[token];
          const back = vars[bg];
          const ratio = fg && back ? contrast(fg, back) : 0;
          if (!(ratio >= min))
            failures.push(`${id} ${token} on ${bg}: ${ratio.toFixed(2)} < ${min}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });
});
