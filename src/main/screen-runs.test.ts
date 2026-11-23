/**
 * @file src/main/screen-runs.test.ts
 * @purpose Tests for lineRuns: colours, weights, merging, wide characters, trailing cells.
 */
import { describe, expect, it } from 'vitest';
import xtermHeadless from '@xterm/headless';
import { lineRuns } from './screen-runs';

const { Terminal } = xtermHeadless;

/** Writes `data` into a fresh 40-column terminal and returns the runs of row 0. */
async function runsOf(data: string): Promise<ReturnType<typeof lineRuns>> {
  const term = new Terminal({ cols: 40, rows: 4, allowProposedApi: true });
  await new Promise<void>((resolve) => term.write(data, resolve));
  const runs = lineRuns(term.buffer.active.getLine(0)!, term.cols);
  term.dispose();
  return runs;
}

describe('lineRuns', () => {
  it('returns nothing for a blank row', async () => {
    expect(await runsOf('')).toEqual([]);
  });

  it('merges cells of one look and splits where the look changes', async () => {
    expect(await runsOf('ab\x1b[1;31mcd\x1b[0m e')).toEqual([
      { text: 'ab' },
      { text: 'cd', fg: 1, bold: true },
      { text: ' e' },
    ]);
  });

  it('keeps true colours as #rrggbb and 256-colour indices as numbers', async () => {
    expect(await runsOf('\x1b[38;2;177;185;249m❯\x1b[0m \x1b[48;5;22mx\x1b[0m')).toEqual([
      { text: '❯', fg: '#b1b9f9' },
      { text: ' ' },
      { text: 'x', bg: 22 },
    ]);
  });

  it('drops trailing blanks but keeps blanks with a background colour', async () => {
    expect(await runsOf('hi   ')).toEqual([{ text: 'hi' }]);
    expect(await runsOf('\x1b[42m+ a  \x1b[0m')).toEqual([{ text: '+ a  ', bg: 2 }]);
  });

  it('writes a wide character once', async () => {
    expect(await runsOf('是 ok')).toEqual([{ text: '是 ok' }]);
  });

  it('marks dim, italic, underline and inverse', async () => {
    expect(await runsOf('\x1b[2;3;4;7mz')).toEqual([
      { text: 'z', dim: true, italic: true, underline: true, inverse: true },
    ]);
  });
});
