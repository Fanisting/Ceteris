/**
 * @file src/shared/user-name.test.ts
 * @purpose One test per rule of the user name helpers (ADR-052).
 */
import { describe, expect, it } from 'vitest';
import {
  USER_NAME_MAX_LENGTH,
  dayPart,
  greetingLine,
  isValidUserName,
  sanitizeUserName,
  suggestUserName,
  withUserName,
} from './user-name';

describe('sanitizeUserName', () => {
  it('trims the ends', () => {
    expect(sanitizeUserName('  Alex  ')).toBe('Alex');
  });
  it('turns control characters into spaces and collapses runs of spaces', () => {
    expect(sanitizeUserName('Xu\u0000\u001b\nhang   Li')).toBe('Xu hang Li');
  });
  it('cuts to the maximum length in characters, not UTF-16 units', () => {
    const long = '名'.repeat(USER_NAME_MAX_LENGTH + 5);
    expect(Array.from(sanitizeUserName(long))).toHaveLength(USER_NAME_MAX_LENGTH);
    const emoji = '\u{1F600}'.repeat(USER_NAME_MAX_LENGTH + 1);
    expect(Array.from(sanitizeUserName(emoji))).toHaveLength(USER_NAME_MAX_LENGTH);
  });
  it('gives an empty string for non strings and blank input', () => {
    expect(sanitizeUserName(3)).toBe('');
    expect(sanitizeUserName(undefined)).toBe('');
    expect(sanitizeUserName('   ')).toBe('');
  });
});

describe('isValidUserName', () => {
  it('accepts a clean name and the empty string', () => {
    expect(isValidUserName('Alex')).toBe(true);
    expect(isValidUserName('')).toBe(true);
  });
  it('rejects untrimmed, too long, control characters and non strings', () => {
    expect(isValidUserName(' Alex')).toBe(false);
    expect(isValidUserName('a'.repeat(USER_NAME_MAX_LENGTH + 1))).toBe(false);
    expect(isValidUserName('a\tb')).toBe(false);
    expect(isValidUserName(null)).toBe(false);
  });
});

describe('suggestUserName', () => {
  it('capitalises the first letter of the OS account name', () => {
    expect(suggestUserName('alex')).toBe('Alex');
  });
  it('gives an empty string when the OS name is empty', () => {
    expect(suggestUserName('')).toBe('');
  });
});

describe('dayPart', () => {
  it('morning from 5 to 11, afternoon from 12 to 17, evening otherwise', () => {
    expect(dayPart(4)).toBe('evening');
    expect(dayPart(5)).toBe('morning');
    expect(dayPart(11)).toBe('morning');
    expect(dayPart(12)).toBe('afternoon');
    expect(dayPart(17)).toBe('afternoon');
    expect(dayPart(18)).toBe('evening');
    expect(dayPart(0)).toBe('evening');
  });
});

describe('greetingLine', () => {
  it('greets by name in English', () => {
    expect(greetingLine('Alex', 9, false)).toBe('Hi Alex · good morning');
  });
  it('greets by name in Chinese', () => {
    expect(greetingLine('Alex', 14, true)).toBe('Alex,下午好');
    expect(greetingLine('Alex', 20, true)).toBe('Alex,晚上好');
  });
  it('gives null without a name', () => {
    expect(greetingLine('', 9, false)).toBeNull();
    expect(greetingLine('  ', 9, true)).toBeNull();
  });
});

describe('withUserName', () => {
  it('adds the name at the end in English', () => {
    expect(withUserName('Claude is waiting for your decision', 'Alex', false)).toBe(
      'Claude is waiting for your decision, Alex',
    );
  });
  it('uses a full width comma in Chinese', () => {
    expect(withUserName('Claude 在等你决定', 'Alex', true)).toBe('Claude 在等你决定,Alex');
  });
  it('keeps a trailing full stop last', () => {
    expect(withUserName('Codex finished.', 'Alex', false)).toBe('Codex finished, Alex.');
    expect(withUserName('Codex 回答完了。', 'Alex', true)).toBe('Codex 回答完了,Alex。');
  });
  it('leaves the text unchanged without a name', () => {
    expect(withUserName('Claude is waiting for your decision', '', false)).toBe(
      'Claude is waiting for your decision',
    );
  });
});
