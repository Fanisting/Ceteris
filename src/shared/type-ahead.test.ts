/**
 * @file src/shared/type-ahead.test.ts
 * @purpose One test per rule of TypeAhead (ADR-047).
 */
import { describe, expect, it } from 'vitest';
import { TypeAhead, agentPromptReady, type TypeAheadWrite } from './type-ahead';

function typeAll(
  ta: TypeAhead,
  keys: string[],
  resolve?: (n: string) => string | null,
): TypeAheadWrite[] {
  return keys.flatMap((k) => ta.feed(k, resolve));
}

const key = (data: string): TypeAheadWrite => ({ kind: 'key', data });

describe('TypeAhead', () => {
  it('holds typed text and sends nothing', () => {
    const ta = new TypeAhead();
    expect(typeAll(ta, ['h', 'i', ' ', '你好'])).toEqual([]);
    expect(ta.text).toBe('hi 你好');
  });

  it('submits the whole text on Enter and empties the buffer', () => {
    const ta = new TypeAhead();
    typeAll(ta, ['f', 'i', 'x']);
    expect(ta.feed('\r')).toEqual([{ kind: 'submit', text: 'fix' }]);
    expect(ta.text).toBe('');
  });

  it('passes Enter through when nothing is buffered', () => {
    expect(new TypeAhead().feed('\r')).toEqual([key('\r')]);
  });

  it('adds a line on Shift+Enter or Ctrl+J', () => {
    const ta = new TypeAhead();
    typeAll(ta, ['a', '\n', 'b']);
    expect(ta.text).toBe('a\nb');
  });

  it('Backspace removes one character, including one outside the BMP', () => {
    const ta = new TypeAhead();
    typeAll(ta, ['a', '😀', '\x7f']);
    expect(ta.text).toBe('a');
  });

  it('edit keys go to the agent when the buffer is empty', () => {
    const ta = new TypeAhead();
    for (const k of ['\x7f', '\b', '\x03', '\x15', '\x17', '\n'])
      expect(ta.feed(k)).toEqual([key(k)]);
  });

  it('Ctrl+C clears the buffer without sending', () => {
    const ta = new TypeAhead();
    typeAll(ta, ['a', 'b']);
    expect(ta.feed('\x03')).toEqual([]);
    expect(ta.text).toBe('');
  });

  it('Ctrl+U clears the current line only', () => {
    const ta = new TypeAhead();
    typeAll(ta, ['one', '\n', 'two']);
    ta.feed('\x15');
    expect(ta.text).toBe('one\n');
  });

  it('Ctrl+W deletes the last word and the spaces after it', () => {
    const ta = new TypeAhead();
    typeAll(ta, ['foo bar  ']);
    ta.feed('\x17');
    expect(ta.text).toBe('foo ');
  });

  it('a paste joins the buffer with its line breaks as newlines', () => {
    const ta = new TypeAhead();
    ta.feed('x');
    expect(ta.feed('\x1b[200~a\r\nb\x1b[201~')).toEqual([]);
    expect(ta.text).toBe('xa\nb');
  });

  it('terminal replies pass through and leave the buffer alone', () => {
    const ta = new TypeAhead();
    ta.feed('a');
    for (const r of ['\x1b[I', '\x1b[O', '\x1b[?1;2c', '\x1b[<64;3;4M'])
      expect(ta.feed(r)).toEqual([key(r)]);
    expect(ta.text).toBe('a');
  });

  it('arrows and Tab type the buffer out first, then pass through', () => {
    const ta = new TypeAhead();
    ta.feed('ab');
    expect(ta.feed('\x1b[D')).toEqual([{ kind: 'text', text: 'ab' }, key('\x1b[D')]);
    expect(ta.feed('\t')).toEqual([key('\t')]);
    expect(ta.text).toBe('');
  });

  it('Esc passes through and keeps the buffer', () => {
    const ta = new TypeAhead();
    ta.feed('ab');
    expect(ta.feed('\x1b')).toEqual([key('\x1b')]);
    expect(ta.text).toBe('ab');
  });

  it('/, ! and # at the start make the message live until Enter', () => {
    for (const first of ['/', '!', '#']) {
      const ta = new TypeAhead();
      expect(typeAll(ta, [first, 'x'])).toEqual([key(first), key('x')]);
      expect(ta.isLive).toBe(true);
      expect(ta.feed('\r')).toEqual([key('\r')]);
      expect(ta.isLive).toBe(false);
      expect(ta.feed('y')).toEqual([]);
    }
  });

  it('Ctrl+C ends a live message', () => {
    const ta = new TypeAhead();
    typeAll(ta, ['/', 'x']);
    expect(ta.feed('\x03')).toEqual([key('\x03')]);
    expect(ta.feed('a')).toEqual([]);
  });

  it('/ inside a message is plain text', () => {
    const ta = new TypeAhead();
    expect(typeAll(ta, ['a', '/', 'b'])).toEqual([]);
    expect(ta.text).toBe('a/b');
  });

  it('/ after text already typed out is plain text', () => {
    const ta = new TypeAhead();
    typeAll(ta, ['a', '\t']);
    expect(ta.feed('/')).toEqual([]);
    expect(ta.text).toBe('/');
  });

  it('@ types out the buffer and goes live for the file picker', () => {
    const ta = new TypeAhead();
    ta.feed('look at ');
    expect(ta.feed('@')).toEqual([{ kind: 'text', text: 'look at ' }, key('@')]);
    expect(ta.feed('s')).toEqual([key('s')]);
  });

  it('@ in the middle of a commit splits it at the @', () => {
    const ta = new TypeAhead();
    expect(ta.feed('see @src')).toEqual([{ kind: 'text', text: 'see ' }, key('@src')]);
  });

  it('name: at the start types the command out and goes live', () => {
    const ta = new TypeAhead();
    const resolve = (n: string): string | null => (n === 'compact' ? '/compact' : null);
    expect(typeAll(ta, ['compact', ':'], resolve)).toEqual([{ kind: 'text', text: '/compact' }]);
    expect(ta.isLive).toBe(true);
  });

  it('name: after a space expands inside the buffer', () => {
    const ta = new TypeAhead();
    const resolve = (n: string): string | null => (n === 'compact' ? '/compact' : null);
    expect(typeAll(ta, ['then compact', ':'], resolve)).toEqual([]);
    expect(ta.text).toBe('then /compact');
  });

  it('an unknown name: keeps the colon', () => {
    const ta = new TypeAhead();
    typeAll(ta, ['note', ':'], () => null);
    expect(ta.text).toBe('note:');
  });

  it('insert adds pasted text unless the message is live', () => {
    const ta = new TypeAhead();
    expect(ta.insert('a\r\nb')).toBe(true);
    expect(ta.text).toBe('a\nb');
    const live = new TypeAhead();
    live.feed('/');
    expect(live.insert('x')).toBe(false);
  });

  it('restore puts failed text back ahead of newer typing', () => {
    const ta = new TypeAhead();
    ta.feed('new');
    ta.restore('old ');
    expect(ta.text).toBe('old new');
  });

  it('starts from saved text', () => {
    expect(new TypeAhead('kept').text).toBe('kept');
  });
});

