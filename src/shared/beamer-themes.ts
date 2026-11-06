/**
 * @file src/shared/beamer-themes.ts
 * @purpose 取自 LaTeX Beamer 模板配色的主题清单和终端配色。Overleaf 上的 Beamer
 *   模板用的就是这些内置主题和 Metropolis。
 *
 * @关键设计:
 * - 色值来自 TeX Live 的 beamercolortheme*.sty 和 beamercolorthememetropolis.sty,
 *   不凭记忆。Beamer 的 `a!60!b` 写法按线性混合换算成 hex。
 * - Beamer 模板几乎都是白底,状态色也不考虑终端可读性,所以状态色和 ANSI 色
 *   按模板色相另行调到 4.5:1。标志色保持原值。
 * - 放在 shared 而不是 TerminalView:这样 ID 能同时供 settings-manager 校验,
 *   配色也能被单测检查 (vitest 不收集 src/renderer)。
 * - 界面配色在 src/renderer/styles/beamer-themes.css,两边的底色和文字色要一致,
 *   beamer-themes.test.ts 会检查。
 *
 * @对应文档章节: 软件定义书.md 5.1.9
 */

export const BEAMER_THEME_IDS = [
  'metropolis',
  'metropolis-dark',
  'madrid',
  'cambridge-us',
  'ann-arbor',
  'spruce',
] as const;

export type BeamerThemeId = (typeof BEAMER_THEME_IDS)[number];

