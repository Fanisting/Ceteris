/**
 * @file src/shared/agent-phase.ts
 * @purpose Reads what a Claude Code or Codex session is doing from the end of its screen:
 *   working, blocked on the user's approval, or done and waiting for the next prompt; and
 *   while working, what kind of work (generating, running a tool, waiting) and how fast it
 *   generates. Pure, so the rules can be tested without a PTY.
 *
 * @关键设计:
 * - The screen is the source, not the byte rate. An agent at an approval prompt sends no
 *   bytes, exactly like one that finished, and only the screen tells them apart. The byte
 *   rate is no use for pace either: Claude Code redraws its spinner and timers all the time,
 *   so thinking, running a tool and writing all measured 650 to 760 B/s on 2026-11-08.
 * - Pace comes from the token counter on Claude Code's spinner line instead. It rises while
 *   the model generates and stands still while a tool runs.
 * - The approval and working rules apply to any session, because an agent started by typing
 *   `claude` in a plain shell hides the markers detectAgent looks for while a prompt is open.
 * - "done" needs a detected agent, so a plain shell that goes quiet stays null and keeps
 *   the old output-driven wave.
 * - Wording checked against the installed binaries on 2026-11-07 (approval prompts) and a
 *   recorded Claude Code 2026-11 screen on 2026-11-08 (spinner, tool rows). Codex was not
 *   recorded: it gets phases from "esc to interrupt" and the approval prompt, and no work
 *   kind or pace. An agent update that rewords these falls back to the plain wave, never
 *   to a wrong state.
 *
 * @对应文档章节:软件定义书.md ADR-021
 */
import { detectAgent } from './next-prompt';
import type { AgentPhase, AgentWork, SessionState } from './types';

/**
 * Rows of the screen end that main reads. Claude Code leaves about ten blank rows between a
 * tool's output and its spinner, and a status line adds more below, so this is generous;
 * the rules then look only at the non-empty rows within it.
 */
export const AGENT_PHASE_SCREEN_ROWS = 60;

/** Non-empty rows searched; an approval box with its options fits in this. */
const SEARCH_ROWS = 20;

/** Non-empty rows searched for the agent's own markers. Few, so a shell after `/exit` stops matching. */
const AGENT_MARKER_ROWS = 12;

const APPROVAL_QUESTION = /\b(Do you want to|Would you like to)\b[^\n]*\?/;
/** An option line: box border or pointer, an optional number, then "Yes". */
const APPROVAL_YES_OPTION = /^[\s│|❯›>]*(\d+\.\s*)?Yes\b/m;
/** Codex, and older Claude Code versions. */
const ESC_TO_INTERRUPT = /\besc to interrupt\b/i;
/** Claude Code's spinner line: a star glyph, a random verb, an ellipsis ("✻ Cogitating…"). */
const SPINNER = /^\s*[✶✻✽✢✳·*] \S+…/m;
/** The token counter on the spinner line: "↓ 94 tokens", "↓ 1.9k tokens". */
const TOKENS = /↓ ([\d.]+)(k?) tokens/;
/**
 * A running tool's header: its description, then a live timer outside any parentheses
 * ("● Running the ping command · 14s"). The spinner line's timer sits inside parentheses,
 * and a finished tool's header ("Ran 1 shell command") has no timer.
 */
