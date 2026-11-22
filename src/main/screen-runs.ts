/**
 * @file src/main/screen-runs.ts
 * @purpose Turns rows of a session's headless terminal into styled runs (text plus colour and
 *   weight), so the "waiting for your decision" toast can show an agent's prompt exactly as
 *   the agent drew it: the tool header, the command or diff, previews, ❯ and ☐ marks.
 *
 * @关键设计:
 * - Colours stay symbolic: a palette index (0-255) or "#rrggbb". The renderer maps indices
 *   through the current terminal theme, so the copy matches the tab whatever the theme.
 * - Trailing blank cells are dropped unless they carry a background colour: Claude Code pads
 *   diff rows with coloured spaces, and those bands are part of the look.
 * - Wide characters take two cells; the second cell has width 0 and is skipped.
 *
 * @对应文档章节:软件定义书.md ADR-035;ipc-protocol.md cmd:session:read-choice
 * @不要在这里做的事:
 * - Do not parse the prompt here. Which rows are the prompt is agent-phase.ts's job.
 */
import type { IBufferCell, IBufferLine } from '@xterm/headless';
import type { ScreenRun } from '@shared/types';

type Colour = number | string | undefined;

function fgOf(cell: IBufferCell): Colour {
  if (cell.isFgDefault()) return undefined;
  const c = cell.getFgColor();
  return cell.isFgRGB() ? '#' + c.toString(16).padStart(6, '0') : c;
}

function bgOf(cell: IBufferCell): Colour {
  if (cell.isBgDefault()) return undefined;
  const c = cell.getBgColor();
  return cell.isBgRGB() ? '#' + c.toString(16).padStart(6, '0') : c;
}

/** Look of a cell as a run without text; equal looks merge into one run. */
function lookOf(cell: IBufferCell): Omit<ScreenRun, 'text'> {
  const look: Omit<ScreenRun, 'text'> = {};
  const fg = fgOf(cell);
  const bg = bgOf(cell);
  if (fg !== undefined) look.fg = fg;
  if (bg !== undefined) look.bg = bg;
  if (cell.isBold()) look.bold = true;
  if (cell.isDim()) look.dim = true;
  if (cell.isItalic()) look.italic = true;
  if (cell.isUnderline()) look.underline = true;
  if (cell.isInverse()) look.inverse = true;
  return look;
}

function sameLook(a: Omit<ScreenRun, 'text'>, b: Omit<ScreenRun, 'text'>): boolean {
  return (
    a.fg === b.fg &&
    a.bg === b.bg &&
    a.bold === b.bold &&
    a.dim === b.dim &&
    a.italic === b.italic &&
    a.underline === b.underline &&
    a.inverse === b.inverse
  );
}

/**
 * The styled runs of one buffer row.
 *
 * @param line a row of the headless terminal's active buffer
 * @param cols the terminal width; cells past it are not read
 * @returns runs left to right; an empty array for a blank row
 */
export function lineRuns(line: IBufferLine, cols: number): ScreenRun[] {
  // Last cell worth drawing: not a blank, or a blank with a background colour.
  let end = -1;
  for (let x = Math.min(cols, line.length) - 1; x >= 0 && end < 0; x--) {
    const cell = line.getCell(x);
    if (!cell) continue;
    if (cell.getChars().trim() !== '' || !cell.isBgDefault() || cell.isInverse()) end = x;
  }
  const runs: ScreenRun[] = [];
  for (let x = 0; x <= end; x++) {
    const cell = line.getCell(x);
    if (!cell || cell.getWidth() === 0) continue;
    const text = cell.getChars() || ' ';
    const look = lookOf(cell);
    const prev = runs[runs.length - 1];
    if (prev && sameLook(prev, look)) prev.text += text;
    else runs.push({ text, ...look });
  }
  return runs;
}
