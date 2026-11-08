/**
 * @file src/shared/legado-palette.ts
 * @purpose 把一套 Legado / MD3 色板换算成 Ceteris 主题:界面 token、终端配色和 CSS 块。
 *
 * @关键设计:
 * - 22 款固定主题(scripts/gen-legado-themes.mjs 生成)和用种子色实时生成的主题
 *   (legado-dynamic.ts,ADR 见软件定义书 5.1.9)都走这里,所以角色分工只写一处。
 * - 角色分工照 Legado 给组件上色的方式,详见 legado-themes.css 头注释:外框 = background,
 *   标签页 = surfaceContainerLow,菜单 = surfaceContainer,选中 = secondaryContainer。
 * - MD3 色板没有 warning / success / info 和 ANSI 色,用固定色相按本色板的底色调到 4.5:1。
 *   终端红色同样从固定的 MD3 标准 error 色起步,不跟随色板的 error,高对比度下仍是红色。
 * - 只有 `import type`,没有其它运行时依赖:生成脚本用 Node 的类型擦除直接加载本文件。
 *
 * @不要在这里做的事:
 * - 不要生成色板(那是 legado-dynamic.ts 的事,它依赖 material-color-utilities)
 *
 * @对应文档章节:软件定义书.md 5.1.9
 */
import type { TerminalPalette } from './beamer-themes';

/** Legado 的 MD3 颜色角色,只收 Ceteris 用到的。 */
export interface LegadoScheme {
  primary: string;
  onPrimary: string;
  primaryContainer: string;
  onPrimaryContainer: string;
  secondary: string;
  onSecondary: string;
  secondaryContainer: string;
  onSecondaryContainer: string;
  tertiary: string;
  tertiaryContainer: string;
  error: string;
  onError: string;
  errorContainer: string;
  background: string;
  surface: string;
  onSurface: string;
  surfaceVariant: string;
  onSurfaceVariant: string;
  outline: string;
  outlineVariant: string;
  inverseSurface: string;
  inverseOnSurface: string;
  inversePrimary: string;
  surfaceContainerLowest: string;
  surfaceContainerLow: string;
  surfaceContainer: string;
  surfaceContainerHigh: string;
  surfaceContainerHighest: string;
}

export const LEGADO_ROLES: Array<keyof LegadoScheme> = [
  'primary',
  'onPrimary',
  'primaryContainer',
  'onPrimaryContainer',
  'secondary',
  'onSecondary',
  'secondaryContainer',
  'onSecondaryContainer',
  'tertiary',
  'tertiaryContainer',
  'error',
  'onError',
  'errorContainer',
  'background',
  'surface',
  'onSurface',
  'surfaceVariant',
  'onSurfaceVariant',
  'outline',
  'outlineVariant',
  'inverseSurface',
  'inverseOnSurface',
  'inversePrimary',
  'surfaceContainerLowest',
  'surfaceContainerLow',
  'surfaceContainer',
  'surfaceContainerHigh',
  'surfaceContainerHighest',
];

export interface LegadoLook {
  /** CSS 自定义属性名 → 值,写进 [data-theme] 块 */
  tokens: Record<string, string>;
  terminal: TerminalPalette;
}

// ── 颜色计算,公式与 legado-themes.test.ts 相同 ──

function rgb(hex: string): number[] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
}

function toHex(channels: number[]): string {
  const clamp = (v: number): number => Math.max(0, Math.min(255, Math.round(v)));
  return `#${channels.map((v) => clamp(v).toString(16).padStart(2, '0')).join('')}`;
}

function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

/** 等同 CSS 的 color-mix(in srgb, a weight%, b) */
export function mix(a: string, b: string, weight: number): string {
  const [ca, cb] = [rgb(a), rgb(b)];
  return toHex(ca.map((v, i) => Math.round((v * weight + cb[i]! * (100 - weight)) / 100)));
}

