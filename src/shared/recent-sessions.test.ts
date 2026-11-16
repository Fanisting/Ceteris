import { describe, expect, it } from 'vitest';
import { backTarget, forgetSession, rememberSession } from './recent-sessions';

const all = (): boolean => true;

describe('rememberSession', () => {
  it('puts a new session first and keeps one entry per session', () => {
    let list: readonly string[] = [];
    for (const id of ['a', 'b', 'a', 'c']) list = rememberSession(list, id);
    expect(list).toEqual(['c', 'a', 'b']);
  });

  it('returns the same list when the session is already first', () => {
    const list = ['a', 'b'];
    expect(rememberSession(list, 'a')).toBe(list);
  });

  it('drops the oldest entry past the cap', () => {
    expect(rememberSession(['b', 'c', 'd'], 'a', 3)).toEqual(['a', 'b', 'c']);
  });
});

describe('forgetSession', () => {
  it('removes a closed session and leaves the list alone otherwise', () => {
    const list = ['a', 'b'];
    expect(forgetSession(list, 'a')).toEqual(['b']);
    expect(forgetSession(list, 'x')).toBe(list);
  });
});

describe('backTarget', () => {
  it('has no target with zero or one remembered session', () => {
    expect(backTarget([], null, all)).toBeNull();
    expect(backTarget(['a'], 'a', all)).toBeNull();
  });

  it('swaps between the last two sessions', () => {
    let list: readonly string[] = rememberSession(['a'], 'b');
    expect(backTarget(list, 'b', all)).toBe('a');
    list = rememberSession(list, 'a');
    expect(backTarget(list, 'a', all)).toBe('b');
  });

  it('goes to the last session from the new terminal page', () => {
    expect(backTarget(['b', 'a'], null, all)).toBe('b');
  });

  it('skips sessions that no longer exist', () => {
    expect(backTarget(['c', 'b', 'a'], 'c', (id) => id !== 'b')).toBe('a');
  });
});