const TOOL_HEADER = /^[^(\n]*\S · (?:\d+h )?(?:\d+m )?\d+s$/m;
/** The result line under a tool header. */
const TOOL_BODY = /^\s*⎿\s/m;

/** Tokens per second that counts as generating rather than waiting on hooks or the API. */
const GENERATING_MIN_RATE = 2;
/** Tokens per second that reads as full pace. */
const FULL_PACE_RATE = 80;

/** The last non-empty rows of the screen, so blank padding does not push markers out. */
function screenTail(screen: string, rows: number): string {
  return screen
    .split('\n')
    .filter((row) => row.trim() !== '')
    .slice(-rows)
    .join('\n');
}

/**
 * The phase of a session from the end of its rendered screen.
 *
 * @param templateId the session's template; 'claude-code' and 'codex' count as agents
 * @param screen the last rows of the rendered screen, oldest first, joined by "\n"
 * @param state the output-driven state; 'active' means bytes arrived recently
 * @returns null for a session that shows no agent, which keeps the output-driven wave
 */
export function detectAgentPhase(
  templateId: string,
  screen: string,
  state: SessionState,
): AgentPhase | null {
  if (state === 'exited') return null;
  const tail = screenTail(screen, SEARCH_ROWS);
  if (APPROVAL_QUESTION.test(tail) && APPROVAL_YES_OPTION.test(tail)) return 'blocked';
  if (ESC_TO_INTERRUPT.test(tail) || SPINNER.test(tail)) return 'working';
  const agent = detectAgent(templateId, screenTail(screen, AGENT_MARKER_ROWS));
  if (!agent) return null;
  return state === 'active' ? 'working' : 'done';
}

/** What the screen of a working agent shows, before the token rate is known. */
export interface WorkSignals {
  /** A tool header with a live timer and its result line are on screen. */
  tool: boolean;
  /** Claude Code's spinner line is on screen. */
  spinner: boolean;
  /** The spinner's token count, or null when it shows none yet (or it is Codex). */
  tokens: number | null;
}

/** Reads the work signals from the end of a working agent's screen. */
export function readWorkSignals(screen: string): WorkSignals {
  const tail = screenTail(screen, SEARCH_ROWS);
  const m = TOKENS.exec(tail);
  const tokens = m ? Math.round(parseFloat(m[1]!) * (m[2] ? 1000 : 1)) : null;
  return {
    tool: TOOL_HEADER.test(tail) && TOOL_BODY.test(tail),
    spinner: SPINNER.test(tail),
    tokens: tokens !== null && Number.isFinite(tokens) ? tokens : null,
  };
}

/** A smoothed token rate, carried from one screen read to the next. */
export interface TokenRate {
  tokens: number;
  at: number;
  /** Tokens per second, smoothed. */
  rate: number;
}

/**
 * Folds one token reading into the smoothed rate.
 *
 * @param prev the previous reading, or null at the start of a turn
 * @param tokens the counter now; null when the spinner shows none, which ends the turn
 * @param at the time of the reading in ms
 * @returns null when there is no counter
 */
export function updateTokenRate(prev: TokenRate | null, tokens: number | null, at: number): TokenRate | null {
  if (tokens === null) return null;
  // A smaller count means a new turn started from zero.
  if (!prev || tokens < prev.tokens) return { tokens, at, rate: 0 };
  const dt = (at - prev.at) / 1000;
  if (dt <= 0) return prev;
  const instant = (tokens - prev.tokens) / dt;
  // Counts above 1000 move in steps of 100 ("1.9k"), so smooth hard enough to hide the steps.
  return { tokens, at, rate: prev.rate * 0.6 + instant * 0.4 };
}

/**
 * The kind of work and its pace, from the screen signals and the token rate.
 *
 * @returns work null when the screen shows no kind (Codex), so the renderer draws the plain
 *   wave; pace 0.25 to 1 in quarter steps while generating, null otherwise. Quarter steps
 *   keep the state-changed events down to a few per turn.
 */
export function classifyWork(
  signals: WorkSignals,
  rate: TokenRate | null,
): { work: AgentWork | null; pace: number | null } {
  if (signals.tool) return { work: 'tool', pace: null };
  if (!signals.spinner) return { work: null, pace: null };
  const r = rate?.rate ?? 0;
  if (r < GENERATING_MIN_RATE) return { work: 'waiting', pace: null };
  const pace = Math.max(0.25, Math.min(1, Math.ceil((r / FULL_PACE_RATE) * 4) / 4));
  return { work: 'generating', pace };
}
