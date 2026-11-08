/**
 * @file LegadoDynamicControls.tsx
 * @purpose 设置 → 外观里 Legado MD3 实时主题(ADR-030)的控件:种子色、调色风格、对比度。
 *   选中 Custom / Windows Accent 主题时由 SettingsView 显示在主题选择器下面。
 *
 * @关键设计:
 * - 种子色用原生 <input type="color">。拖动时只调 previewLegadoSeed 预览本窗口;选择器关闭
 *   (原生 change 事件)才写设置,同步到所有窗口。没提交就失焦时退回已保存的颜色。
 *   React 的 onChange 在 color 输入上每一下都触发,所以提交用原生 change 监听。
 * - Windows Accent 模式不给颜色选择器,只显示当前强调色;读不到时说明在用默认种子色。
 * - 风格和对比度两种模式共用,同 Legado。风格名用英文(同主题菜单),对比度跟随界面语言。
 *
 * @不要在这里做的事:
 * - 不要直接写设置,通过 onChange 交给 SettingsView 的 updateSettings
 *
 * @对应文档章节:软件定义书.md 5.1.9、ADR-030
 */
import { useEffect, useRef, useState } from 'react';
import {
  LEGADO_CONTRAST_LEVELS,
  LEGADO_PALETTE_STYLES,
  type LegadoContrast,
  type LegadoPaletteStyle,
} from '@shared/legado-dynamic-ids';
import type { Settings } from '@shared/types';
import { previewLegadoSeed, useLegadoDynamic } from '../legado-dynamic';
import { useTranslation } from './LanguageProvider';
import { Check } from './material-symbols';

const STYLE_LABELS: Record<LegadoPaletteStyle, string> = {
  tonalSpot: 'Tonal Spot',
  neutral: 'Neutral',
  vibrant: 'Vibrant',
  expressive: 'Expressive',
  rainbow: 'Rainbow',
  fruitSalad: 'Fruit Salad',
  monochrome: 'Monochrome',
  fidelity: 'Fidelity',
  content: 'Content',
};

type AppearancePatch = Partial<
  Pick<Settings['appearance'], 'legadoSeedColor' | 'legadoPaletteStyle' | 'legadoContrast'>
>;

export function LegadoDynamicControls({
  mode,
  seed,
  style,
  contrast,
  onChange,
}: {
  mode: 'seed' | 'accent';
  seed: string;
  style: LegadoPaletteStyle;
  contrast: LegadoContrast;
  onChange: (patch: AppearancePatch) => void;
}): JSX.Element {
  const { tx } = useTranslation();
  const { accent } = useLegadoDynamic();
  const [draft, setDraft] = useState(seed);
  const committed = useRef(seed);
  const colorRef = useRef<HTMLInputElement | null>(null);

  // 别的窗口改了种子色,或提交后设置回传:草稿跟上
  useEffect(() => {
    committed.current = seed;
    setDraft(seed);
  }, [seed]);

  // 选择器关闭时提交。onChange 用 ref 取最新值,监听只挂一次
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  useEffect(() => {
    const el = colorRef.current;
    if (!el) return;
    const commit = (): void => {
      const value = el.value.toLowerCase();
      if (value === committed.current) return;
      // 先记成已提交:选择器关闭紧跟着失焦时,onBlur 不会把预览退回旧颜色(设置回传要晚一拍)
      committed.current = value;
      onChangeRef.current({ legadoSeedColor: value });
    };
    el.addEventListener('change', commit);
    return () => el.removeEventListener('change', commit);
  }, [mode]);

  // 控件卸载(换主题、关设置页)时撤掉没提交的预览;在选择器里按 Esc 不会触发 change 也不一定失焦
  useEffect(() => () => previewLegadoSeed(committed.current), []);

  const levels = Object.keys(LEGADO_CONTRAST_LEVELS) as LegadoContrast[];
  const levelLabel: Record<LegadoContrast, string> = {
    standard: tx('标准', 'Standard'),
    medium: tx('中', 'Medium'),
    high: tx('高', 'High'),
  };

  return (
    <div className="legado-controls">
      {mode === 'seed' ? (
        <label className="legado-controls-row">
          <span className="legado-controls-label">{tx('种子色', 'Seed colour')}</span>
          <input
            ref={colorRef}
            type="color"
            className="legado-seed-input"
            value={draft}
            onChange={(e) => {
              const value = e.target.value.toLowerCase();
              setDraft(value);
              previewLegadoSeed(value);
            }}
            onBlur={() => {
              // 没提交就离开:退回已保存的颜色,预览不留在本窗口
              if (colorRef.current?.value.toLowerCase() === committed.current) return;
              setDraft(committed.current);
              previewLegadoSeed(committed.current);
            }}
          />
          <code className="legado-controls-hex">{draft}</code>
        </label>
      ) : (
        <div className="legado-controls-row">
          <span className="legado-controls-label">{tx('强调色', 'Accent colour')}</span>
          {accent ? (
            <>
              <span className="legado-accent-dot" style={{ backgroundColor: accent }} />
              <code className="legado-controls-hex">{accent}</code>
            </>
          ) : (
            <span className="legado-controls-note">
              {tx(
                '读不到系统强调色,正在用默认种子色',
                'No system accent colour found; using the default seed',
              )}
            </span>
          )}
        </div>
      )}

      <label className="legado-controls-row">
        <span className="legado-controls-label">{tx('风格', 'Style')}</span>
        <select
          className="settings-input"
          value={style}
          onChange={(e) => onChange({ legadoPaletteStyle: e.target.value as LegadoPaletteStyle })}
        >
          {LEGADO_PALETTE_STYLES.map((s) => (
            <option key={s} value={s}>
              {STYLE_LABELS[s]}
            </option>
          ))}
        </select>
      </label>

      <div className="legado-controls-row">
        <span className="legado-controls-label">{tx('对比度', 'Contrast')}</span>
        <div className="legado-contrast" role="radiogroup" aria-label={tx('对比度', 'Contrast')}>
          {levels.map((level) => {
            const selected = level === contrast;
            return (
              <button
                key={level}
                type="button"
                role="radio"
                aria-checked={selected}
                className={`theme-chip${selected ? ' selected' : ''}`}
                onClick={() => {
                  if (!selected) onChange({ legadoContrast: level });
                }}
              >
                {selected && <Check size={18} className="theme-chip-check" />}
                {levelLabel[level]}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
