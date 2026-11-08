/**
 * @file src/shared/legado-dynamic-ids.ts
 * @purpose Legado MD3 实时主题(ADR-030)的 id、设置枚举和默认值。
 *
 * @关键设计:
 * - 与 legado-dynamic.ts 分开:main 进程要用这些做设置校验,但不能加载只有 ESM 的
 *   @material/material-color-utilities。
 *
 * @对应文档章节:软件定义书.md 5.1.9、ADR-030
 */

export const LEGADO_DYNAMIC_THEME_IDS = [
  'legado-md3-seed',
  'legado-md3-seed-dark',
  'legado-md3-accent',
  'legado-md3-accent-dark',
] as const;

export type LegadoDynamicThemeId = (typeof LEGADO_DYNAMIC_THEME_IDS)[number];

/** Legado ThemeResolver 的九种调色风格,顺序同它的设置列表。 */
export const LEGADO_PALETTE_STYLES = [
  'tonalSpot',
  'neutral',
  'vibrant',
  'expressive',
  'rainbow',
  'fruitSalad',
  'monochrome',
  'fidelity',
  'content',
] as const;

export type LegadoPaletteStyle = (typeof LEGADO_PALETTE_STYLES)[number];

/** 对比度档位 → material-color-utilities 的 contrastLevel,同 materialkolor 的 Contrast 枚举。 */
export const LEGADO_CONTRAST_LEVELS = {
  standard: 0,
  medium: 0.5,
  high: 1,
} as const;

export type LegadoContrast = keyof typeof LEGADO_CONTRAST_LEVELS;

/** 没设种子色、或系统读不到强调色时用的种子:Legado 晴空(Sora)的主色。 */
export const LEGADO_DEFAULT_SEED = '#3b608f';

export function isLegadoDynamicThemeId(id: string): id is LegadoDynamicThemeId {
  return (LEGADO_DYNAMIC_THEME_IDS as readonly string[]).includes(id);
}

export function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
}
