/**
 * @file scripts/gen-legado-themes.mjs
 * @purpose 从 HapeLee/legado-with-MD3 的配色源文件生成 Legado MD3 主题系列:
 *   src/shared/legado-themes.ts(色板 + 终端配色)和 src/renderer/styles/legado-themes.css。
 *
 * 用法:
 *   1. 把 app/src/main/java/io/legado/app/ui/theme/colorScheme/*ColorScheme.kt 下载到一个目录,
 *      例如 gh api repos/HapeLee/legado-with-MD3/contents/<路径> -H "Accept: application/vnd.github.raw"
 *   2. node scripts/gen-legado-themes.mjs <kt 目录> <仓库根目录>
 *   3. npx prettier --write 两个输出文件,再跑 npx vitest run src/shared/legado-themes.test.ts
 *
 * 角色对应关系写在生成的 CSS 头注释里;改对应关系时同步改 legado-themes.test.ts 的角色表。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [ktDir, root] = process.argv.slice(2);

// Order and names follow Legado's themes_item array (English + zh-rCN).
const SCHEMES = [
  ['sora', 'Sora', 'Clear Sky', '晴空'],
  ['gr', 'GR', 'Grassland', '草野'],
  ['lemon', 'Lemon', 'Lemon', '柠檬'],
  ['wh', 'WH', 'Black & White', '黑白'],
  ['elink', 'Elink', 'E-ink', '电子书'],
  ['august', 'August', 'August', '八月'],
  ['carlotta', 'Carlotta', 'New Wave', '新浪潮'],
  ['koharu', 'Koharu', 'Spring', '春'],
  ['yuuka', 'Yuuka', 'Millennium', '千禧年'],
  ['phoebe', 'Phoebe', 'Hidden Sea', '隐海修会'],
  ['mujika', 'Mujika', 'Band', '乐队'],
];

const ROLES = [
  'primary', 'onPrimary', 'primaryContainer', 'onPrimaryContainer',
  'secondary', 'onSecondary', 'secondaryContainer', 'onSecondaryContainer',
  'tertiary', 'tertiaryContainer',
  'error', 'onError', 'errorContainer',
  'background', 'surface', 'onSurface', 'surfaceVariant', 'onSurfaceVariant',
  'outline', 'outlineVariant', 'inverseSurface', 'inverseOnSurface', 'inversePrimary',
  'surfaceContainerLowest', 'surfaceContainerLow', 'surfaceContainer',
  'surfaceContainerHigh', 'surfaceContainerHighest',
];

function parseBlock(src, name) {
  const start = src.indexOf(`val ${name} =`);
  const end = src.indexOf('\n    )', start);
  const block = src.slice(start, end);
  const out = {};
  for (const [, role, argb] of block.matchAll(/(\w+) = Color\(0x([0-9A-Fa-f]{8})\)/g)) {
    if (argb.slice(0, 2).toUpperCase() !== 'FF') throw new Error(`${name} ${role} not opaque`);
    out[role] = `#${argb.slice(2).toLowerCase()}`;
  }
  for (const r of ROLES) if (!out[r]) throw new Error(`missing ${r} in ${name}`);
  return Object.fromEntries(ROLES.map((r) => [r, out[r]]));
}

// ── colour maths (same formulas as the tests) ──
const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const hex = (c) => `#${c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;
function lum(h) {
  const [r, g, b] = rgb(h).map((v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a, b) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const mix = (a, b, w) => {
  const [ca, cb] = [rgb(a), rgb(b)];
  return hex(ca.map((v, i) => Math.round((v * w + cb[i] * (100 - w)) / 100)));
};
function toHsl(h) {
  let [r, g, b] = rgb(h).map((v) => v / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let hh = 0, s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    hh = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    hh /= 6;
  }
  return [hh, s, l];
}
function fromHsl(hh, s, l) {
  const f = (p, q, t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  if (s === 0) return hex([l * 255, l * 255, l * 255]);
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return hex([f(p, q, hh + 1 / 3), f(p, q, hh), f(p, q, hh - 1 / 3)].map((v) => v * 255));
}
/** Move a colour's lightness away from the backgrounds until it reaches `target` on all of them. */
function readable(base, bgs, dark, target = 4.6) {
  let [hh, s, l] = toHsl(base);
  for (let i = 0; i < 200; i++) {
    const c = fromHsl(hh, s, l);
    if (bgs.every((bg) => contrast(c, bg) >= target)) return c;
    l = dark ? Math.min(1, l + 0.005) : Math.max(0, l - 0.005);
  }
  throw new Error(`cannot make ${base} readable`);
}
/** Shift lightness by delta (bright ANSI variants). */
function shift(c, delta) {
  const [hh, s, l] = toHsl(c);
  return fromHsl(hh, s, Math.max(0, Math.min(1, l + delta)));
}

