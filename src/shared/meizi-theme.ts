/**
 * @file src/shared/meizi-theme.ts
 * @purpose 梅子(Meizi)主题的终端配色。
 *
 * @关键设计:
 * - 放在 shared 而不是 TerminalView:vitest 不收集 src/renderer,放这里才能被
 *   meizi-theme.test.ts 检查对比度。
 * - 底色、正文、光标、选区与 src/renderer/styles/meizi-theme.css 同源:纸面 #F3EBDE、
 *   正文 #3D3D35、深梅粉光标、浅梅粉选区。ANSI 色按各自色相压暗到在纸面上 >= 4.5:1,
 *   magenta 直接用深梅粉,brightBlack 用棕。
 *
 * @对应文档章节:软件定义书.md 5.1.9
 */
import type { TerminalPalette } from './beamer-themes';

export const MEIZI_TERMINAL: TerminalPalette = {
  background: '#f3ebde',
  foreground: '#3d3d35',
  cursor: '#8b4a61',
  cursorAccent: '#f3ebde',
  selectionBackground: '#ffd9e6',
  black: '#3d3d35',
  red: '#ad3044',
  green: '#3a7243',
  yellow: '#85651a',
  blue: '#3d5f94',
  magenta: '#8b4a61',
  cyan: '#2f6e73',
  white: '#4f4842',
  brightBlack: '#73595c',
  brightRed: '#922435',
  brightGreen: '#2f5e37',
  brightYellow: '#6e5315',
  brightBlue: '#2f4c7a',
  brightMagenta: '#73394d',
  brightCyan: '#255a5e',
  brightWhite: '#3d3d35',
};
