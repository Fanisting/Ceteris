/**
 * @file src/shared/pili-scheme.ts
 * @purpose Pili 主题系列(ADR-031)的种子色清单和色板生成:照 PiliPlus 的默认配色算法,从一个种子色
 *   生成一套 Material 3 色板。
 *
 * @致谢:Pili 主题照 PiliPlus(https://github.com/bggRGjQaUbCoE/PiliPlus,GPL-3.0,第三方 B 站客户端)
 *   的主题色列表和配色算法生成。这里只取种子色和算法,README 的致谢一节也有记载。
 *
 * @关键设计:
 * - 种子色逐字取自 PiliPlus 的 lib/models/common/theme/theme_color_type.dart(colorThemeTypes):
 *   默认绿 #5cb67b、B 站粉 #ff7299,其余 17 个是 Flutter Colors.* 的 500 号色。名字取它的中文标签。
 * - 算法照 PiliPlus 的默认设置:flex_seed_scheme 的 `SeedColorScheme.fromSeeds(primaryKey: seed,
 *   variant: material3Legacy, useExpressiveOnContainerColors: false)`。material3Legacy 就是
 *   Flutter 3.19 之前的 `ColorScheme.fromSeed`:
 *   · 五条色阶(FlexCorePalette.fromSeeds):primary 取种子色相、色度固定 48(不管种子本身多灰);
 *     secondary 同色相色度 16;tertiary 色相 +60° 色度 24;neutral 色度 4;neutralVariant 色度 8;
 *     error 固定色相 25 色度 84。色阶由 HCT 的 Hct.from(hue, chroma, tone) 取色,
 *     与 @material/material-color-utilities 的 TonalPalette 相同。
 *   · 色调表(FlexTones.light / dark 的默认值,只有 surface 改成 99 / 10):见下面 LIGHT / DARK。
 *   · 灰色种子(Colors.grey)的色度也被抬到 48,所以"灰色"主题的主色其实带色相,PiliPlus 里也如此。
 * - 深色主题的 surfaceContainerLow 不是色调 10,而是 PiliPlus 卡片实际画出的颜色:它给深色模式的
 *   Card 设了 surfaceTintColor = onSurfaceVariant,elevation 1 叠 5% 的色调层(Flutter 的
 *   ElevationOverlay.applySurfaceTint),页面(色调 10)和卡片才分得开。Ceteris 用这个角色做标签页
 *   和终端底色,所以把卡片色放在这里。浅色没有色调层,就是色调 96。
 * - 其余角色到界面 token 的换算与 Legado MD3 系列共用 legado-palette.ts(外框 = surface,
 *   标签页 = surfaceContainerLow,菜单 = surfaceContainer),PiliPlus 给顶栏、导航栏和页面的也是
 *   surface,菜单是 surfaceContainer,所以不另写一套分工。
 * - 这个文件依赖只有 ESM 的 @material/material-color-utilities,main 进程不加载它:固定主题已由
 *   scripts/gen-pili-themes.mts 生成到 pili-themes.ts,settings-manager 只用那里的 id 列表。
 *
 * @不要在这里做的事:
 * - 不要在这里换算界面 token(那是 legado-palette.ts 的事)
 *
 * @对应文档章节:软件定义书.md 5.1.9、ADR-031
 */
import { argbFromHex, Hct, hexFromArgb, TonalPalette } from '@material/material-color-utilities';
import { mix, type LegadoScheme } from './legado-palette';

export interface PiliSeed {
  /** 主题 id 的中段:pili-<key>[-dark] */
  key: string;
  /** 菜单里的英文名 */
  label: string;
  /** PiliPlus 里的中文标签 */
  note: string;
  /** 种子色 '#rrggbb' */
  seed: string;
}

/** PiliPlus colorThemeTypes 的顺序和色值。Flutter Colors.* 取 500 号色。 */
export const PILI_SEEDS: PiliSeed[] = [
  { key: 'default', label: 'Default Green', note: '默认绿', seed: '#5cb67b' },
  { key: 'pink', label: 'Pink', note: '粉红色', seed: '#ff7299' },
  { key: 'red', label: 'Red', note: '红色', seed: '#f44336' },
  { key: 'orange', label: 'Orange', note: '橙色', seed: '#ff9800' },
  { key: 'amber', label: 'Amber', note: '琥珀色', seed: '#ffc107' },
  { key: 'yellow', label: 'Yellow', note: '黄色', seed: '#ffeb3b' },
  { key: 'lime', label: 'Lime', note: '酸橙色', seed: '#cddc39' },
  { key: 'light-green', label: 'Light Green', note: '浅绿色', seed: '#8bc34a' },
  { key: 'green', label: 'Green', note: '绿色', seed: '#4caf50' },
  { key: 'teal', label: 'Teal', note: '青色', seed: '#009688' },
  { key: 'cyan', label: 'Cyan', note: '蓝绿色', seed: '#00bcd4' },
  { key: 'light-blue', label: 'Light Blue', note: '浅蓝色', seed: '#03a9f4' },
  { key: 'blue', label: 'Blue', note: '蓝色', seed: '#2196f3' },
  { key: 'indigo', label: 'Indigo', note: '靛蓝色', seed: '#3f51b5' },
  { key: 'purple', label: 'Purple', note: '紫色', seed: '#9c27b0' },
  { key: 'deep-purple', label: 'Deep Purple', note: '深紫色', seed: '#673ab7' },
  { key: 'blue-grey', label: 'Blue Grey', note: '蓝灰色', seed: '#607d8b' },
  { key: 'brown', label: 'Brown', note: '棕色', seed: '#795548' },
  { key: 'grey', label: 'Grey', note: '灰色', seed: '#9e9e9e' },
];

