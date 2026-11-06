/**
 * @file src/shared/next-prompt.ts
 * @purpose Rules for guessing the next prompt in a Claude Code or Codex terminal. Pure, so
 *   the renderer and main process share them and they can be tested without either.
 */

/** Chosen by benchmark on 2026-11-05: 156ms average, about $0.0000035 per suggestion. */
export const NEXT_PROMPT_DEFAULT_MODEL = 'meta-llama/llama-3.1-8b-instruct';

/** The end of the screen is what matters, and input size is the running cost. */
export const NEXT_PROMPT_MAX_SCREEN_CHARS = 4_000;

const MAX_SUGGESTION_CHARS = 160;

export const NEXT_PROMPT_SYSTEM =
  'You predict the next message a developer will send to their AI coding agent. ' +
  'You are given the end of the terminal screen. Reply with only that message: one short ' +
  'direct instruction of at most 15 words, in the language the developer writes in. ' +
  'No quotes, no explanation. If no next step is clear, reply NONE.';

export type AgentKind = 'claude' | 'codex';

const CLAUDE_SCREEN = /\? for shortcuts|shift\+tab to cycle/i;
const CODEX_SCREEN = /Ask Codex|app=codex|ctrl\s*\+\s*t\s+transcript|context left|OpenAI Codex/i;

/**
 * Which agent is on screen. Sessions are often plain shells where the user typed
 * "claude", so the template alone misses them and the screen has to be read too.
 */
export function detectAgent(templateId: string, screen: string): AgentKind | null {
  if (templateId === 'claude-code') return 'claude';
  // Codex first: its screen also says "? for shortcuts".
  if (templateId === 'codex' || CODEX_SCREEN.test(screen)) return 'codex';
  return CLAUDE_SCREEN.test(screen) ? 'claude' : null;
  return null;
}

/** Turn a model reply into text fit to type, or null when there is nothing to offer. */
export function cleanSuggestion(reply: string): string | null {
  const firstLine = reply.trim().split(/\r?\n/)[0] ?? '';
  const text = firstLine
    .replace(/^[>›❯\s]+/, '')
    .replace(/^["'“‘`]+|["'”’`]+$/g, '')
    .trim();
  if (!text || /^none\.?$/i.test(text) || text.length > MAX_SUGGESTION_CHARS) return null;
  return text;
}
