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
// 角色分工和终端配色与实时生成的主题共用;Node 22.18+ 的类型擦除可以直接加载 .ts
import { LEGADO_ROLES, legadoCssBlock, legadoLook } from '../src/shared/legado-palette.ts';

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

function parseBlock(src, name) {
  const start = src.indexOf(`val ${name} =`);
  const end = src.indexOf('\n    )', start);
  const block = src.slice(start, end);
  const out = {};
  for (const [, role, argb] of block.matchAll(/(\w+) = Color\(0x([0-9A-Fa-f]{8})\)/g)) {
    if (argb.slice(0, 2).toUpperCase() !== 'FF') throw new Error(`${name} ${role} not opaque`);
    out[role] = `#${argb.slice(2).toLowerCase()}`;
  }
  for (const r of LEGADO_ROLES) if (!out[r]) throw new Error(`missing ${r} in ${name}`);
  return Object.fromEntries(LEGADO_ROLES.map((r) => [r, out[r]]));
}

const themes = [];
for (const [key, file, label, note] of SCHEMES) {
  const src = readFileSync(join(ktDir, `${file}ColorScheme.kt`), 'utf8');
  for (const dark of [false, true]) {
    const scheme = parseBlock(src, dark ? 'darkScheme' : 'lightScheme');
    const { tokens, terminal } = legadoLook(scheme, dark);
    themes.push({
      id: `legado-md3-${key}${dark ? '-dark' : ''}`,
      key,
      file,
      label: dark ? `${label} Dark` : label,
      note,
      dark,
      scheme,
      tokens,
      terminal,
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
 * @致谢:Legado MD3 主题使用 legado-with-MD3 的配色方案,https://github.com/HapeLee/legado-with-MD3
 *   (GPL-3.0,Legado 的分支)。这里只取色值,README 的致谢一节也有记载。
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
  css.push(legadoCssBlock(th.id, th.tokens, th.dark));
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
 * @致谢:Legado MD3 主题使用 legado-with-MD3 的配色方案,https://github.com/HapeLee/legado-with-MD3
 *   (GPL-3.0,Legado 的分支)。这里只取色值,README 的致谢一节也有记载。
 *
 * @关键设计:
 * - 色板逐字取自 HapeLee/legado-with-MD3 的 ui/theme/colorScheme/*ColorScheme.kt(lightScheme /
 *   darkScheme),名字取自它的 themes_item 数组(英文 + 简体中文)。
 * - 界面配色在 src/renderer/styles/legado-themes.css,由同一生成脚本写出;角色对应关系写在那个文件
 *   的头注释里。legado-themes.test.ts 核对 CSS 与这里的色板一致。
 * - 界面 token 和终端配色由 legado-palette.ts 从色板算出,用种子色实时生成的主题也用它。
 * - 终端:底色 = surfaceContainerLow(与标签页同色),正文 onSurface,光标 primary,选区
 *   primaryContainer。ANSI 色从固定色相起步(红色是 MD3 标准 error 色),调到在底色上 >= 4.5:1;
 *   浅色主题 bright 更深,深色主题普通色取 tone 70、bright 取 tone 80。规则在 legado-palette.ts。
 * - 放在 shared 而不是 TerminalView:settings-manager 要校验 ID,vitest 也只收集 shared/main。
 *
 * @对应文档章节:软件定义书.md 5.1.9
 */
import type { TerminalPalette } from './beamer-themes';
import type { LegadoScheme } from './legado-palette';

export type { LegadoScheme };

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
