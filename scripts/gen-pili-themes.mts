/**
 * @file scripts/gen-pili-themes.mts
 * @purpose 生成 Pili 主题系列(ADR-031):src/shared/pili-themes.ts(色板 + 终端配色)和
 *   src/renderer/styles/pili-themes.css。种子色和算法在 src/shared/pili-scheme.ts,
 *   角色分工和终端配色与 Legado MD3 系列共用 src/shared/legado-palette.ts。
 *
 * 用法(在仓库根目录):
 *   npx vite-node scripts/gen-pili-themes.mts
 *   npx prettier --write src/shared/pili-themes.ts src/renderer/styles/pili-themes.css
 *   npx vitest run src/shared/pili-themes.test.ts
 *
 * 用 vite-node 而不是 node:@material/material-color-utilities 0.4.0 的内部 import 缺 .js 扩展名,
 * Node 的 ESM 加载器找不到,Vite 的解析器能补上(vitest.config.ts 同理用 server.deps.inline)。
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { legadoCssBlock, legadoLook } from '../src/shared/legado-palette';
import { PILI_SEEDS, generatePiliScheme } from '../src/shared/pili-scheme';

const root = resolve(import.meta.dirname ?? '.', '..');

const themes = PILI_SEEDS.flatMap((s) =>
  [false, true].map((dark) => {
    const scheme = generatePiliScheme(s.seed, dark);
    const { tokens, terminal } = legadoLook(scheme, dark);
    return {
      id: `pili-${s.key}${dark ? '-dark' : ''}`,
      label: dark ? `${s.label} Dark` : s.label,
      note: s.note,
      seed: s.seed,
      dark,
      scheme,
      tokens,
      terminal,
    };
  }),
);

// ── CSS ──
const css: string[] = [];
css.push(`/*
 * @file pili-themes.css
 * @purpose Pili 主题系列(ADR-031):照第三方 B 站客户端 PiliPlus 的主题色列表和默认配色算法生成,
 *   19 个种子色各有浅色和深色。
 *
 * @致谢:Pili 主题照 PiliPlus(https://github.com/bggRGjQaUbCoE/PiliPlus,GPL-3.0)的
 *   colorThemeTypes 种子色和 material3Legacy 配色算法生成。这里只取色值,README 的致谢一节也有记载。
 *
 * @关键设计:
 * - 由 scripts/gen-pili-themes.mts 写出,色值不手调。色板算法在 src/shared/pili-scheme.ts:
 *   主色色度固定 48,浅色页面是色调 99、深色是色调 10,比 Legado 的手调色板更鲜艳、更白。
 * - MD3 角色到 Ceteris token 的对应关系与 legado-themes.css 相同(legado-palette.ts),因为 PiliPlus
 *   给顶栏、导航栏和页面的也都是 surface,菜单是 surfaceContainer,卡片是 surfaceContainerLow:
 *   · 外框(侧栏、标题栏)= surface:PiliPlus 的 AppBar、NavigationRail 和页面底色。
 *   · 标签页和终端 = PiliPlus 的卡片色:浅色是 surfaceContainerLow(色调 96);深色是色调 10 叠 5% 的
 *     onSurfaceVariant,也就是它给深色 Card 设的 elevation 1 色调层。
 *   · 菜单、对话框 = surfaceContainer:PiliPlus 的 PopupMenu 和底部导航栏。
 *   · 选中行、选中 chip = secondaryContainer / onSecondaryContainer:PiliPlus 的 chip 和 SnackBar。
 *   · 悬停底 = surfaceContainerHigh,按下 = surfaceContainerHighest;正文 onSurface,次要文字
 *     onSurfaceVariant;主色 primary 用作标签页指示条、主按钮、焦点。
 * - MD3 色板没有的颜色(warning / success / info)和终端 ANSI 色的规则见 legado-palette.ts。
 *
 * @加载顺序:必须在 material.css 之后,这里的 --md-* 才能覆写 material.css 的推导值。
 *
 * 终端配色和 MD3 原始色板在 src/shared/pili-themes.ts,src/shared/pili-themes.test.ts
 * 核对两边一致、算法符合 PiliPlus 和对比度。
 *
 * @对应文档章节:软件定义书.md 5.1.9 节、ADR-031
 */
