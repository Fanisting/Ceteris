/**
 * @file placeholder-filter.test.ts
 * @purpose One test per rule of PlaceholderFilter: placeholder cells become spaces, other text is
 *          untouched, and a split across chunks gives the same bytes as one chunk.
 */
import { describe, expect, it } from 'vitest';
import { PlaceholderFilter } from './placeholder-filter';

/** A Claude Code placeholder cell: U+2800 and five combining marks (row, column, three id digits). */
const CELL = '⠀̅̍̅̅̎';

function run(chunks: string[]): string {
  const filter = new PlaceholderFilter();
  const bytes = chunks.map((c) => filter.filter(Buffer.from(c, 'utf8')));
  return Buffer.concat(bytes).toString('utf8');
}

describe('PlaceholderFilter', () => {
  it('turns each placeholder cell, and a bare U+2800, into one space', () => {
    expect(run([`a${CELL}${CELL}b ⠀c`])).toBe('a  b  c');
  });

  it('leaves other braille, combining marks after other letters, and plain text alone', () => {
    const text = 'é ⠁⣿ \x1b[31mred\x1b[0m 中文';
    expect(run([text])).toBe(text);
  });

  it('gives the same result when a cell is split inside U+2800 or between its marks', () => {
    const bytes = Buffer.from(`x${CELL}y`, 'utf8');
    const filter = new PlaceholderFilter();
    const out: Buffer[] = [];
    for (let i = 0; i < bytes.length; i++) out.push(filter.filter(bytes.subarray(i, i + 1)));
    expect(Buffer.concat(out).toString('utf8')).toBe('x y');
  });
});
