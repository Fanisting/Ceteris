/**
 * @file src/renderer/text-drafts.ts
 * @purpose Keeps unsaved edits to text files until the user saves or discards them.
 *
 * @关键设计:
 * - A draft outlives everything that can close the view: switching tabs, opening another file,
 *   closing the window, and above all a Link reconnect, which reloads the window. That is why
 *   nothing needs a "discard changes?" dialog, and 13.2 forbids one on closing a window.
 * - localStorage can refuse a large draft. The copy in memory still works, so the draft then
 *   lasts until the window reloads instead of failing the edit.
 * - Keys carry the Link address, since two machines can have the same path.
 *
 * @对应文档章节: 软件定义书.md ADR-016
 *
 * @不要在这里做的事:
 * - 不要在这里决定草稿能否保存:冲突由 text-writer.ts 按 base 判断
 */

/** The file state a draft was edited from. A save quotes it to detect outside changes. */
export interface TextStamp {
  mtimeMs: number;
  size: number;
}

export interface TextDraft {
  value: string;
  base: TextStamp;
}

const STORAGE_PREFIX = 'ceteris.textDraft.v1:';
const PERSIST_DELAY_MS = 400;

const memory = new Map<string, TextDraft>();
const timers = new Map<string, number>();

function persist(key: string): void {
  timers.delete(key);
  const draft = memory.get(key);
  if (!draft) return;
  try {
    window.localStorage.setItem(`${STORAGE_PREFIX}${key}`, JSON.stringify(draft));
  } catch (err) {
    console.warn('[TextDrafts] kept in memory only', err);
  }
}

function flushAll(): void {
  for (const [key, timer] of timers) {
    window.clearTimeout(timer);
    persist(key);
  }
}

window.addEventListener('pagehide', flushAll);

/** The unsaved edit for this file, if there is one. */
export function getTextDraft(key: string): TextDraft | null {
  const held = memory.get(key);
  if (held) return held;
  try {
    const raw = window.localStorage.getItem(`${STORAGE_PREFIX}${key}`);
    if (!raw) return null;
    const draft = JSON.parse(raw) as TextDraft;
    return typeof draft.value === 'string' && typeof draft.base?.mtimeMs === 'number'
      ? draft
      : null;
  } catch {
    return null;
  }
}

/** Records an edit. Called on every keystroke, so the write to storage is delayed. */
export function setTextDraft(key: string, draft: TextDraft): void {
  memory.set(key, draft);
  if (timers.has(key)) return;
  timers.set(
    key,
    window.setTimeout(() => persist(key), PERSIST_DELAY_MS),
  );
}

/** Forgets the edit, once it is saved or the user discards it. */
export function clearTextDraft(key: string): void {
  memory.delete(key);
  const timer = timers.get(key);
  if (timer !== undefined) window.clearTimeout(timer);
  timers.delete(key);
  try {
    window.localStorage.removeItem(`${STORAGE_PREFIX}${key}`);
  } catch (err) {
    console.warn('[TextDrafts] could not remove a draft', err);
  }
}