/** xterm ITheme 的子集。shared 不依赖 xterm 的类型,结构上可以直接赋给 ITheme。 */
export interface TerminalPalette {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

export interface BeamerTheme {
  id: BeamerThemeId;
  label: string;
  /** 取值与 SettingsView 的主题列表相同,才能直接并入该列表 */
  tone: '深色' | '浅色';
  note: 'Beamer';
  terminal: TerminalPalette;
}

export const BEAMER_THEMES: BeamerTheme[] = [
  // Metropolis 默认外观:mDarkTeal 文字 + mLightBrown 强调
  {
    id: 'metropolis',
    label: 'Metropolis',
    tone: '浅色',
    note: 'Beamer',
    terminal: {
      background: '#fafafa',
      foreground: '#23373b',
      cursor: '#eb811b',
      cursorAccent: '#fafafa',
      selectionBackground: '#cfd3d4',
      black: '#23373b',
      red: '#b3261e',
      green: '#0b7a2a',
      yellow: '#9a5200',
      blue: '#1f5fa8',
      magenta: '#7a3f8f',
      cyan: '#1f6a78',
      white: '#4f6165',
      brightBlack: '#5f7074',
      brightRed: '#8f1d17',
      brightGreen: '#08611f',
      brightYellow: '#7d4300',
      brightBlue: '#174a85',
      brightMagenta: '#62306f',
      brightCyan: '#16535e',
      brightWhite: '#23373b',
    },
  },
  // Metropolis 的 background=dark 选项:底色和文字互换
  {
    id: 'metropolis-dark',
    label: 'Metropolis Dark',
    tone: '深色',
    note: 'Beamer',
    terminal: {
      background: '#23373b',
      foreground: '#fafafa',
      cursor: '#eb811b',
      cursorAccent: '#23373b',
      selectionBackground: '#4e5e61',
      black: '#1c2c2f',
      red: '#ff9a8f',
      green: '#4fd07a',
      yellow: '#f5a54a',
      blue: '#8fbcf0',
      magenta: '#d9aee0',
      cyan: '#7fd0d6',
      white: '#dfe4e4',
      brightBlack: '#9aabae',
      brightRed: '#ffbdb5',
      brightGreen: '#86e3a6',
      brightYellow: '#ffc98a',
      brightBlue: '#b8d5f7',
      brightMagenta: '#e8cdec',
      brightCyan: '#aee5e8',
      brightWhite: '#fafafa',
    },
  },
  // Madrid = whale + orchid,结构色是 Beamer 默认蓝。Berkeley / Warsaw / Berlin 同色
  {
    id: 'madrid',
    label: 'Madrid',
    tone: '浅色',
    note: 'Beamer',
    terminal: {
      background: '#ffffff',
      foreground: '#1a1a5a',
      cursor: '#3333b3',
      cursorAccent: '#ffffff',
      selectionBackground: '#d6d6f0',
      black: '#1a1a5a',
      red: '#c00000',
      green: '#006e00',
      yellow: '#8a5a00',
      blue: '#3333b3',
      magenta: '#8a2a9e',
      cyan: '#00707a',
      white: '#4a4a7a',
      brightBlack: '#5c5c8a',
      brightRed: '#990000',
      brightGreen: '#005700',
      brightYellow: '#6e4700',
      brightBlue: '#262686',
      brightMagenta: '#6e2180',
      brightCyan: '#005a62',
      brightWhite: '#1a1a5a',
    },
  },
  // CambridgeUS = beaver:灰底 + darkred
  {
    id: 'cambridge-us',
    label: 'CambridgeUS',
    tone: '浅色',
    note: 'Beamer',
    terminal: {
      background: '#ffffff',
      foreground: '#1a1a1a',
      cursor: '#a30000',
      cursorAccent: '#ffffff',
      selectionBackground: '#d9d9d9',
      black: '#1a1a1a',
      red: '#cc0000',
      green: '#2e7d32',
      yellow: '#8a5a00',
      blue: '#1f5fa8',
      magenta: '#8f2a7a',
      cyan: '#00707a',
      white: '#595959',
      brightBlack: '#6b6b6b',
      brightRed: '#a30000',
      brightGreen: '#1f5f24',
      brightYellow: '#6e4700',
      brightBlue: '#174a85',
      brightMagenta: '#702060',
      brightCyan: '#005a62',
      brightWhite: '#1a1a1a',
    },
  },
  // AnnArbor = wolverine:密歇根蓝 + 玉米黄。取模板里的深蓝条作底色,
  // 模板的黄色标题栏面积太大,不适合做终端底色
  {
    id: 'ann-arbor',
    label: 'AnnArbor',
    tone: '深色',
    note: 'Beamer',
    terminal: {
      background: '#000052',
      foreground: '#ffffe6',
      cursor: '#ffcc00',
      cursorAccent: '#000052',
      selectionBackground: '#0000a3',
      black: '#00003d',
      red: '#ff8f8f',
      green: '#7fe08f',
      yellow: '#ffcc00',
      blue: '#8fa8ff',
      magenta: '#e0a0ff',
      cyan: '#7fe0e0',
      white: '#e6e6d8',
      brightBlack: '#9a9ac8',
      brightRed: '#ffb8b8',
      brightGreen: '#b0f0bc',
      brightYellow: '#ffec00',
      brightBlue: '#bccbff',
      brightMagenta: '#eec8ff',
      brightCyan: '#b0f0f0',
      brightWhite: '#ffffff',
    },
  },
  // spruce 配色主题:MSUgreen
  {
    id: 'spruce',
    label: 'Spruce',
    tone: '浅色',
    note: 'Beamer',
    terminal: {
      background: '#ffffff',
      foreground: '#003d1f',
      cursor: '#006633',
      cursorAccent: '#ffffff',
      selectionBackground: '#d9e8e0',
      black: '#003d1f',
      red: '#b3261e',
      green: '#006633',
      yellow: '#7d5a00',
      blue: '#1f5fa8',
      magenta: '#7a3f8f',
      cyan: '#00707a',
      white: '#3f6b55',
      brightBlack: '#527a66',
      brightRed: '#8f1d17',
      brightGreen: '#005229',
      brightYellow: '#634700',
      brightBlue: '#174a85',
      brightMagenta: '#62306f',
      brightCyan: '#005a62',
      brightWhite: '#003d1f',
    },
  },
];
