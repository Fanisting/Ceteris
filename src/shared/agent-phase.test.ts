import { describe, expect, it } from 'vitest';
import { classifyWork, detectAgentPhase, readWorkSignals, updateTokenRate } from './agent-phase';
import type { AgentPhase, SessionState } from './types';

// Rows recorded from Claude Code on 2026-11-08 (HUD lines dropped). The spinner line has no
// "esc to interrupt" in this version.
const REC_FOOTER = [
  '────────────────────────────────────────',
  '❯',
  '────────────────────────────────────────',
  '  ⏵⏵ auto mode on (shift+tab to cycle)',
].join('\n');
const REC_THINKING = `✻ Cogitating… (5s · ↓ 24 tokens)\n${REC_FOOTER}`;
const REC_TOOL = [
  '● Running the ping command for about 11 seconds · 14s',
  '  ⎿  $ ping -n 12 127.0.0.1',
  '✶ Cogitating… (19s · ↓ 94 tokens)',
  REC_FOOTER,
].join('\n');
const REC_TOOL_DONE = [
  '  Ran 1 shell command',
  '● The ping finished: 12 packets sent, 12 received, 0% loss.',
  '  Green tea comes from the leaves of Camellia sinensis.',
  '✻ Cogitating… (45s · ↓ 1.9k tokens · thought for 6s)',
  REC_FOOTER,
].join('\n');

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

// Claude Code 2.1.319's AskUserQuestion prompt, recorded on 2026-11-10 (ADR-035).
const CLAUDE_CHOICE = [
  '────────────────────────────────────────',
  ' ☐ Colour ',
  'Which colour do you prefer?',
  '❯ 1. Red (Recommended)',
  '     Choose red.',
  '  2. Blue',
  '     Choose blue.',
  '  3. Type something.',
  '────────────────────────────────────────',
  '  4. Chat about this',
  'Enter to select · ↑/↓ to navigate · Esc to cancel',
].join('\n');
// The same prompt in a short terminal: the footer and the chat row scrolled off.
const CLAUDE_CHOICE_NO_FOOTER = CLAUDE_CHOICE.split('\n').slice(0, 8).join('\n');

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
      // ADR-035: a choice prompt blocks like an approval, in a plain shell too.
      ['shell', CLAUDE_CHOICE, 'idle', 'blocked'],
      ['claude-code', CLAUDE_CHOICE, 'active', 'blocked'],
      // Without its footer and chat row, the option rows alone are just a numbered list.
      ['claude-code', CLAUDE_CHOICE_NO_FOOTER, 'idle', 'done'],
      // A numbered list in the agent's answer, with the pointer on the input line below.
      [
        'claude-code',
        '● Two options:\n  1. Keep it\n  2. Drop it\n❯\n? for shortcuts',
        'idle',
        'done',
      ],
      // The footer alone (a picker the user opened) is not a prompt without a pointed option.
      [
        'claude-code',
        'Select model\n  Opus\n  Sonnet\nEnter to select · Esc to cancel\n? for shortcuts',
        'idle',
        'done',
      ],
      // The spinner line alone means working, even with no output for a moment.
      ['shell', REC_THINKING, 'idle', 'working'],
      ['shell', `● Done.\n${REC_FOOTER}`, 'idle', 'done'],
    ];
    const wrong = cases
      .map(([tpl, screen, state, want]) => ({
        tpl,
        state,
        want,
        got: detectAgentPhase(tpl, screen, state),
      }))
      .filter((c) => c.got !== c.want);
    expect(wrong).toEqual([]);
  });

  it('ignores markers that scrolled above the searched rows', () => {
    const scrolled = [CLAUDE_APPROVAL, ...Array.from({ length: 25 }, (_, i) => `line ${i}`)].join(
      '\n',
    );
    expect(detectAgentPhase('shell', scrolled, 'idle')).toBeNull();
  });
});

describe('agent work and pace', () => {
  it('reads the work signals from recorded screens', () => {
    expect(readWorkSignals(REC_THINKING)).toEqual({ tool: false, spinner: true, tokens: 24 });
    expect(readWorkSignals(REC_TOOL)).toEqual({ tool: true, spinner: true, tokens: 94 });
    // A finished tool keeps its result line but loses the live timer.
    expect(readWorkSignals(REC_TOOL_DONE)).toEqual({ tool: false, spinner: true, tokens: 1900 });
  });

  it('classifies work from the token rate', () => {
    const spin = { tool: false, spinner: true, tokens: 0 };
    const at = (rate: number) => ({ tokens: 0, at: 0, rate });
    const cases: Array<[Parameters<typeof classifyWork>, ReturnType<typeof classifyWork>]> = [
      [[{ ...spin, tool: true }, at(50)], { work: 'tool', pace: null }],
      [[spin, null], { work: 'waiting', pace: null }],
      [[spin, at(1)], { work: 'waiting', pace: null }],
      [[spin, at(10)], { work: 'generating', pace: 0.25 }],
      [[spin, at(50)], { work: 'generating', pace: 0.75 }],
      [[spin, at(500)], { work: 'generating', pace: 1 }],
      // Codex shows no spinner: no work kind, so the plain wave.
      [[{ tool: false, spinner: false, tokens: null }, null], { work: null, pace: null }],
    ];
    const wrong = cases.filter(
      ([args, want]) => JSON.stringify(classifyWork(...args)) !== JSON.stringify(want),
    );
    expect(wrong).toEqual([]);
  });

  it('smooths the token rate and restarts it on a new turn', () => {
    const a = updateTokenRate(null, 100, 0)!;
    const b = updateTokenRate(a, 200, 1000)!;
    expect(b.rate).toBeCloseTo(40);
    expect(updateTokenRate(b, 5, 2000)).toEqual({ tokens: 5, at: 2000, rate: 0 });
    expect(updateTokenRate(b, null, 2000)).toBeNull();
  });
});