`);
for (const th of themes) {
  css.push(`/* ${th.label} (${th.note}, seed ${th.seed}) */`);
  css.push(legadoCssBlock(th.id, th.tokens, th.dark));
}
css.push(
  '/* 页面里的卡片和按钮用 surfaceContainer,同 legado-themes.css 末尾的规则:浅色比页面深一级,',
  '   深色比页面亮一级。material.css 给它们的是外框色,在这套分工下会比页面还浅。 */',
  "[data-theme^='pili-'] .template-button,",
  "[data-theme^='pili-'] .settings-theme-list,",
  "[data-theme^='pili-'] .template-list-item {",
  '  background-color: var(--md-surface-container-high, #f0f);',
  '}',
  '',
);
writeFileSync(resolve(root, 'src/renderer/styles/pili-themes.css'), css.join('\n'));

// ── TS ──
const q = (v: string): string => `'${v}'`;
const ts: string[] = [];
ts.push(`/**
 * @file src/shared/pili-themes.ts
 * @purpose Pili 主题系列(ADR-031)的清单、MD3 色板和终端配色。由 scripts/gen-pili-themes.mts 生成。
 *
 * @致谢:Pili 主题照 PiliPlus(https://github.com/bggRGjQaUbCoE/PiliPlus,GPL-3.0)的主题色列表和
 *   默认配色算法生成。这里只取色值,README 的致谢一节也有记载。
 *
 * @关键设计:
 * - 种子色和算法在 pili-scheme.ts;界面配色在 src/renderer/styles/pili-themes.css,由同一脚本写出;
 *   pili-themes.test.ts 核对 CSS、这里的色板和 pili-scheme.ts 现算的结果三者一致。
 * - 界面 token 和终端配色由 legado-palette.ts 从色板算出,与 Legado MD3 系列同一套规则。
 * - 放在 shared 而不是 TerminalView:settings-manager 要校验 ID,vitest 也只收集 shared/main。
 *   这个文件不依赖 @material/material-color-utilities,main 进程可以加载。
 *
 * @对应文档章节:软件定义书.md 5.1.9、ADR-031
 */
import type { TerminalPalette } from './beamer-themes';
import type { LegadoScheme } from './legado-palette';

export const PILI_THEME_IDS = [
${themes.map((t) => `  ${q(t.id)},`).join('\n')}
] as const;

export type PiliThemeId = (typeof PILI_THEME_IDS)[number];

export interface PiliTheme {
  id: PiliThemeId;
  /** 菜单里的英文名,深色版本带 Dark */
  label: string;
  /** PiliPlus 里的中文标签 */
  note: string;
  /** 种子色 '#rrggbb' */
  seed: string;
  dark: boolean;
  scheme: LegadoScheme;
  terminal: TerminalPalette;
}

export const PILI_THEMES: PiliTheme[] = [
`);
for (const th of themes) {
  ts.push(`  // ${th.note} ${th.seed}${th.dark ? ' dark' : ''}`);
  ts.push('  {');
  ts.push(`    id: ${q(th.id)},`);
  ts.push(`    label: ${q(th.label)},`);
  ts.push(`    note: ${q(th.note)},`);
  ts.push(`    seed: ${q(th.seed)},`);
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
writeFileSync(resolve(root, 'src/shared/pili-themes.ts'), ts.join('\n'));
console.log(
  themes
    .map(
      (t) =>
        `${t.id} page=${t.tokens['--color-bg-primary']} frame=${t.tokens['--color-bg-secondary']} primary=${t.tokens['--md-primary']} muted=${t.tokens['--color-text-muted']} pw=${t.tokens['--md-primary-text-weight'] ?? '-'} sel=${t.terminal.selectionBackground}`,
    )
    .join('\n'),
);
