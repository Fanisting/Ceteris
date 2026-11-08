/**
 * @file src/shared/agent-phase.ts
 * @purpose Reads what a Claude Code or Codex session is doing from the end of its screen:
 *   working, blocked on the user's approval, or done and waiting for the next prompt.
 *   Pure, so the rules can be tested without a PTY.
 *
 * @关键设计:
 * - The screen is the source, not the byte rate. An agent at an approval prompt sends no
 *   bytes, exactly like one that finished, and only the screen tells them apart.
 * - The approval and "esc to interrupt" rules apply to any session, because an agent
 *   started by typing `claude` in a plain shell hides the markers detectAgent looks for
 *   while a prompt is open.
 * - "done" needs a detected agent, so a plain shell that goes quiet stays null and keeps
 *   the old output-driven wave.
 * - Wording checked against the installed binaries on 2026-11-07: Claude Code "Do you
 *   want to proceed?" / "Do you want to make this edit to <file>?", Codex "Would you like
 *   to run the following command?" / "... make the following edits?", both "esc to
 *   interrupt" while working, and options that start with "Yes". An agent update that
 *   rewords these falls back to the output-driven wave, never to a wrong state.
 *
 * @对应文档章节:软件定义书.md ADR-020
 */
import { detectAgent } from './next-prompt';
import type { AgentPhase, SessionState } from './types';

/** Rows of the screen end searched; an approval box with its options fits in this. */
export const AGENT_PHASE_SCREEN_ROWS = 20;

/** Rows searched for the agent's own markers. Few, so a shell after `/exit` stops matching. */
const AGENT_MARKER_ROWS = 12;

const APPROVAL_QUESTION = /\b(Do you want to|Would you like to)\b[^\n]*\?/;
/** An option line: box border or pointer, an optional number, then "Yes". */
const APPROVAL_YES_OPTION = /^[\s│|❯›>]*(\d+\.\s*)?Yes\b/m;
const WORKING = /\besc to interrupt\b/i;

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
  const rows = screen.split('\n');
  const tail = rows.slice(-AGENT_PHASE_SCREEN_ROWS).join('\n');
  if (APPROVAL_QUESTION.test(tail) && APPROVAL_YES_OPTION.test(tail)) return 'blocked';
  if (WORKING.test(tail)) return 'working';
  const agent = detectAgent(templateId, rows.slice(-AGENT_MARKER_ROWS).join('\n'));
  if (!agent) return null;
  return state === 'active' ? 'working' : 'done';
}