/** 五条色阶的色度,flex_seed_scheme FlexTones.material3Legacy。 */
const CHROMA = { primary: 48, secondary: 16, tertiary: 24, neutral: 4, neutralVariant: 8 };
const ERROR_HUE = 25;
const ERROR_CHROMA = 84;
const TERTIARY_HUE_ROTATION = 60;

/** Flutter 深色 Card 在 elevation 1 叠的色调层不透明度(ElevationOverlay 的第 1 级)。 */
export const PILI_DARK_CARD_TINT = 5;

type Tones = Record<keyof LegadoScheme, number>;

/** FlexTones.light 默认色调,surface 改 99(material3Legacy)。 */
const LIGHT: Tones = {
  primary: 40,
  onPrimary: 100,
  primaryContainer: 90,
  onPrimaryContainer: 10,
  secondary: 40,
  onSecondary: 100,
  secondaryContainer: 90,
  onSecondaryContainer: 10,
  tertiary: 40,
  tertiaryContainer: 90,
  error: 40,
  onError: 100,
  errorContainer: 90,
  background: 99,
  surface: 99,
  onSurface: 10,
  surfaceVariant: 90,
  onSurfaceVariant: 30,
  outline: 50,
  outlineVariant: 80,
  inverseSurface: 20,
  inverseOnSurface: 95,
  inversePrimary: 80,
  surfaceContainerLowest: 100,
  surfaceContainerLow: 96,
  surfaceContainer: 94,
  surfaceContainerHigh: 92,
  surfaceContainerHighest: 90,
};

/** FlexTones.dark 默认色调,surface 改 10(material3Legacy)。 */
const DARK: Tones = {
  primary: 80,
  onPrimary: 20,
  primaryContainer: 30,
  onPrimaryContainer: 90,
  secondary: 80,
  onSecondary: 20,
  secondaryContainer: 30,
  onSecondaryContainer: 90,
  tertiary: 80,
  tertiaryContainer: 30,
  error: 80,
  onError: 20,
  errorContainer: 30,
  background: 10,
  surface: 10,
  onSurface: 90,
  surfaceVariant: 30,
  onSurfaceVariant: 80,
  outline: 60,
  outlineVariant: 30,
  inverseSurface: 90,
  inverseOnSurface: 20,
  inversePrimary: 40,
  surfaceContainerLowest: 4,
  surfaceContainerLow: 10,
  surfaceContainer: 12,
  surfaceContainerHigh: 17,
  surfaceContainerHighest: 22,
};

/** 每个角色取哪条色阶,同 flex_seed_scheme 组装 ColorScheme 的方式。 */
const PALETTE_OF: Record<keyof LegadoScheme, keyof typeof CHROMA | 'error'> = {
  primary: 'primary',
  onPrimary: 'primary',
  primaryContainer: 'primary',
  onPrimaryContainer: 'primary',
  inversePrimary: 'primary',
  secondary: 'secondary',
  onSecondary: 'secondary',
  secondaryContainer: 'secondary',
  onSecondaryContainer: 'secondary',
  tertiary: 'tertiary',
  tertiaryContainer: 'tertiary',
  error: 'error',
  onError: 'error',
  errorContainer: 'error',
  background: 'neutral',
  surface: 'neutral',
  onSurface: 'neutral',
  inverseSurface: 'neutral',
  inverseOnSurface: 'neutral',
  surfaceContainerLowest: 'neutral',
  surfaceContainerLow: 'neutral',
  surfaceContainer: 'neutral',
  surfaceContainerHigh: 'neutral',
  surfaceContainerHighest: 'neutral',
  surfaceVariant: 'neutralVariant',
  onSurfaceVariant: 'neutralVariant',
  outline: 'neutralVariant',
  outlineVariant: 'neutralVariant',
};

/**
 * 用一个种子色生成 PiliPlus 默认算法下的 MD3 色板。
 *
 * @param seedHex '#rrggbb'
 * @param dark 深色还是浅色
 * @returns 色板;深色的 surfaceContainerLow 是卡片实际颜色(见文件头)
 * @throws 种子色不是 6 位十六进制时 argbFromHex 抛错;调用方(生成脚本和单测)传的都是常量
 */
export function generatePiliScheme(seedHex: string, dark: boolean): LegadoScheme {
  const seed = Hct.fromInt(argbFromHex(seedHex));
  const hue = seed.hue;
  const palettes = {
    primary: TonalPalette.fromHueAndChroma(hue, CHROMA.primary),
    secondary: TonalPalette.fromHueAndChroma(hue, CHROMA.secondary),
    tertiary: TonalPalette.fromHueAndChroma((hue + TERTIARY_HUE_ROTATION) % 360, CHROMA.tertiary),
    neutral: TonalPalette.fromHueAndChroma(hue, CHROMA.neutral),
    neutralVariant: TonalPalette.fromHueAndChroma(hue, CHROMA.neutralVariant),
    error: TonalPalette.fromHueAndChroma(ERROR_HUE, ERROR_CHROMA),
  };
  const tones = dark ? DARK : LIGHT;
  const out = {} as LegadoScheme;
  for (const role of Object.keys(PALETTE_OF) as Array<keyof LegadoScheme>) {
    out[role] = hexFromArgb(palettes[PALETTE_OF[role]].tone(tones[role])).toLowerCase();
  }
  if (dark) {
    out.surfaceContainerLow = mix(
      out.onSurfaceVariant,
      out.surfaceContainerLow,
      PILI_DARK_CARD_TINT,
    );
  }
  return out;
}
