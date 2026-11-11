/**
 * @file src/shared/stata-mode.test.ts
 * @purpose Tests for the Stata syntax colours (ADR-040): each rule on a real-looking line.
 */
import { StringStream } from '@codemirror/language';
import { describe, expect, it } from 'vitest';
import { stata, type StataState } from './stata-mode';

/** Each token of each line as [text, style], whitespace left out. */
function tokens(lines: string[]): Array<[string, string | null]> {
  const state: StataState = stata.startState!(4);
  const out: Array<[string, string | null]> = [];
  for (const line of lines) {
    const stream = new StringStream(line, 4, 4);
    while (!stream.eol()) {
      const style = stata.token(stream, state);
      const text = stream.current();
      if (text.trim()) out.push([text, style]);
      stream.start = stream.pos;
    }
  }
  return out;
}

describe('stata mode', () => {
  it('colours commands, macros and numbers', () => {
    expect(tokens(["reghdfe wage `controls' if year > 2010, absorb($fe)"])).toEqual([
      ['reghdfe', 'keyword'],
      ['wage', null],
      ["`controls'", 'variable-2'],
      ['if', 'keyword'],
      ['year', null],
      ['>', 'operator'],
      ['2010', 'number'],
      [',', null],
      ['absorb', null],
      ['(', null],
      ['$fe', 'variable-2'],
      [')', null],
    ]);
  });

  it('treats a leading star and // as line comments, but not a star inside a line', () => {
    expect(tokens(['  * clean the panel', 'gen y = x*2 // double'])).toEqual([
      ['  * clean the panel', 'comment'],
      ['gen', 'keyword'],
      ['y', null],
      ['=', 'operator'],
      ['x', null],
      ['*', 'operator'],
      ['2', 'number'],
      ['// double', 'comment'],
    ]);
  });

  it('keeps nested block comments open across lines', () => {
    expect(tokens(['/* outer /* inner */', 'still comment */ drop x'])).toEqual([
      ['/* outer /* inner */', 'comment'],
      ['still comment */', 'comment'],
      ['drop', 'keyword'],
      ['x', null],
    ]);
  });

  it('reads plain and compound strings', () => {
    expect(tokens(['di "a b"', 'di `"say "hi""\''])).toEqual([
      ['di', 'keyword'],
      ['"a b"', 'string'],
      ['di', 'keyword'],
      ['`"say "hi""\'', 'string'],
    ]);
  });
});
