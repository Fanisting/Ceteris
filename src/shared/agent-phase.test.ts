import { describe, expect, it } from 'vitest';
import { detectAgentPhase } from './agent-phase';
import type { AgentPhase, SessionState } from './types';

const CLAUDE_APPROVAL = [
  '╭──────────────────────────────────────────────╮',
  '│ Bash command                                 │',
  '│   npm test                                   │',
  '│ Do you want to proceed?                      │',
  '│ ❯ 1. Yes                                     │',
  "│   2. Yes, and don't ask again for npm test   │",
  '│   3. No, and tell Claude what to do (esc)    │',
  '╰──────────────────────────────────────────────╯',
].join('\n');

const CODEX_APPROVAL = [
  'Would you like to run the following command?',
  '  $ cargo build',
  '› 1. Yes, proceed (y)',
  "  2. Yes, and don't ask again for this command (a)",
  '  3. No, and tell Codex what to do differently (esc)',
].join('\n');

const CLAUDE_WORKING = '✻ Thinking… (12s · ↑ 1.2k tokens · esc to interrupt)\n╭───╮\n│ > │\n╰───╯';
const CLAUDE_IDLE = '● Done.\n╭────────╮\n│ >      │\n╰────────╯\n  ? for shortcuts';
const SHELL = 'PS C:\\proj> npm install\nadded 12 packages\nPS C:\\proj>';

describe('detectAgentPhase', () => {
  it('reads each phase from the screen', () => {
    const cases: Array<[string, string, SessionState, AgentPhase | null]> = [
      // An approval prompt blocks even in a plain shell, where `claude` was typed.
      ['shell', CLAUDE_APPROVAL, 'idle', 'blocked'],
      ['codex', CODEX_APPROVAL, 'active', 'blocked'],
      ['shell', CLAUDE_WORKING, 'idle', 'working'],
      ['claude-code', 'some output', 'active', 'working'],
      ['shell', CLAUDE_IDLE, 'idle', 'done'],
      ['shell', SHELL, 'idle', null],
      ['shell', SHELL, 'active', null],
      ['claude-code', CLAUDE_APPROVAL, 'exited', null],
      // A question in the agent's prose is not a prompt without a "Yes" option line.
      ['claude-code', 'Do you want to keep the old API?\n? for shortcuts', 'idle', 'done'],
    ];
    const wrong = cases
      .map(([tpl, screen, state, want]) => ({ tpl, state, want, got: detectAgentPhase(tpl, screen, state) }))
      .filter((c) => c.got !== c.want);
    expect(wrong).toEqual([]);
  });

  it('ignores markers that scrolled above the searched rows', () => {
    const scrolled = [CLAUDE_APPROVAL, ...Array.from({ length: 25 }, (_, i) => `line ${i}`)].join('\n');
    expect(detectAgentPhase('shell', scrolled, 'idle')).toBeNull();
  });
});
