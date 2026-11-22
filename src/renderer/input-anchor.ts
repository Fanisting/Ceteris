/**
 * @file src/renderer/input-anchor.ts
 * @purpose Finds the cell where typed text appears in a terminal, for overlays drawn on top of
 *   xterm: predicted keys (local-echo.ts) and type ahead text (type-ahead-view.ts).
 *
 * @关键设计:
 * - Normally the terminal cursor.
 * - Apps like Claude Code hide the cursor and paint their own in reverse video, so with the
 *   cursor hidden the last reverse-video cell marks the input position.
 * - Never while the view is scrolled up.
 * - Not in the alternate screen by default: keys in vim or less are commands, not text. Type
 *   ahead opts in (`alternate: true`), because Claude Code's fullscreen mode (`"tui":
 *   "fullscreen"`) draws its input box there; type ahead checks for the box on every key.
 *
 * @不要在这里做的事: no drawing; callers own their overlay.
 */
import type { Terminal } from '@xterm/xterm';

export interface InputAnchor {
  /** Viewport cell of the input position, or null when there is none to draw at. */
  at(): { x: number; y: number } | null;
  dispose(): void;
}

function findInverseCell(term: Terminal): { x: number; y: number } | null {
  const buffer = term.buffer.active;
  for (let y = term.rows - 1; y >= 0; y--) {
    const line = buffer.getLine(buffer.viewportY + y);
    if (!line) continue;
    for (let x = line.length - 1; x >= 0; x--) {
      if (line.getCell(x)?.isInverse()) return { x, y };
    }
  }
  return null;
}

/**
 * Follows cursor visibility (DECTCEM) so the anchor knows when to look for a painted cursor.
 *
 * @param options.alternate also answer in the alternate screen; the caller must then check
 *   that the cell is really an input box (type ahead does, local echo does not)
 */
export function trackInputAnchor(
  term: Terminal,
  options: { alternate?: boolean } = {},
): InputAnchor {
  let cursorHidden = false;
  const has25 = (params: ReadonlyArray<number | number[]>): boolean => params.includes(25);
  const hideHook = term.parser.registerCsiHandler({ prefix: '?', final: 'l' }, (params) => {
    if (has25(params)) cursorHidden = true;
    return false;
  });
  const showHook = term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, (params) => {
    if (has25(params)) cursorHidden = false;
    return false;
  });
  return {
    at() {
      const buffer = term.buffer.active;
      if (buffer.viewportY !== buffer.baseY) return null;
      if (buffer.type === 'alternate' && !options.alternate) return null;
      return cursorHidden ? findInverseCell(term) : { x: buffer.cursorX, y: buffer.cursorY };
    },
    dispose() {
      hideHook.dispose();
      showHook.dispose();
    },
  };
}