describe('TypeAhead edge keys', () => {
  it('Esc Esc clears the text and sends only the first Esc', () => {
    const ta = new TypeAhead();
    ta.feed('ab');
    expect(ta.feed('\x1b')).toEqual([key('\x1b')]);
    expect(ta.feed('\x1b')).toEqual([]);
    expect(ta.text).toBe('');
  });

  it('Esc, a letter, Esc does not clear', () => {
    const ta = new TypeAhead();
    typeAll(ta, ['a', '\x1b', 'b', '\x1b']);
    expect(ta.text).toBe('ab');
  });

  it('mouse reports pass through without typing the text out', () => {
    const ta = new TypeAhead();
    ta.feed('ab');
    for (const r of ['\x1b[<0;10;5M', '\x1b[<0;10;5m', '\x1b[M !!'])
      expect(ta.feed(r)).toEqual([key(r)]);
    expect(ta.text).toBe('ab');
  });

  it('restore ends a live message so the restored text can be sent', () => {
    const ta = new TypeAhead();
    ta.feed('/');
    ta.restore('hello');
    expect(ta.isLive).toBe(false);
    expect(ta.feed('\r')).toEqual([{ kind: 'submit', text: 'hello' }]);
  });
});

// Rows recorded from Claude Code (agent-phase.test.ts): the input row between rules, then the footer.
const CLAUDE_INPUT = [
  '────────────────────────────────────────',
  '❯',
  '────────────────────────────────────────',
  '  ⏵⏵ auto mode on (shift+tab to cycle)',
];

