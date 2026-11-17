/**
 * @file src/shared/user-name.ts
 * @purpose What Ceteris calls the user (ADR-052): cleaning the typed name, the new tab page
 *   greeting, and adding the name to the end of a notice.
 *
 * @关键设计:
 * - Stored in settings.behavior.userName; '' means no name, and then every notice keeps its
 *   old text and the new tab page shows no greeting. settings.behavior.userNameAsked records
 *   that the first start card was answered (Save or Skip), so it is asked only once.
 * - The name goes at the END of a notice ("Claude is waiting for your decision, Xuhang"), so
 *   the important words still come first in a narrow toast. A trailing full stop stays last.
 * - Only app to user notices use the name. Labels, buttons and errors stay neutral, and the
 *   name is never sent to an agent or a terminal.
 * - A name is at most USER_NAME_MAX_LENGTH characters with no control characters, trimmed.
 *   sanitizeUserName makes any input fit; isValidUserName is the check settings-manager runs.
 *
 * @对应文档章节:软件定义书.md ADR-052
 *
 * @不要在这里做的事:
 * - No IPC, no settings writes, no clock reads: the caller passes the hour. Keep it pure so
 *   every rule has a test.
 */

/** Longest name kept, in characters (code points). */
export const USER_NAME_MAX_LENGTH = 40;

/** C0 controls, DEL and C1 controls. Compared by code point (a control regex fails lint). */
function isControlChar(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  return code < 0x20 || (code >= 0x7f && code <= 0x9f);
}

/**
 * Cleans a typed name: control characters become spaces, runs of spaces collapse, the ends
 * are trimmed, and the result is cut to USER_NAME_MAX_LENGTH characters.
 * @param raw anything the user typed or the OS reported; non strings give ''
 * @returns a name that passes isValidUserName ('' when nothing is left)
 */
export function sanitizeUserName(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const cleaned = Array.from(raw, (ch) => (isControlChar(ch) ? ' ' : ch))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(cleaned).slice(0, USER_NAME_MAX_LENGTH).join('').trim();
}

/** Whether a stored value is a clean name ('' counts: it means no name). */
export function isValidUserName(value: unknown): value is string {
  return typeof value === 'string' && sanitizeUserName(value) === value;
}

/**
 * The suggestion shown in the first start card, from the OS account name.
 * @param osUserName os.userInfo().username, or '' when it could not be read
 * @returns the cleaned name with its first letter capitalised, or ''
 */
export function suggestUserName(osUserName: string): string {
  const name = sanitizeUserName(osUserName);
  if (!name) return '';
  const [first, ...rest] = Array.from(name);
  return (first ?? '').toUpperCase() + rest.join('');
}

export type DayPart = 'morning' | 'afternoon' | 'evening';

/** Morning from 5 to 11, afternoon from 12 to 17, evening otherwise (night included). */
export function dayPart(hour: number): DayPart {
  if (hour >= 5 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 18) return 'afternoon';
  return 'evening';
}

/**
 * The greeting line on the new tab page.
 * @param name settings.behavior.userName
 * @param hour local hour, 0 to 23
 * @param zh true for Chinese text
 * @returns e.g. "Hi Xuhang · good morning" or "Xuhang,上午好"; null when there is no name
 */
export function greetingLine(name: string, hour: number, zh: boolean): string | null {
  const who = sanitizeUserName(name);
  if (!who) return null;
  const part = dayPart(hour);
  if (zh) {
    const word = part === 'morning' ? '上午好' : part === 'afternoon' ? '下午好' : '晚上好';
    return `${who},${word}`;
  }
  return `Hi ${who} · good ${part}`;
}

/**
 * Adds the name to the end of a notice, before a trailing full stop if there is one.
 * @param text the notice as it reads without a name
 * @param name settings.behavior.userName
 * @param zh true when text is Chinese (uses a full width comma)
 * @returns text unchanged when there is no name
 */
export function withUserName(text: string, name: string, zh: boolean): string {
  const who = sanitizeUserName(name);
  if (!who) return text;
  const match = /[.。!!]$/.exec(text);
  const end = match ? match[0] : '';
  const body = end ? text.slice(0, -1) : text;
  return `${body}${zh ? ',' : ', '}${who}${end}`;
}
