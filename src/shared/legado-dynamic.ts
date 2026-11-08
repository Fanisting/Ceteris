/**
 * @file src/shared/legado-dynamic.ts
 * @purpose Legado MD3 的实时主题(ADR-030):用一个种子色、一种调色风格和一档对比度生成 MD3 色板,
 *   对应 legado-with-MD3 的"自定义"主题和"动态取色"。
 *
 * @关键设计:
 * - 四个主题 id:legado-md3-seed[-dark] 用设置里的种子色;legado-md3-accent[-dark] 用 Windows
 *   强调色作种子(Legado 在 Android 上取壁纸色,桌面上对应的是系统强调色)。两者共用风格和对比度。
 * - 色板由 Google 的 @material/material-color-utilities 生成,和 Legado 用的 materialkolor 同一套
 *   算法。风格列表和对比度档位照 Legado 的 ThemeResolver:九种风格,对比度 0 / 0.5 / 1。
 *   规范版本用 2021,与 22 款固定配色一致。
 * - 生成出的色板交给 legado-palette.ts,换算规则和固定主题完全相同。
 * - 这个文件不被 main 进程加载:那个包只有 ESM,main 只需要 LEGADO_DYNAMIC_THEME_IDS 做校验,
 *   所以 id 和设置枚举放在 legado-dynamic-ids.ts。
 *
 * @不要在这里做的事:
 * - 不要读设置或注入 CSS(那是 src/renderer/legado-dynamic.ts 的事)
 *
 * @对应文档章节:软件定义书.md 5.1.9、ADR-030
 */
import {
  argbFromHex,
  hexFromArgb,
  Hct,
  MaterialDynamicColors,
  SchemeContent,
  SchemeExpressive,
  SchemeFidelity,
  SchemeFruitSalad,
  SchemeMonochrome,
  SchemeNeutral,
  SchemeRainbow,
  SchemeTonalSpot,
  SchemeVibrant,
  type DynamicColor,
  type DynamicScheme,
} from '@material/material-color-utilities';
import { LEGADO_ROLES, type LegadoScheme } from './legado-palette';
import {
  LEGADO_CONTRAST_LEVELS,
  type LegadoContrast,
  type LegadoPaletteStyle,
} from './legado-dynamic-ids';

type SchemeCtor = new (source: Hct, isDark: boolean, contrastLevel: number) => DynamicScheme;

const SCHEME_CLASSES: Record<LegadoPaletteStyle, SchemeCtor> = {
  tonalSpot: SchemeTonalSpot,
  neutral: SchemeNeutral,
  vibrant: SchemeVibrant,
  expressive: SchemeExpressive,
  rainbow: SchemeRainbow,
  fruitSalad: SchemeFruitSalad,
  monochrome: SchemeMonochrome,
  fidelity: SchemeFidelity,
  content: SchemeContent,
};

/**
 * 用种子色生成一套 Legado 色板。
 *
 * @param seedHex '#rrggbb';格式不对时调用方应先回退到默认种子(设置校验已保证格式)
 * @param style 调色风格,同 Legado 的 paletteStyle
 * @param contrast 对比度档位
 * @param dark 生成深色还是浅色
 */
export function generateLegadoScheme(
  seedHex: string,
  style: LegadoPaletteStyle,
  contrast: LegadoContrast,
  dark: boolean,
): LegadoScheme {
  const Ctor = SCHEME_CLASSES[style] ?? SchemeTonalSpot;
  const level = LEGADO_CONTRAST_LEVELS[contrast] ?? 0;
  const scheme = new Ctor(Hct.fromInt(argbFromHex(seedHex)), dark, level);
  const colors = MaterialDynamicColors as unknown as Record<string, DynamicColor>;
  const out = {} as LegadoScheme;
  for (const role of LEGADO_ROLES) {
    out[role] = hexFromArgb(colors[role]!.getArgb(scheme)).toLowerCase();
  }
  return out;
}