// Hue seeds for colours an MD3 scheme does not have. Light seeds are MD3 tone 40,
// dark seeds tone 80; readable() then fixes contrast against this scheme's surfaces.
const SEEDS = {
  light: { green: '#3a6a1f', yellow: '#735c00', blue: '#3a5ba9', magenta: '#8b3f88', cyan: '#00687a', warning: '#7a5900', success: '#1f6c35', info: '#2a5db0' },
  dark: { green: '#9fd68b', yellow: '#e2c55c', blue: '#adc6ff', magenta: '#f7adef', cyan: '#82d2e6', warning: '#e9c46a', success: '#8bd6a3', info: '#a8c8ff' },
};

function tokensFor(s, dark) {
  const bgPrimary = s.surfaceContainerLow; // tab page = Legado card container
  const bgSecondary = s.background; // frame = Legado page background / top bar / nav bar
  const menu = s.surfaceContainer; // menus and dialogs = Legado dialog / floating bar
  const surfaces = [bgPrimary, bgSecondary];
  const statusBgs = [bgPrimary, bgSecondary, menu];
  const seeds = dark ? SEEDS.dark : SEEDS.light;

  let muted = s.outline;
  for (let w = 0; w <= 100 && !statusBgs.every((bg) => contrast(muted, bg) >= 4.5); w += 5) {
    muted = mix(s.onSurfaceVariant, s.outline, w);
  }

  const hover = (fg, bg) => mix(fg, bg, 8);
  // Accent and error text also appear in menus and on hover backgrounds, not only on the page.
  const textBgs = [...surfaces, menu, s.surfaceContainerHigh];
  const weightFor = (color) => {
    for (let w = 100; w >= 0; w -= 10) {
      const text = mix(color, s.onSurface, w);
      if (textBgs.every((bg) => contrast(text, bg) >= 4.5 && contrast(text, hover(text, bg)) >= 4.5)) return w;
    }
    return 0;
  };

  // Elink's selected grey #808080 carries white text at 3.95:1. Only when the scheme fails
  // AA, darken or lighten the container away from the text and use onSurface on it.
  let selected = s.secondaryContainer;
  let onSelected = s.onSecondaryContainer;
  if (contrast(onSelected, selected) < 4.5 || contrast(s.onSurface, selected) < 4.5) {
    selected = readable(selected, [s.onSurface], !dark);
    onSelected = s.onSurface;
  }

  const t = {
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

function terminalFor(s, t, dark) {
  const bg = t['--color-bg-primary'];
  const seeds = dark ? SEEDS.dark : SEEDS.light;
  const r = (c) => readable(c, [bg], dark);
  const brighter = (c) => r(shift(c, dark ? 0.08 : -0.08));
  const red = r(s.error);
  const green = r(seeds.green);
  const yellow = r(seeds.yellow);
  const blue = r(seeds.blue);
  const magenta = r(seeds.magenta);
  const cyan = r(seeds.cyan);
  // primaryContainer first; e-ink schemes make it equal to the page, so fall through.
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
    red, green, yellow, blue, magenta, cyan,
    white: dark ? s.onSurfaceVariant : r(s.onSurfaceVariant),
    brightBlack: t['--color-text-muted'],
    brightRed: brighter(red),
    brightGreen: brighter(green),
    brightYellow: brighter(yellow),
    brightBlue: brighter(blue),
    brightMagenta: brighter(magenta),
    brightCyan: brighter(cyan),
    brightWhite: s.onSurface,
  };
}

const themes = [];
for (const [key, file, label, note] of SCHEMES) {
  const src = readFileSync(join(ktDir, `${file}ColorScheme.kt`), 'utf8');
  for (const dark of [false, true]) {
    const scheme = parseBlock(src, dark ? 'darkScheme' : 'lightScheme');
    const tokens = tokensFor(scheme, dark);
    themes.push({
      id: `legado-md3-${key}${dark ? '-dark' : ''}`,
      key,
      file,
      label: dark ? `${label} Dark` : label,
      note,
      dark,
      scheme,
      tokens,
      terminal: terminalFor(scheme, tokens, dark),
    });
  }
}

// ── CSS ──
const css = [];
css.push(`/*
 * @file legado-themes.css
 * @purpose Legado MD3 主题系列:配色取自 HapeLee/legado-with-MD3(阅读 3.0 的 Material 3 重制版)
 *   app/src/main/java/io/legado/app/ui/theme/colorScheme/*ColorScheme.kt,11 套配色各有浅色和深色。
 *
 * @关键设计:
 * - 由生成脚本从 Kotlin 源文件写出,色值不手调。MD3 角色到 Ceteris token 的对应关系按 Legado
 *   自己给组件上色的方式(ThemeColorSchemeOverride.kt、ThemeComponents.kt、ui/widget/components):
 *   · 外框(侧栏、标题栏、设置页外层)= background:Legado 的页面底色,顶栏和底栏也是它,不加色调。
 *   · 标签页和终端 = surfaceContainerLow:Legado 的卡片底色(cardContainer),内容放在卡片里。
 *   · 菜单、对话框、搜索条 = surfaceContainer:Legado 的 AppAlertDialog 和悬浮底栏。
 *   · 选中行、选中 chip = secondaryContainer / onSecondaryContainer:同 SelectionItemCard、ToggleChip。
 *   · 悬停底 = surfaceContainerHigh(Legado 输入框底色),按下和开关轨道 = surfaceContainerHighest。
 *   · 正文 onSurface,次要文字 onSurfaceVariant,描边 outline / outlineVariant(SplicedColumnGroup 的卡片边框)。
 *   · 标签页指示条、主按钮、焦点 = primary。
 * - MD3 色板没有的颜色(warning / success / info)用固定色相按本主题底色调到 4.5:1。
 *   --color-text-muted 先取 outline,不够 4.5:1 时向 onSurfaceVariant 混合。
 * - --md-*-text-weight 含义见 material.css 第 2 节末尾,只在需要时写。
 * - 唯一偏离源色板的地方:Elink 的选中灰 #808080 上白字只有 3.95:1,这两套把选中底按正文色调到
 *   4.5:1,文字改用 onSurface。
 * - 不收 Transparent 配色:它要配背景图才成立。
 *
 * @加载顺序:必须在 material.css 之后,这里的 --md-* 才能覆写 material.css 的推导值。
 *
 * 终端配色和 MD3 原始色板在 src/shared/legado-themes.ts,src/shared/legado-themes.test.ts
 * 核对两边一致和对比度。
 *
 * @对应文档章节:软件定义书.md 5.1.9 节
 */
`);
for (const th of themes) {
  css.push(`/* ${th.label} (${th.file}${th.dark ? ' dark' : ''}, ${th.note}) */`);
  css.push(`[data-theme='${th.id}'] {`);
  for (const [k, v] of Object.entries(th.tokens)) css.push(`  ${k}: ${v};`);
  if (!th.dark) css.push('', '  color-scheme: light;');
  css.push('}', '');
}
css.push(
  '/* 页面里的卡片和按钮用 surfaceContainer,同 Legado 的 ToggleChip、悬浮底栏和对话框:浅色比页面深一级,',
  '   深色比页面亮一级。material.css 给它们的是外框色,在这套分工下会比页面还浅。',
  '   hover 规则带 :hover:not(:disabled),特异性更高,不受影响。 */',
  "[data-theme^='legado-md3-'] .template-button,",
  "[data-theme^='legado-md3-'] .settings-theme-list,",
  "[data-theme^='legado-md3-'] .template-list-item {",
  '  background-color: var(--md-surface-container-high, #f0f);',
  '}',
  '',
);
writeFileSync(join(root, 'src/renderer/styles/legado-themes.css'), css.join('\n'));

// ── TS ──
const q = (v) => `'${v}'`;
const ts = [];
ts.push(`/**
 * @file src/shared/legado-themes.ts
 * @purpose Legado MD3 主题系列的清单、MD3 原始色板和终端配色。
 *
 * @关键设计:
 * - 色板逐字取自 HapeLee/legado-with-MD3 的 ui/theme/colorScheme/*ColorScheme.kt(lightScheme /
 *   darkScheme),名字取自它的 themes_item 数组(英文 + 简体中文)。
 * - 界面配色在 src/renderer/styles/legado-themes.css,由同一生成脚本写出;角色对应关系写在那个文件
 *   的头注释里。legado-themes.test.ts 核对 CSS 与这里的色板一致。
 * - 终端:底色 = surfaceContainerLow(与标签页同色),正文 onSurface,光标 primary,选区
 *   primaryContainer。ANSI 色:red 取 error,其余按固定色相调到在底色上 >= 4.5:1,
 *   bright 版本在浅色主题里更深、深色主题里更亮。
 * - 放在 shared 而不是 TerminalView:settings-manager 要校验 ID,vitest 也只收集 shared/main。
 *
 * @对应文档章节:软件定义书.md 5.1.9
 */
import type { TerminalPalette } from './beamer-themes';

/** Legado 的 MD3 颜色角色,只收 Ceteris 用到的。 */
export interface LegadoScheme {
${ROLES.map((r) => `  ${r}: string;`).join('\n')}
}

export const LEGADO_THEME_IDS = [
${themes.map((t) => `  ${q(t.id)},`).join('\n')}
] as const;

export type LegadoThemeId = (typeof LEGADO_THEME_IDS)[number];

export interface LegadoTheme {
  id: LegadoThemeId;
  /** 菜单里的英文名,深色版本带 Dark */
  label: string;
  /** Legado 里的中文名 */
  note: string;
  dark: boolean;
  scheme: LegadoScheme;
  terminal: TerminalPalette;
}

export const LEGADO_THEMES: LegadoTheme[] = [
`);
for (const th of themes) {
  ts.push(`  // ${th.file}ColorScheme.kt ${th.dark ? 'darkScheme' : 'lightScheme'}`);
  ts.push('  {');
  ts.push(`    id: ${q(th.id)},`);
  ts.push(`    label: ${q(th.label)},`);
  ts.push(`    note: ${q(th.note)},`);
  ts.push(`    dark: ${th.dark},`);
  ts.push('    scheme: {');
  for (const [k, v] of Object.entries(th.scheme)) ts.push(`      ${k}: ${q(v)},`);
  ts.push('    },');
  ts.push('    terminal: {');
  for (const [k, v] of Object.entries(th.terminal)) ts.push(`      ${k}: ${q(v)},`);
  ts.push('    },');
  ts.push('  },');
}
ts.push('];', '');
writeFileSync(join(root, 'src/shared/legado-themes.ts'), ts.join('\n'));
console.log(themes.map((t) => `${t.id} muted=${t.tokens['--color-text-muted']} pw=${t.tokens['--md-primary-text-weight'] ?? '-'} ew=${t.tokens['--md-error-text-weight'] ?? '-'} sel=${t.terminal.selectionBackground}`).join('\n'));
