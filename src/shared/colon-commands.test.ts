/**
 * @file colon-commands.test.ts
 * @purpose Rules of the `name:` commands extension (ADR-019): list validation and the
 *          input-line tracker that turns `name:` into the saved command.
 */
import { describe, expect, it } from 'vitest';
import {
  ColonTracker,
  DEFAULT_COLON_COMMANDS,
  colonCommandsProblem,
  findColonCommand,
} from './colon-commands';

const resolveFrom =
  (list = DEFAULT_COLON_COMMANDS) =>
  (name: string): string | null =>
    findColonCommand(list, name)?.command ?? null;

/** Feeds each key in turn and returns everything that would reach the PTY. */
function type(tracker: ColonTracker, keys: string[], resolve = resolveFrom()): string {
  return keys.map((k) => tracker.feed(k, resolve)).join('');
}

const chars = (s: string): string[] => [...s];

describe('colonCommandsProblem', () => {
  it('accepts the defaults', () => {
    expect(colonCommandsProblem(DEFAULT_COLON_COMMANDS)).toBeNull();
  });

  it('rejects bad names, duplicates ignoring case, and multi-line commands', () => {
    expect(colonCommandsProblem([{ name: '-x', command: '/x' }])).toMatch(/名称/);
    expect(colonCommandsProblem([{ name: 'a b', command: '/x' }])).toMatch(/名称/);
    expect(
      colonCommandsProblem([
        { name: 'Plan', command: '/plan' },
        { name: 'plan', command: '/plan' },
      ]),
    ).toMatch(/已经存在/);
    expect(colonCommandsProblem([{ name: 'x', command: '/x\r' }])).toMatch(/命令无效/);
    expect(colonCommandsProblem([{ name: 'x', command: '  ' }])).toMatch(/命令无效/);
    expect(colonCommandsProblem('nope')).toMatch(/数组/);
  });
});

describe('ColonTracker', () => {
  it('turns a saved name and colon at the start of the input into the command', () => {
    const out = type(new ColonTracker(), chars('compact:'));
    expect(out).toBe('compact' + '\x7f'.repeat(7) + '/compact');
  });

  it('fires after a space, matches names ignoring case, and takes the full-width colon', () => {
    const list = [{ name: 'plan', command: '/oh-my-claudecode:plan' }];
    const out = type(new ColonTracker(), [...chars('do it Plan'), '：'], resolveFrom(list));
    expect(out).toBe('do it Plan' + '\x7f'.repeat(4) + '/oh-my-claudecode:plan');
  });

  it('lets the colon through for unknown names, words glued to text, and a refusing resolver', () => {
    expect(type(new ColonTracker(), chars('note:'))).toBe('note:');
    expect(type(new ColonTracker(), chars('xcompact:'))).toBe('xcompact:');
    expect(type(new ColonTracker(), chars('compact:'), () => null)).toBe('compact:');
  });

  it('does not fire at an unknown line start after keys it cannot follow, but does after Enter', () => {
    const t = new ColonTracker();
    expect(type(t, ['\x1b[A', ...chars('compact:')])).toBe('\x1b[Acompact:');
    expect(type(t, ['\r', ...chars('compact:')])).toContain('/compact');
  });

  it('keeps the line through a lone Esc', () => {
    expect(type(new ColonTracker(), ['\x1b', ...chars('compact:')])).toContain('/compact');
  });

  it('follows backspace', () => {
    const out = type(new ColonTracker(), [...chars('compx'), '\x7f', ...chars('act:')]);
    expect(out.endsWith('\x7f'.repeat(7) + '/compact')).toBe(true);
  });

  it('ignores terminal replies such as DA1, XTVERSION and focus reports', () => {
    const replies = ['\x1b[?62;4c', '\x1bP>|iTerm2 3.5.0\x1b\\', '\x1b[I'];
    expect(type(new ColonTracker(), [...replies, ...chars('compact:')])).toContain('/compact');
  });

  it('follows pasted text, and treats a pasted line break as an unknown line start', () => {
    const t = new ColonTracker();
    expect(type(t, ['\x1b[200~fix it \x1b[201~', ...chars('compact:')])).toContain('/compact');
    expect(type(t, ['\r', '\x1b[200~a\n\x1b[201~', ...chars('compact:')])).not.toContain(
      '/compact',
    );
  });
});