function toHsl(hex: string): [number, number, number] {
  const [r, g, b] = rgb(hex).map((v) => v / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h /= 6;
  return [h, s, l];
}

function fromHsl(h: number, s: number, l: number): string {
  if (s === 0) return toHex([l * 255, l * 255, l * 255]);
  const f = (p: number, q: number, t: number): number => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return toHex([f(p, q, h + 1 / 3), f(p, q, h), f(p, q, h - 1 / 3)].map((v) => v * 255));
}

/**
 * 沿亮度方向把颜色推离背景,直到在所有背景上达到 target。
 * 深色主题往亮推,浅色主题往暗推;推到头仍不够时返回端点(纯白 / 纯黑),不抛错,
 * 因为实时生成的色板不能让设置页崩掉,对比度由单测兜底。
 */
function readable(base: string, bgs: string[], dark: boolean, target = 4.6): string {
  const [h, s] = toHsl(base);
  let l = toHsl(base)[2];
  for (let i = 0; i < 200; i++) {
    const c = fromHsl(h, s, l);
    if (bgs.every((bg) => contrast(c, bg) >= target)) return c;
    l = dark ? Math.min(1, l + 0.005) : Math.max(0, l - 0.005);
  }
  return fromHsl(h, s, l);
}

/** 亮度平移,用来做 bright ANSI 色。 */
function shift(c: string, delta: number): string {
  const [h, s, l] = toHsl(c);
  return fromHsl(h, s, Math.max(0, Math.min(1, l + delta)));
}

/** MD3 色板没有的颜色的色相起点:浅色取 MD3 tone 40,深色取 tone 80,再由 readable() 调对比度。 */
const SEEDS = {
  light: {
    red: '#ba1a1a',
    green: '#3a6a1f',
    yellow: '#735c00',
    blue: '#3a5ba9',
    magenta: '#8b3f88',
    cyan: '#00687a',
    warning: '#7a5900',
    success: '#1f6c35',
    info: '#2a5db0',
  },
  dark: {
    red: '#ffb4ab',
    green: '#9fd68b',
    yellow: '#e2c55c',
    blue: '#adc6ff',
    magenta: '#f7adef',
    cyan: '#82d2e6',
    warning: '#e9c46a',
    success: '#8bd6a3',
    info: '#a8c8ff',
  },
};

/** 深色主题终端的普通 ANSI 色:MD3 tone 70 附近,比 tone 80 鲜艳,bright 版本再用 SEEDS.dark。 */
const DARK_VIVID = {
  red: '#ff897d',
  green: '#7fc46a',
  yellow: '#d4af2c',
  blue: '#7ea6f5',
  magenta: '#e88ce0',
  cyan: '#4fbdd4',
};

function tokensFor(s: LegadoScheme, dark: boolean): Record<string, string> {
  const bgPrimary = s.surfaceContainerLow; // 标签页 = Legado 的卡片底色
  const bgSecondary = s.background; // 外框 = Legado 的页面底色,顶栏和底栏同色
  const menu = s.surfaceContainer; // 菜单和对话框 = Legado 的 AppAlertDialog 和悬浮底栏
  const surfaces = [bgPrimary, bgSecondary];
  const statusBgs = [bgPrimary, bgSecondary, menu];
  const seeds = dark ? SEEDS.dark : SEEDS.light;

  let muted = s.outline;
  for (let w = 0; w <= 100 && !statusBgs.every((bg) => contrast(muted, bg) >= 4.5); w += 5) {
    muted = mix(s.onSurfaceVariant, s.outline, w);
  }

  // 强调色和错误色文字也出现在菜单和悬停底上,不只在页面上
  const textBgs = [...surfaces, menu, s.surfaceContainerHigh];
  const weightFor = (color: string): number => {
    for (let w = 100; w >= 0; w -= 10) {
      const text = mix(color, s.onSurface, w);
      const ok = textBgs.every(
        (bg) => contrast(text, bg) >= 4.5 && contrast(text, mix(text, bg, 8)) >= 4.5,
      );
      if (ok) return w;
    }
    return 0;
  };

  // Elink 的选中灰 #808080 上白字只有 3.95:1。只在色板不达标时把选中底推离正文色,文字改用 onSurface
  let selected = s.secondaryContainer;
  let onSelected = s.onSecondaryContainer;
  if (contrast(onSelected, selected) < 4.5 || contrast(s.onSurface, selected) < 4.5) {
    selected = readable(selected, [s.onSurface], !dark);
    onSelected = s.onSurface;
  }

  const t: Record<string, string> = {
    '--color-bg-primary': bgPrimary,
    '--color-bg-secondary': bgSecondary,
    '--color-bg-elevated': s.surfaceContainerHigh,
    '--color-bg-hover': s.surfaceContainerHigh,
    '--color-bg-active': s.surfaceContainerHighest,
    '--color-bg-strong': s.outlineVariant,
    '--color-text-primary': s.onSurface,
    '--color-text-secondary': s.onSurfaceVariant,
    '--color-text-muted': muted,
    '--color-danger': s.error,
    '--color-warning': readable(seeds.warning, statusBgs, dark),
    '--color-success': readable(seeds.success, statusBgs, dark),
    '--color-info': readable(seeds.info, statusBgs, dark),
    '--color-accent-secondary': s.secondary,
    '--color-accent-special': s.primary,
    '--md-primary': s.primary,
    '--md-on-primary': s.onPrimary,
    '--md-secondary-container': selected,
    '--md-on-secondary-container': onSelected,
    '--md-surface-container-high': menu,
    '--md-surface-container-highest': s.surfaceContainerHighest,
    '--md-outline': s.outline,
    '--md-outline-variant': s.outlineVariant,
    '--md-on-error': s.onError,
    '--md-inverse-surface': s.inverseSurface,
    '--md-inverse-on-surface': s.inverseOnSurface,
  };
  const pw = weightFor(s.primary);
  const ew = weightFor(s.error);
  if (pw < 100) t['--md-primary-text-weight'] = `${pw}%`;
  if (ew < 100) t['--md-error-text-weight'] = `${ew}%`;
  return t;
}

function terminalFor(s: LegadoScheme, bg: string, muted: string, dark: boolean): TerminalPalette {
  const r = (c: string): string => readable(c, [bg], dark);
  // 红色也从固定色相起步(就是 MD3 标准 error 色)。不直接用 s.error:高对比度色板里它被推到
  // 接近白色,终端里就认不出是红色了。
  // 浅色:普通色取 tone 40,bright 再压暗一点。深色:普通色取更鲜艳的 tone 70,bright 取 tone 80;
  // 若 bright 在 tone 80 上再提亮,就淡到接近白色(#ffd8d4 这种),认不出色相。
  const normal = dark ? DARK_VIVID : SEEDS.light;
  const bright = (key: keyof typeof DARK_VIVID, base: string): string =>
    dark ? r(SEEDS.dark[key]) : r(shift(base, -0.08));
  const red = r(normal.red);
  const green = r(normal.green);
  const yellow = r(normal.yellow);
  const blue = r(normal.blue);
  const magenta = r(normal.magenta);
  const cyan = r(normal.cyan);
  // 先用 primaryContainer;电子书色板里它和页面同色,就往后找
  const selection =
    [s.primaryContainer, s.secondaryContainer, s.surfaceContainerHighest, s.outlineVariant].find(
      (c) => contrast(s.onSurface, c) >= 4.5 && contrast(c, bg) >= 1.08,
    ) ?? s.secondaryContainer;
  return {
    background: bg,
    foreground: s.onSurface,
    cursor: s.primary,
    cursorAccent: s.onPrimary,
    selectionBackground: selection,
    black: dark ? s.surfaceContainerHighest : s.onSurface,
    red,
    green,
    yellow,
    blue,
    magenta,
    cyan,
    white: dark ? s.onSurfaceVariant : r(s.onSurfaceVariant),
    brightBlack: muted,
    brightRed: bright('red', red),
    brightGreen: bright('green', green),
    brightYellow: bright('yellow', yellow),
    brightBlue: bright('blue', blue),
    brightMagenta: bright('magenta', magenta),
    brightCyan: bright('cyan', cyan),
    brightWhite: s.onSurface,
  };
}

/** 一套色板 → Ceteris 的界面 token 和终端配色。 */
export function legadoLook(scheme: LegadoScheme, dark: boolean): LegadoLook {
  const tokens = tokensFor(scheme, dark);
  const terminal = terminalFor(
    scheme,
    tokens['--color-bg-primary']!,
    tokens['--color-text-muted']!,
    dark,
  );
  return { tokens, terminal };
}

/** 一个主题的 [data-theme] CSS 块,固定主题的生成脚本和实时主题共用。 */
export function legadoCssBlock(id: string, tokens: Record<string, string>, dark: boolean): string {
  const lines = Object.entries(tokens).map(([k, v]) => `  ${k}: ${v};`);
  if (!dark) lines.push('', '  color-scheme: light;');
  return `[data-theme='${id}'] {\n${lines.join('\n')}\n}\n`;
}
