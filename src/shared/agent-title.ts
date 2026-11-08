/**
 * @file src/shared/agent-title.ts
 * @purpose Short tab titles for agent tabs (ADR-029): the local shortening of the title an
 *   agent sets itself, and the prompt and reply rules for titles written by a model.
 *
 * @关键设计:
 * - Claude Code sets its own terminal title (OSC 0), such as "✳ Refactor the session manager
 *   idle timer". No setting reaches the model that writes it, so Ceteris writes its own
 *   title after each finished turn, following the user's guide from Settings. The same
 *   applies to every agent template in AGENT_TEMPLATE_IDS.
 * - Until the first model title arrives, or with no model connected, the agent's own title
 *   is shortened here: spinner glyphs dropped, cut to the length the user chose.
 * - The model may answer KEEP, which leaves the current title; that keeps a title stable
 *   while the task stays the same.
 *
 * @对应文档章节:软件定义书.md ADR-029
 *
 * @不要在这里做的事:
 * - No network and no Node APIs: the renderer imports the defaults for the settings page.
 */

/**
 * Built-in templates that run a coding agent. Claude Code and Codex are also recognised
 * from their screens (ADR-021); the others only by template, and their turns are read
 * from Enter plus output going quiet, not from the screen.
 */
export const AGENT_TEMPLATE_IDS: readonly string[] = [
  'claude-code',
  'codex',
  'opencode',
  'gemini-cli',
  'github-copilot',
  'cursor',
  'aider',
];

export function isAgentTemplate(templateId: string): boolean {
  return AGENT_TEMPLATE_IDS.includes(templateId);
}

/** Used when the guide in Settings is empty. Written in English because the model reads it. */
export const AGENT_TITLE_DEFAULT_GUIDE =
  'Two to four words naming the task, like a short commit subject. ' +
  'Start with a verb or the thing being worked on. ' +
  'Use the language the user writes in. No quotes, no ending punctuation, ' +
  'and no agent, app or folder names.';

export const AGENT_TITLE_DEFAULT_MAX_CHARS = 24;
export const AGENT_TITLE_MIN_MAX_CHARS = 8;
export const AGENT_TITLE_MAX_MAX_CHARS = 60;
/** A longer guide is cut before it is sent; the settings check refuses anything past this. */
export const AGENT_TITLE_MAX_GUIDE_CHARS = 2000;
/** How much of the end of the screen the model sees, in characters. */
export const AGENT_TITLE_MAX_SCREEN_CHARS = 4000;

/** The reply that means "the task has not changed, keep the title". */
const KEEP = /^keep\.?$/i;

/**
 * Cuts a title to maxChars. A cut inside a word moves back to the last space when that
 * keeps at least half the room; text without spaces (Chinese, Japanese) is cut where it is.
 */
export function fitTitle(title: string, maxChars: number): string {
  const chars = Array.from(title);
  if (chars.length <= maxChars) return title;
  const room = Math.max(1, maxChars - 1); // one place for the ellipsis
  let cut = chars.slice(0, room).join('');
  const space = cut.lastIndexOf(' ');
  if (space >= room / 2) cut = cut.slice(0, space);
  return `${cut.replace(/[\s,.;:·-]+$/u, '')}…`;
}

/**
 * Shortens a title an agent set itself. Drops leading spinner and status glyphs (Claude
 * Code animates "✳ ✶ ✻ · ⠂"), then fits the rest to maxChars.
 *
 * @returns '' when nothing but glyphs was left, so the caller keeps the current name
 */
export function shortenAgentTitle(raw: string, maxChars: number): string {
  const text = raw
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text ? fitTitle(text, maxChars) : '';
}

/** The system message for a title request. An empty guide uses the default one. */
export function agentTitleSystem(guide: string, maxChars: number): string {
  const rules = guide.trim().slice(0, AGENT_TITLE_MAX_GUIDE_CHARS) || AGENT_TITLE_DEFAULT_GUIDE;
  return [
    'You name terminal tabs in which a coding agent (Claude Code, Codex, Gemini, OpenCode and others) works for a user.',
    'You get the end of the tab screen: the user prompt and the agent reply.',
    `Write a tab title of at most ${maxChars} characters that says what the user is working on.`,
    `The user's rules for titles: ${rules}`,
    'If the current title still fits the task, answer exactly KEEP.',
    'Answer with the title alone on one line.',
  ].join('\n');
}

/** The user message: the current title, the agent's own title, then the screen. */
export function agentTitleUser(input: {
  screen: string;
  currentTitle: string;
  agentTitle: string | null;
}): string {
  const lines = [`Current title: ${input.currentTitle || '(none)'}`];
  if (input.agentTitle) lines.push(`Title the agent set itself: ${input.agentTitle}`);
  lines.push('Screen:', input.screen.slice(-AGENT_TITLE_MAX_SCREEN_CHARS));
  return lines.join('\n');
}

/**
 * Turns a model reply into a tab title.
 *
 * @returns the title, or null for KEEP and for an empty or unusable reply
 */
export function cleanAgentTitle(reply: string, maxChars: number): string | null {
  const firstLine = reply.trim().split(/\r?\n/)[0] ?? '';
  const text = firstLine
    .replace(/^(tab\s+)?title\s*[:：]\s*/i, '')
    .replace(/^["'“‘`「《]+|["'”’`」》]+$/gu, '')
    .replace(/[.。!！]+$/u, '');
  const clean = Array.from(text, (ch) => (isUnsafeTitleChar(ch.codePointAt(0)!) ? ' ' : ch))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean || KEEP.test(clean)) return null;
  return fitTitle(clean, maxChars);
}

/**
 * Control characters and bidirectional overrides, which could reorder how a title reads
 * (the same set SessionManager removes from OSC titles, OSC-6).
 */
function isUnsafeTitleChar(code: number): boolean {
  return (
    code < 0x20 ||
    code === 0x7f ||
    code === 0x200b ||
    code === 0x200e ||
    code === 0x200f ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

/** maxChars from settings, held inside the allowed range. */
export function clampTitleLength(value: unknown): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : NaN;
  if (Number.isNaN(n)) return AGENT_TITLE_DEFAULT_MAX_CHARS;
  return Math.min(AGENT_TITLE_MAX_MAX_CHARS, Math.max(AGENT_TITLE_MIN_MAX_CHARS, n));
}
