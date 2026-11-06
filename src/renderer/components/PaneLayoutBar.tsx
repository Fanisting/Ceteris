/**
 * @file src/renderer/components/PaneLayoutBar.tsx
 * @purpose Bottom right layout picker. Each icon is a small drawing of the panes it gives.
 */
import type { PaneLayoutId } from '@shared/pane-layout';
import { useAppDispatch, useAppState } from '../store';
import { focusTerminalDom } from '../focus';
import { useTranslation } from './LanguageProvider';

interface LayoutOption {
  id: PaneLayoutId;
  zh: string;
  en: string;
  /** SVG path of the divider lines inside a 14 by 12 frame at (1, 2). */
  lines: string;
}

const OPTIONS: LayoutOption[] = [
  { id: 'single', zh: '单个终端', en: 'One terminal', lines: '' },
  { id: 'rows', zh: '上下两个', en: 'Top and bottom', lines: 'M1 8h14' },
  { id: 'cols', zh: '左右两个', en: 'Left and right', lines: 'M8 2v12' },
  { id: 'main-left', zh: '左侧一个,右侧上下两个', en: 'One left, two right', lines: 'M8 2v12M8 8h7' },
  { id: 'main-right', zh: '左侧上下两个,右侧一个', en: 'Two left, one right', lines: 'M8 2v12M1 8h7' },
  { id: 'grid', zh: '四个终端', en: 'Four terminals', lines: 'M8 2v12M1 8h14' },
];

export function PaneLayoutBar(): JSX.Element {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const { tx } = useTranslation();

  return (
    <div className="pane-layout-bar" role="group" aria-label={tx('终端布局', 'Terminal layout')}>
      {OPTIONS.map((o) => {
        const active = state.paneLayout === o.id;
        return (
          <button
            key={o.id}
            type="button"
            className={`pane-layout-btn${active ? ' active' : ''}`}
            title={tx(o.zh, o.en)}
            aria-label={tx(o.zh, o.en)}
            aria-pressed={active}
            onClick={() => {
              dispatch({ type: 'view/set-pane-layout', layout: o.id });
              focusTerminalDom();
            }}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <rect x="1" y="2" width="14" height="12" rx="2" stroke="currentColor" strokeWidth="1.2" />
              {o.lines && <path d={o.lines} stroke="currentColor" strokeWidth="1.2" />}
            </svg>
          </button>
        );
      })}
    </div>
  );
}
