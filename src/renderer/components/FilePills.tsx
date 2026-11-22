/**
 * @file src/renderer/components/FilePills.tsx
 * @purpose The files open beside one tab, as small pills in the viewer header (ADR-058). Shown
 *   by PdfOverlay in place of the plain file name once two or more files are listed.
 *
 * @关键设计:
 * - The list lives in pdf-view-store (usePdfFileList); this component only draws it. A click
 *   on another pill is an ordinary openPdf of that file, so it loads, refreshes and keeps
 *   drafts exactly like a file tree click.
 * - A click on the current pill copies its name, the same as the plain name button
 *   (onCopyName), so the copy-name habit keeps working with several files open.
 * - As many whole pills as fit the header; the rest go into a "+N" pill that opens the shared
 *   ContextMenu. A fixed count failed: a viewer pane is often under 500px wide, and four
 *   pills then shrank to one letter each. The width left for pills is the header width minus
 *   its other children (measured on resize); pill widths come from canvas measureText with
 *   the header font, so nothing renders twice. The file on screen always has a pill.
 * - Remove a file with the small × on a pill (shown on hover and on the current pill) or a
 *   middle click. Removing the shown file shows its neighbour (removeListedFile).
 *
 * @对应文档章节: 软件定义书.md 14.6, ADR-058
 *
 * @不要在这里做的事:
 * - 不要加键盘快捷键切换文件 (13.2 鼠标优先)
 * - Do not read files here; pdf-view-store loads the one that is shown
 */
import { useLayoutEffect, useRef, useState, type MouseEvent } from 'react';
import {
  openPdf,
  removeListedFile,
  sameSource,
  usePdfFileList,
  type PdfSource,
} from '../pdf-view-store';
import { useContextMenuApi } from './ContextMenu';
import { useTranslation } from './LanguageProvider';
import { Close, ExpandMore } from './material-symbols';

/** Sizes from file-tree.css (.file-pill-name, .file-pill-remove, .file-pills gap). */
const NAME_MAX_PX = 160;
const PILL_EXTRA_PX = 8 + 2 + 16 + 3;
const PILL_GAP_PX = 4;
/** "+N" and its chevron. */
const MORE_PX = 46;

let measureCanvas: HTMLCanvasElement | null = null;

/** Width of a pill for this name in the given CSS font, the name capped like the CSS. */
function pillWidth(name: string, font: string): number {
  measureCanvas ??= document.createElement('canvas');
  const ctx = measureCanvas.getContext('2d');
  const text = ctx ? ((ctx.font = font), ctx.measureText(name).width) : name.length * 7;
  return Math.min(Math.ceil(text), NAME_MAX_PX) + PILL_EXTRA_PX;
}

/**
 * Splits the list into drawn pills and the "+N" overflow within `budget` pixels. Order stays
 * the open order. The shown file is always drawn; the others are added from the left while
 * they fit next to it and the "+N" pill.
 */
function splitPills(
  list: readonly PdfSource[],
  shown: PdfSource,
  budget: number,
  font: string,
): { visible: PdfSource[]; hidden: PdfSource[] } {
  const widths = list.map((s) => pillWidth(s.name, font));
  const all = widths.reduce((sum, w) => sum + w + PILL_GAP_PX, -PILL_GAP_PX);
  if (all <= budget) return { visible: [...list], hidden: [] };
  const shownIndex = Math.max(
    0,
    list.findIndex((s) => sameSource(s, shown)),
  );
  const keep = new Set([shownIndex]);
  let used = (widths[shownIndex] ?? 0) + PILL_GAP_PX + MORE_PX;
  list.forEach((_, i) => {
    const w = (widths[i] ?? 0) + PILL_GAP_PX;
    if (keep.has(i) || used + w > budget) return;
    keep.add(i);
    used += w;
  });
  return {
    visible: list.filter((_, i) => keep.has(i)),
    hidden: list.filter((_, i) => !keep.has(i)),
  };
}

/**
 * Pixels the header leaves for the pills: its inner width minus every other child except the
 * flexible spacer, and minus the gaps. Infinity until the first measure.
 */
