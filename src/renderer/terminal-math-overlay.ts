/**
 * @file terminal-math-overlay.ts
 * @purpose Renderer half of the "Codex formula rendering" extension (ADR-021,
 *          settings.extensions.terminalMath): finds LaTeX written as plain text in the visible
 *          terminal rows and draws a KaTeX rendering over it.
 *
 * @关键设计:
 * - Codex has no render hook, so nothing reaches the terminal but text. Codex is asked (through
 *   ~/.codex/AGENTS.md) to put formulas in inline code as `$$...$$` or `\(...\)`; the delimiters
 *   then arrive literally. @shared/terminal-math decides what counts as math.
 * - Each formula gets an xterm decoration on the top layer over its cells, with the terminal's
 *   background so the source is hidden and pointer-events off so selection still works. The
 *   decoration's marker keeps it on its buffer line as the screen scrolls.
 * - A display formula alone on a line may grow into up to two empty rows below it; an inline
 *   formula stays one row tall. KaTeX output is scaled down to fit its box.
 * - Every scan (after writes, scrolls and resizes, debounced) compares the visible rows with the
 *   overlays: an overlay whose text changed is removed. Codex redraws its live area often, and a
 *   stale overlay would hide new text.
 *
 * @不要在这里做的事:
 * - Do not render images through the PTY here: that is the Claude Code extension's route.
 */
import katex from 'katex';
import 'katex/dist/katex.min.css';
import type { IBufferLine, IDecoration, ITheme, Terminal } from '@xterm/xterm';
import { findTerminalMath } from '@shared/terminal-math';

/** Debounce for scans after output, scrolling or resizing. */
const SCAN_DELAY_MS = 120;
/** How many empty rows below a display formula it may grow into. */
const MAX_EXTRA_ROWS = 2;

interface Overlay {
  decoration: IDecoration;
  /** Buffer line the overlay starts on, read from its marker at scan time */
  line: () => number;
}

/** Visible text of one buffer row, with the column of every UTF-16 unit. */
function rowText(
  row: IBufferLine,
  cols: number,
): { text: string; colOf: number[]; widthOf: number[] } {
  let text = '';
  const colOf: number[] = [];
  const widthOf: number[] = [];
  for (let x = 0; x < cols; x++) {
    const cell = row.getCell(x);
    if (!cell) break;
    const width = cell.getWidth();
    if (width === 0) continue; // second half of a wide character
    const chars = cell.getChars() || ' ';
    for (let i = 0; i < chars.length; i++) {
      colOf.push(x);
      widthOf.push(width);
    }
    text += chars;
  }
  return { text, colOf, widthOf };
}

/** True when the row exists, starts a new line and holds nothing but spaces. */
function isEmptyRow(term: Terminal, y: number): boolean {
  const row = term.buffer.active.getLine(y);
  return !!row && !row.isWrapped && row.translateToString(true).trim() === '';
}

/**
 * Draws one formula into a decoration element: KaTeX HTML on the terminal background, scaled
 * down to fit the box the decoration covers.
 */
function paint(
  el: HTMLElement,
  tex: string,
  display: boolean,
  theme: ITheme,
  fontSize: number,
): void {
  if (el.dataset['tex'] === tex) return;
  el.dataset['tex'] = tex;
  el.style.background = theme.background ?? 'transparent';
  el.style.color = theme.foreground ?? 'inherit';
  el.style.pointerEvents = 'none';
  el.style.overflow = 'hidden';
  el.style.display = 'flex';
  el.style.alignItems = 'center';
  const inner = document.createElement('span');
  inner.style.fontSize = `${display ? fontSize * 1.15 : fontSize}px`;
  inner.style.transformOrigin = 'left center';
  inner.style.whiteSpace = 'nowrap';
  inner.innerHTML = katex.renderToString(tex, {
    displayMode: false, // display layout is centred on a full line; terminal rows read better left-aligned
    throwOnError: false,
    output: 'html',
    strict: 'ignore',
  });
  el.replaceChildren(inner);
  requestAnimationFrame(() => {
    const w = inner.scrollWidth;
    const h = inner.scrollHeight;
    if (w === 0 || h === 0) return;
    const scale = Math.min(1, el.clientWidth / w, el.clientHeight / h);
    inner.style.transform = `scale(${scale})`;
  });
}

