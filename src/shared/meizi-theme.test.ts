/**
 * @file src/shared/meizi-theme.test.ts
 * @purpose 核对梅子主题的对比度,改 meizi-theme.css 或 meizi-theme.ts 的色值后由这里报出不达标的组合。
 *
 * @关键设计:
 * - 解析 CSS 文本里 [data-theme='meizi'] 块的 --color-* 声明,不启动浏览器。
 * - 界面:文字色在 bg-primary、bg-secondary 上 >= 4.5:1,状态色和强调色 >= 3:1。
 * - 终端:除 black / brightWhite(与正文同色)外,每个 ANSI 前景色在终端底色上 >= 4.5:1,
 *   且终端底色和正文与界面一致。
 *
 * @对应文档章节:软件定义书.md 5.1.9 节
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MEIZI_TERMINAL } from './meizi-theme';

const CSS = readFileSync(resolve(__dirname, '../renderer/styles/meizi-theme.css'), 'utf8');
const BLOCK = /\[data-theme='meizi'\]\s*\{([^}]*)\}/.exec(CSS)?.[1] ?? '';
const VARS: Record<string, string> = Object.fromEntries(
  [...BLOCK.matchAll(/--color-([a-z-]+):\s*(#[0-9a-f]{6})/g)].map(([, k = '', v = '']) => [k, v]),
);

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

describe('meizi theme', () => {
  it('界面前景色和终端 ANSI 色达到对比度下限,终端与界面底色一致', () => {
    const failures: string[] = [];
    const ui: Array<[string, number]> = [
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
    for (const [token, min] of ui) {
      for (const bg of ['bg-primary', 'bg-secondary']) {
        const fg = VARS[token];
        const back = VARS[bg];
        const ratio = fg && back ? contrast(fg, back) : 0;
        if (!(ratio >= min)) failures.push(`${token} on ${bg}: ${ratio.toFixed(2)} < ${min}`);
      }
    }
    const t = MEIZI_TERMINAL;
    for (const key of [
      'foreground',
      'red',
      'green',
      'yellow',
      'blue',
      'magenta',
      'cyan',
      'white',
      'brightBlack',
      'brightRed',
      'brightGreen',
      'brightYellow',
      'brightBlue',
      'brightMagenta',
      'brightCyan',
    ] as const) {
      const ratio = contrast(t[key], t.background);
      if (!(ratio >= 4.5)) failures.push(`terminal ${key}: ${ratio.toFixed(2)} < 4.5`);
    }
    if (t.background !== VARS['bg-primary']) failures.push('terminal background differs from UI');
    if (t.foreground !== VARS['text-primary']) failures.push('terminal foreground differs from UI');
    expect(failures).toEqual([]);
  });
});