function useHeaderBudget(remeasureKey: string): {
  ref: React.RefObject<HTMLSpanElement>;
  budget: number;
  font: string;
} {
  const ref = useRef<HTMLSpanElement>(null);
  const [state, setState] = useState({ budget: Number.POSITIVE_INFINITY, font: '12px sans-serif' });
  useLayoutEffect(() => {
    const header = ref.current?.parentElement;
    if (!header) return undefined;
    const measure = (): void => {
      const style = getComputedStyle(header);
      const gap = parseFloat(style.columnGap) || 0;
      let others = 0;
      for (const child of Array.from(header.children)) {
        if (child === ref.current || child.classList.contains('pdf-overlay-spacer')) continue;
        // Natural width, not the drawn one: some header buttons shrink when the pills crowd
        // them, and measuring the shrunk width fed back into the budget and looped forever
        // ("Maximum update depth exceeded" on switching to a text file).
        others += Math.max(child.getBoundingClientRect().width, child.scrollWidth) + gap;
      }
      const inner =
        header.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      const budget = Math.floor(inner - others - gap);
      setState((prev) =>
        prev.budget === budget && prev.font === style.font ? prev : { budget, font: style.font },
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(header);
    for (const child of Array.from(header.children)) {
      if (child !== ref.current) observer.observe(child);
    }
    return () => observer.disconnect();
    // Re-observe when the header's children may change: another file brings other tools.
  }, [remeasureKey]);
  return { ref, ...state };
}

export function FilePills({
  viewKey,
  shown,
  onCopyName,
}: {
  viewKey: string;
  shown: PdfSource;
  onCopyName: () => void;
}): JSX.Element | null {
  const { tx } = useTranslation();
  const menu = useContextMenuApi();
  const list = usePdfFileList(viewKey);
  const { ref, budget, font } = useHeaderBudget(`${list.length}|${shown.path}`);
  if (list.length < 2) return null;
  const { visible, hidden } = splitPills(list, shown, budget, font);
  const removeLabel = tx('从列表移除', 'Remove from the list');

  const openOverflow = (e: MouseEvent<HTMLButtonElement>): void => {
    const rect = e.currentTarget.getBoundingClientRect();
    menu.open({
      x: rect.left,
      y: rect.bottom + 2,
      items: hidden.map((source) => ({
        label: source.name,
        hint: source.path,
        onSelect: () => void openPdf(viewKey, source),
      })),
    });
  };

  return (
    <span ref={ref} className="file-pills" role="group" aria-label={tx('打开的文件', 'Open files')}>
      {visible.map((source) => {
        const current = sameSource(source, shown);
        return (
          <span
            key={`${source.sshProfileId ?? ''}\n${source.path}`}
            className={`file-pill${current ? ' current' : ''}`}
            // Middle click removes, like closing a browser tab. mousedown is stopped so
            // Chromium does not start autoscroll.
            onMouseDown={(e) => {
              if (e.button === 1) e.preventDefault();
            }}
            onAuxClick={(e) => {
              if (e.button === 1) removeListedFile(viewKey, source);
            }}
          >
            <button
              type="button"
              className="file-pill-name"
              aria-current={current ? 'true' : undefined}
              title={
                current
                  ? tx(`点击复制文件名\n${source.path}`, `Click to copy the name\n${source.path}`)
                  : tx(
                      `${source.path}\n中键点击从列表移除`,
                      `${source.path}\nMiddle click removes it from the list`,
                    )
              }
              onClick={() => (current ? onCopyName() : void openPdf(viewKey, source))}
            >
              {source.name}
            </button>
            <button
              type="button"
              className="file-pill-remove"
              title={removeLabel}
              aria-label={`${removeLabel}: ${source.name}`}
              onClick={() => removeListedFile(viewKey, source)}
            >
              <Close size={12} />
            </button>
          </span>
        );
      })}
      {hidden.length > 0 && (
        <button
          type="button"
          className="file-pill file-pill-more"
          title={hidden.map((s) => s.name).join('\n')}
          onClick={openOverflow}
        >
          +{hidden.length}
          <ExpandMore size={14} />
        </button>
      )}
    </span>
  );
}
