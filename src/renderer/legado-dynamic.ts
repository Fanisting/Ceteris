/**
 * @file src/renderer/legado-dynamic.ts
 * @purpose 本窗口的 Legado MD3 实时主题(ADR-030):按设置里的种子色、调色风格、对比度,以及
 *   本机强调色,生成四个主题的 CSS 注入页面,并提供终端配色。
 *
 * @关键设计:
 * - 结构同 custom-themes.ts:模块级 store + useSyncExternalStore,读者是 App(喂输入)、
 *   TerminalView(终端配色)、设置页的控件(显示强调色)。
 * - 四个主题(seed / seed-dark / accent / accent-dark)一次全部注入,菜单色块才能显示它们;
 *   规则限定在各自的 data-theme 上,只有选中的那个作用于页面。
 * - 输入没变不重算。拖颜色选择器时,控件先调 previewLegadoSeed 只改本窗口,松手才写设置,
 *   免得每一下都走 IPC 和写盘。
 * - 强调色:启动时问 main 要一次,之后跟随 evt:theme:accent-color-changed。读不到(null,
 *   或非 Windows)时用默认种子色。
 *
 * @不要在这里做的事:
 * - 不要写设置(控件通过 SettingsView 的 updateSettings 写)
 * - 不要放换算规则(在 @shared/legado-palette)
 *
 * @对应文档章节:软件定义书.md 5.1.9、ADR-030
 */
import { useSyncExternalStore } from 'react';
import { COMMAND_CHANNELS, EVENT_CHANNELS } from '@shared/protocol';
import type { TerminalPalette } from '@shared/beamer-themes';
import { legadoCssBlock, legadoLook, type LegadoLook } from '@shared/legado-palette';
import { generateLegadoScheme } from '@shared/legado-dynamic';
import {
  isHexColor,
  LEGADO_DEFAULT_SEED,
  type LegadoContrast,
  type LegadoDynamicThemeId,
  type LegadoPaletteStyle,
} from '@shared/legado-dynamic-ids';

export interface LegadoDynamicInputs {
  seed: string;
  style: LegadoPaletteStyle;
  contrast: LegadoContrast;
}

export interface LegadoDynamicState {
  inputs: LegadoDynamicInputs;
  /** 本机强调色;null 表示读不到,强调色主题用默认种子色 */
  accent: string | null;
  looks: Record<LegadoDynamicThemeId, LegadoLook>;
}

const listeners = new Set<() => void>();
let styleEl: HTMLStyleElement | null = null;
let inputs: LegadoDynamicInputs = {
  seed: LEGADO_DEFAULT_SEED,
  style: 'tonalSpot',
  contrast: 'standard',
};
let accent: string | null = null;
let state: LegadoDynamicState = build();

function build(): LegadoDynamicState {
  const seed = isHexColor(inputs.seed) ? inputs.seed : LEGADO_DEFAULT_SEED;
  const accentSeed = accent ?? LEGADO_DEFAULT_SEED;
  const make = (source: string, dark: boolean): LegadoLook =>
    legadoLook(generateLegadoScheme(source, inputs.style, inputs.contrast, dark), dark);
  return {
    inputs: { ...inputs },
    accent,
    looks: {
      'legado-md3-seed': make(seed, false),
      'legado-md3-seed-dark': make(seed, true),
      'legado-md3-accent': make(accentSeed, false),
      'legado-md3-accent-dark': make(accentSeed, true),
    },
  };
}

function rebuild(): void {
  const started = performance.now();
  state = build();
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = 'ceteris-legado-dynamic';
    document.head.appendChild(styleEl);
  }
  styleEl.textContent = Object.entries(state.looks)
    .map(([id, look]) => legadoCssBlock(id, look.tokens, id.endsWith('-dark')))
    .join('\n');
  const ms = Math.round(performance.now() - started);
  if (ms > 30) console.warn(`[legado-dynamic] rebuilding 4 themes took ${ms}ms`);
  for (const l of listeners) l();
}

function sameInputs(a: LegadoDynamicInputs, b: LegadoDynamicInputs): boolean {
  return a.seed === b.seed && a.style === b.style && a.contrast === b.contrast;
}

/** 注入初始 CSS,取本机强调色并订阅变化。index.tsx 调一次。 */
export function initLegadoDynamic(): void {
  rebuild();
  const setAccent = (hex: string | null): void => {
    const next = isHexColor(hex) ? hex.toLowerCase() : null;
    if (next === accent) return;
    accent = next;
    rebuild();
  };
  window.api
    .invoke<undefined, string | null>(COMMAND_CHANNELS.THEME_ACCENT_COLOR, undefined)
    .then(setAccent)
    .catch((err) => console.warn('[legado-dynamic] accent-color failed; using default seed', err));
  window.api.on<string | null>(EVENT_CHANNELS.ACCENT_COLOR_CHANGED, setAccent);
}

/** App 在设置变化时调用;输入没变不重算。 */
export function setLegadoDynamicInputs(next: LegadoDynamicInputs): void {
  if (sameInputs(next, inputs)) return;
  inputs = { ...next };
  rebuild();
}

/** 拖颜色选择器时只预览本窗口,不写设置;松手后由控件写设置,App 再把同一值送回来。 */
export function previewLegadoSeed(seed: string): void {
  setLegadoDynamicInputs({ ...inputs, seed });
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** 当前四个实时主题;重算后返回新对象,调用方据此重新取配色。 */
export function useLegadoDynamic(): LegadoDynamicState {
  return useSyncExternalStore(subscribe, () => state);
}

/** 不订阅,给 React 渲染之外的代码(xterm options)用。 */
export function getLegadoDynamicTerminal(id: LegadoDynamicThemeId): TerminalPalette {
  return state.looks[id].terminal;
}
