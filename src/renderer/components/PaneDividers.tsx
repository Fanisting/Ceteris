/**
 * @file src/renderer/components/PaneDividers.tsx
 * @purpose Draggable lines between split panes. Dragging the gap between two terminals moves
 *   it; a double click puts it back in the middle.
 *
 * @关键设计
 * - The split is two fractions (column, row) held by MainPane in memory, like the layout.
 *   MainPane writes them as CSS variables on .pane-grid; material.css builds the grid tracks
 *   and places these handles from the same variables, so the grid and handles cannot drift.
 * - Handles are absolutely positioned over the 4px gap, 8px wide, invisible until hovered.
 * - Pointer capture keeps the drag on the handle even over xterm canvases or a PDF iframe.
 *   While dragging, .pane-grid-resizing turns off pointer events in the panes as well.
 * - pointerdown is preventDefault-ed: the terminal that had the keyboard keeps it.
 * - Terminals refit through their own ResizeObserver (150ms trailing debounce in
 *   TerminalView), so a drag sends one PTY resize per pause, not one per pixel.
 *
 * @对应文档章节 软件定义书.md 6.4 (终端区域)
 * @不要在这里做的事 No keyboard shortcut to move a divider (13.2 鼠标优先). No persistence:
 *   the split lives as long as the window, like the layout.
 */
import { useRef, type PointerEvent } from 'react';
import {
  PANE_DIVIDERS,
  splitFraction,
  type PaneLayoutId,
  type PaneSplit,
} from '@shared/pane-layout';
import { useTranslation } from './LanguageProvider';

/** Must match .pane-grid padding and gap in material.css. */
const GRID_PADDING_PX = 4;
const GRID_GAP_PX = 4;

interface PaneDividersProps {
  layout: PaneLayoutId;
  split: PaneSplit;
  onChange: (next: PaneSplit) => void;
}

export function PaneDividers({ layout, split, onChange }: PaneDividersProps): JSX.Element | null {
  const { tx } = useTranslation();
  const dividers = PANE_DIVIDERS[layout];
  if (!dividers.col && !dividers.row) return null;
  const title = tx('拖动调整大小,双击还原', 'Drag to resize, double-click to reset');
  return (
    <>
      {dividers.col && (
        <Divider axis="col" title={title} split={split} onChange={onChange} layout={layout} />
      )}
      {dividers.row && (
        <Divider axis="row" title={title} split={split} onChange={onChange} layout={layout} />
      )}
    </>
  );
}

function Divider({
  axis,
  title,
  split,
  onChange,
  layout,
}: {
  axis: 'col' | 'row';
  title: string;
  split: PaneSplit;
  onChange: (next: PaneSplit) => void;
  layout: PaneLayoutId;
}): JSX.Element {
  // The grid's box at drag start. The grid does not move or resize during a drag.
  const dragRect = useRef<DOMRect | null>(null);
  const latest = useRef(split);
  latest.current = split;

  const moveTo = (e: PointerEvent<HTMLDivElement>): void => {
    const rect = dragRect.current;
    if (!rect) return;
    const size = axis === 'col' ? rect.width : rect.height;
    const pos = axis === 'col' ? e.clientX - rect.left : e.clientY - rect.top;
    const fraction = splitFraction(
      pos - GRID_PADDING_PX - GRID_GAP_PX / 2,
      size - 2 * GRID_PADDING_PX - GRID_GAP_PX,
    );
    if (fraction !== latest.current[axis]) onChange({ ...latest.current, [axis]: fraction });
  };

  const endDrag = (e: PointerEvent<HTMLDivElement>): void => {
    if (!dragRect.current) return;
    dragRect.current = null;
    e.currentTarget.parentElement?.classList.remove(
      'pane-grid-resizing',
      `pane-grid-resizing-${axis}`,
    );
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  return (
    <div
      className={`pane-divider pane-divider-${axis} pane-divider-${axis}-${layout}`}
      role="separator"
      aria-orientation={axis === 'col' ? 'vertical' : 'horizontal'}
      aria-valuenow={Math.round(split[axis] * 100)}
      aria-valuemin={0}
      aria-valuemax={100}
      title={title}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        const grid = e.currentTarget.parentElement;
        if (!grid) return;
        e.preventDefault();
        dragRect.current = grid.getBoundingClientRect();
        grid.classList.add('pane-grid-resizing', `pane-grid-resizing-${axis}`);
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={moveTo}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={() => onChange({ ...latest.current, [axis]: 0.5 })}
    />
  );
}
