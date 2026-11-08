/**
 * @file src/renderer/celebration-style.ts
 * @purpose 按主题选小庆祝的样式(ADR-027)。可爱主题撒爱心,Rose Pine 和梅子飘花瓣,
 *   珍珠主题泛一圈光,Business 和 Windows Terminal 只亮一个朴素的对勾,其余主题撒星星。
 *
 * @关键设计:
 * - 用户自定义主题(ADR-026)的 id 不在表里,落到默认的星星。
 * - 珍珠主题按前缀 pearl- 认,以后加新的珍珠色不用改这里。
 *
 * @不要在这里做的事:
 * - 不要读设置或 DOM,这里只做 id 到样式的映射
 */

export type CelebrationStyle = 'sparkle' | 'heart' | 'petal' | 'shimmer' | 'check';

const BY_THEME: Readonly<Record<string, CelebrationStyle>> = {
  cutie: 'heart',
  'light-pink': 'heart',
  fairyfloss: 'heart',
  'rose-pine': 'petal',
  'rose-pine-dawn': 'petal',
  'rose-pine-moon': 'petal',
  meizi: 'petal',
  business: 'check',
  'windows-terminal': 'check',
};

/** 主题 id → 小庆祝样式;未知主题(含自定义主题)用星星。 */
export function celebrationStyleFor(themeId: string | undefined): CelebrationStyle {
  if (!themeId) return 'sparkle';
  if (themeId.startsWith('pearl-')) return 'shimmer';
  return BY_THEME[themeId] ?? 'sparkle';
}