/**
 * Starts typesetting LaTeX on one terminal.
 *
 * @param theme the terminal's xterm theme; background hides the source, foreground is the ink
 * @param fontSize the terminal font size in px, the size of inline math
 * @returns a function that removes every overlay and stops scanning
 */
export function activateTerminalMath(term: Terminal, theme: ITheme, fontSize: number): () => void {
  const overlays = new Map<string, Overlay>();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const scan = (): void => {
    timer = undefined;
    const buf = term.buffer.active;
    const cols = term.cols;
    const top = buf.viewportY;
    const bottom = Math.min(buf.length, top + term.rows);
    const seen = new Set<string>();

    let y = top;
    while (y > 0 && buf.getLine(y)?.isWrapped) y--; // start at the first row of a wrapped line
    while (y < bottom) {
      // Join the rows of one logical line, remembering where each character sits.
      const rows: { y: number; text: string; colOf: number[]; widthOf: number[] }[] = [];
      let ry = y;
      do {
        const row = buf.getLine(ry);
        if (!row) break;
        rows.push({ y: ry, ...rowText(row, cols) });
        ry++;
      } while (ry < buf.length && buf.getLine(ry)?.isWrapped);
      const text = rows.map((r) => r.text).join('');
      const locate = (index: number): { y: number; x: number; w: number } => {
        let i = index;
        for (const r of rows) {
          if (i < r.text.length) return { y: r.y, x: r.colOf[i]!, w: r.widthOf[i]! };
          i -= r.text.length;
        }
        const last = rows[rows.length - 1]!;
        return { y: last.y, x: cols - 1, w: 1 };
      };

      for (const span of findTerminalMath(text)) {
        const first = locate(span.start);
        const last = locate(span.end - 1);
        let x: number;
        let width: number;
        let height: number;
        if (first.y !== last.y) {
          if (!span.display) continue; // an inline formula split over rows stays as text
          x = 0;
          width = cols;
          height = last.y - first.y + 1;
        } else if (span.display) {
          x = first.x;
          width = cols - first.x;
          height = 1;
          while (height <= MAX_EXTRA_ROWS && isEmptyRow(term, last.y + height)) height++;
        } else {
          x = first.x;
          width = last.x + last.w - first.x;
          height = 1;
        }
        const key = `${first.y}:${x}:${width}:${height}:${span.display ? 'd' : 'i'}:${span.tex}`;
        seen.add(key);
        if (overlays.has(key)) continue;
        const marker = term.registerMarker(first.y - (buf.baseY + buf.cursorY));
        if (!marker) continue;
        const decoration = term.registerDecoration({ marker, x, width, height, layer: 'top' });
        if (!decoration) {
          marker.dispose();
          continue;
        }
        const { tex, display } = span;
        decoration.onRender((el) => paint(el, tex, display, theme, fontSize));
        decoration.onDispose(() => marker.dispose());
        overlays.set(key, { decoration, line: () => marker.line });
      }
      y = ry;
    }

    // Remove overlays on the scanned rows whose formula is gone or moved, and dead ones.
    for (const [key, overlay] of overlays) {
      const line = overlay.line();
      const stale = line < 0 || (line >= top && line < bottom && !seen.has(key));
      if (stale || overlay.decoration.isDisposed) {
        overlay.decoration.dispose();
        overlays.delete(key);
      }
    }
  };

  const schedule = (): void => {
    if (timer === undefined) timer = setTimeout(scan, SCAN_DELAY_MS);
  };
  const subscriptions = [
    term.onWriteParsed(schedule),
    term.onScroll(schedule),
    term.onResize(schedule),
  ];
  schedule();

  return () => {
    if (timer !== undefined) clearTimeout(timer);
    for (const s of subscriptions) s.dispose();
    for (const overlay of overlays.values()) overlay.decoration.dispose();
    overlays.clear();
  };
}