const RULE = '─'.repeat(100);
/** Claude Code 2.1.322 with "tui": "fullscreen", manual mode, recorded in a 100x30 terminal. */
const FULLSCREEN = [
  ' ▐▛███▛█   Claude Code v2.1.322',
  '',
  '✶ Bloviating… ',
  '',
  RULE,
  '❯ next q',
  RULE,
  '',
  '  ⏸ manual mode on',
];
const FULLSCREEN_INPUT = 5;

/** Calls agentPromptReady the way the renderer does: the rows, the cursor row, the screen. */
const ready = (rows: string[], inputRow: number, alternate = false): boolean =>
  agentPromptReady(rows, inputRow, rows.join('\n'), alternate);

describe('agentPromptReady', () => {
  it('Claude Code idle or working: footer under the input row', () => {
    expect(ready(CLAUDE_INPUT, 1)).toBe(true);
    const working = ['✻ Cogitating… (5s · ↓ 24 tokens)', ...CLAUDE_INPUT];
    expect(ready(working, 2)).toBe(true);
  });

  it('Claude Code with no footer hint: the input box alone is enough', () => {
    expect(ready(FULLSCREEN, FULLSCREEN_INPUT)).toBe(true);
    expect(ready(FULLSCREEN, FULLSCREEN_INPUT, true)).toBe(true);
  });

  it('Claude Code multi-line input: the cursor on a continuation row', () => {
    const rows = [RULE, '❯ first line', '  second line', '  third', RULE, '  ⏸ manual mode on'];
    expect(ready(rows, 2)).toBe(true);
    expect(ready(rows, 3)).toBe(true);
  });

  it('Claude Code input with a blank line in it', () => {
    const rows = [RULE, '❯ first paragraph', '', '  second paragraph', RULE];
    expect(ready(rows, 1, true)).toBe(true);
    expect(ready(rows, 3, true)).toBe(true);
  });

  it('alternate screen: a footer phrase in an editor file does not hold its keys', () => {
    const vim = ['notes on the agent', 'about 40% context left', '? for shortcuts', '~', '~'];
    expect(ready(vim, 0, true)).toBe(false);
  });

  it('fzf style "> query" between rules is not a Claude input box', () => {
    expect(ready([RULE, '> query', RULE, '  12/300'], 1, true)).toBe(false);
  });

  it('Codex: placeholder and footer from the input row down', () => {
    expect(ready(['› Ask Codex to do anything', '  ? for shortcuts'], 0)).toBe(true);
  });

  it('a shell after /exit: the old footer and box are above the cursor row', () => {
    expect(ready([...CLAUDE_INPUT, 'PS C:/work> '], 4)).toBe(false);
    expect(ready([...FULLSCREEN, '❯ '], FULLSCREEN.length)).toBe(false);
  });

  it('a shell prompt starting with ❯ is not a Claude input box', () => {
    expect(ready(['~/projects/example on main', '❯ ', ''], 1)).toBe(false);
    expect(ready([RULE, '❯ ', ''], 1)).toBe(false);
  });

  it('an approval prompt is never prompt text', () => {
    const approval = [
      '│ Do you want to proceed?                      │',
      '│ ❯ 1. Yes                                     │',
      '│   2. No, and tell Claude what to do (esc)    │',
      '  ? for shortcuts',
    ];
    expect(ready(approval, 1)).toBe(false);
    const boxed = [RULE, '❯ ', RULE, ...approval];
    expect(ready(boxed, 1)).toBe(false);
  });

  it('a plain shell is not an agent', () => {
    expect(ready(['PS C:/> '], 0)).toBe(false);
  });
});
