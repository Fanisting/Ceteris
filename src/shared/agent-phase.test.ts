import { describe, expect, it } from 'vitest';
import {
  classifyWork,
  detectAgentPhase,
  moveKeys,
  oneLineAnswer,
  readChoicePrompt,
  readWorkSignals,
  updateTokenRate,
} from './agent-phase';
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

describe('readChoicePrompt (ADR-035)', () => {
  // Screens recorded from Claude Code 2.1.319 to 2.1.322 on 2026-11-10, HUD rows dropped.
  const RULE = '─'.repeat(40);
  const PAGED_Q1 = [
    RULE,
    '←  ☐ Colour  ☐ Size  ✔ Submit  →',
    'Which colour?',
    '❯ 1. Red',
    '     Red',
    '  2. Blue',
    '     Blue',
    '  3. Type something.',
    RULE,
    '  4. Chat about this',
    'Enter to select · Tab/Arrow keys to navigate · Esc to cancel',
  ].join('\n');
  // Stepped back to page two after answering it: the earlier answer carries a ✔.
  const PAGED_Q2_BACK = [
    '←  ☒ Colour  ☒ Size  ✔ Submit  →',
    'Which size?',
    '❯ 1. Small ✔',
    '     Small',
    '  2. Large',
    '     Large',
    '  3. Type something.',
    RULE,
    '  4. Chat about this',
    'Enter to select · Tab/Arrow keys to navigate · Esc to cancel',
  ].join('\n');
  // The review page has no footer.
  const REVIEW = [
    RULE,
    '←  ☒ Colour  ☒ Size  ✔ Submit  →',
    'Review your answers',
    ' ● Which colour?',
    '   → Red',
    ' ● Which size?',
    '   → Small',
    'Ready to submit your answers?',
    '❯ 1. Submit answers',
    '  2. Cancel',
  ].join('\n');
  const MULTI = [
    '←  ☒ Fruit  ✔ Submit  →',
    'Which fruits?',
    '  1. [✔] Apple',
    '         Apple',
    '❯ 2. [✔] Pear',
    '         Pear',
    '  3. [ ] Plum',
    '         Plum',
    '  4. [ ] Type something',
    '     Submit',
    RULE,
    '  5. Chat about this',
    'Enter to select · ↑/↓ to navigate · Esc to cancel',
  ].join('\n');
  // Multi-select after typing "Kiwi" into its field, pointer moved on to the Submit row.
  const MULTI_ON_SUBMIT = MULTI.replace('❯ 2.', '  2.')
    .replace('  4. [ ] Type something', '  4. [✔] Kiwi')
    .replace('     Submit', '❯    Submit');
  // Single-select with "Green please" typed into the field.
  const TYPED = [
    ' ☐ Colour ',
    'Which colour?',
    '  1. Red',
    '  2. Blue',
    '❯ 3. Green please',
    RULE,
    '  4. Chat about this',
    'Enter to select · ↑/↓ to navigate · ctrl+g to edit in Notepad · Esc to cancel',
  ].join('\n');
  // Claude Code 2.1.322's file approval: option 2 wraps, option 3 is a plain "No".
  const APPROVAL_2_1_322 = [
    ' Do you want to create approval-probe.txt?',
    ' ❯ 1. Yes',
    '   2. Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session;',
    '      Yes, and always allow access to C:\\tmp for this session (shift+tab)',
    '   3. No',
    ' Esc to cancel · Tab to amend',
  ].join('\n');

  it('reads a one-page prompt with option descriptions', () => {
    expect(readChoicePrompt(CLAUDE_CHOICE)).toEqual({
      question: 'Which colour do you prefer?',
      options: [
        {
          index: 1,
          label: 'Red (Recommended)',
          description: 'Choose red.',
          pos: 0,
          pointed: true,
          input: 'none',
          checked: null,
          chosen: false,
        },
        {
          index: 2,
          label: 'Blue',
          description: 'Choose blue.',
          pos: 1,
          pointed: false,
          input: 'none',
          checked: null,
          chosen: false,
        },
        {
          index: 3,
          label: 'Type something.',
          description: '',
          pos: 2,
          pointed: false,
          input: 'type',
          checked: null,
          chosen: false,
        },
        {
          index: 4,
          label: 'Chat about this',
          description: '',
          pos: 3,
          pointed: false,
          input: 'chat',
          checked: null,
          chosen: false,
        },
      ],
      pointer: 0,
      multiSelect: false,
      steps: [],
      reviewing: false,
      review: [],
    });
  });

  it('reads approval prompts, old and new', () => {
    const old = readChoicePrompt(CLAUDE_APPROVAL);
    expect(old?.question).toBe('Do you want to proceed?');
    expect(old?.options.map((o) => [o.label, o.input])).toEqual([
      ['Yes', 'none'],
      ["Yes, and don't ask again for npm test", 'none'],
      ['No, and tell Claude what to do (esc)', 'chat'],
    ]);
    const now = readChoicePrompt(APPROVAL_2_1_322);
    expect(now?.question).toBe('Do you want to create approval-probe.txt?');
    expect(now?.options.map((o) => [o.label, o.input])).toEqual([
      ['Yes', 'none'],
      [
        'Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session;',
        'none',
      ],
      ['No', 'none'],
    ]);
    expect(now?.options[1]?.description).toBe(
      'Yes, and always allow access to C:\\tmp for this session (shift+tab)',
    );
    expect(readChoicePrompt(CODEX_APPROVAL)?.options.map((o) => o.pointed)).toEqual([
      true,
      false,
      false,
    ]);
  });

  it('reads the pages of a several-question prompt', () => {
    const q1 = readChoicePrompt(PAGED_Q1);
    expect(q1?.steps).toEqual([
      { label: 'Colour', done: false },
      { label: 'Size', done: false },
    ]);
    expect(q1?.question).toBe('Which colour?');
    const back = readChoicePrompt(PAGED_Q2_BACK);
    expect(back?.steps.map((s) => s.done)).toEqual([true, true]);
    expect(back?.options[0]).toMatchObject({ label: 'Small', chosen: true, pointed: true });
  });

  it('reads the review page that submits them', () => {
    expect(readChoicePrompt(REVIEW)).toMatchObject({
      question: 'Ready to submit your answers?',
      reviewing: true,
      review: ['● Which colour?', '→ Red', '● Which size?', '→ Small'],
      options: [
        { index: 1, label: 'Submit answers', pointed: true },
        { index: 2, label: 'Cancel', pointed: false },
      ],
    });
  });

  it('reads multi-select boxes and counts the unnumbered Submit row as a stop', () => {
    const p = readChoicePrompt(MULTI);
    expect(p?.multiSelect).toBe(true);
    expect(p?.options.map((o) => [o.label, o.checked, o.pos, o.input])).toEqual([
      ['Apple', true, 0, 'none'],
      ['Pear', true, 1, 'none'],
      ['Plum', false, 2, 'none'],
      ['Type something', false, 3, 'type'],
      ['Chat about this', null, 5, 'chat'],
    ]);
    expect(p?.pointer).toBe(1);
    // The pointer on the Submit row is still a live prompt; the typed row keeps its kind.
    const onSubmit = readChoicePrompt(MULTI_ON_SUBMIT);
    expect(onSubmit?.pointer).toBe(4);
    expect(onSubmit?.options[3]).toMatchObject({ label: 'Kiwi', checked: true, input: 'type' });
  });

  it('keeps the kind of a text field that already holds an answer', () => {
    expect(readChoicePrompt(TYPED)?.options[2]).toMatchObject({
      label: 'Green please',
      input: 'type',
      pointed: true,
    });
  });

  it('refuses rows that are not a live prompt', () => {
    // A numbered list in prose: no pointer.
    expect(readChoicePrompt('● Two options:\n  1. Keep it\n  2. Drop it\n❯')).toBeNull();
    // Numbers that do not start at 1 are not an option set.
    expect(readChoicePrompt('Pick:\n❯ 2. Second\n  3. Third')).toBeNull();
    expect(readChoicePrompt(SHELL)).toBeNull();
  });

  it('takes the last numbered run, so prose above the prompt does not count', () => {
    const screen = `● Plan:\n  1. Read the file\n  2. Fix the bug\n${CLAUDE_CHOICE}`;
    expect(readChoicePrompt(screen)?.options.map((o) => o.label)).toEqual([
      'Red (Recommended)',
      'Blue',
      'Type something.',
      'Chat about this',
    ]);
  });

  it('turns a move into arrow keys and makes typed answers one line', () => {
    expect(moveKeys(1, 1)).toBe('');
    expect(moveKeys(0, 2)).toBe('\x1b[B\x1b[B');
    expect(moveKeys(3, 2)).toBe('\x1b[A');
    expect(oneLineAnswer('  two\r\nlines\x07 ')).toBe('two lines');
  });

  it('counts the review page and a pointer on the chat row as blocked', () => {
    expect(detectAgentPhase('claude-code', REVIEW, 'idle')).toBe('blocked');
    const onChat = PAGED_Q1.replace('❯ 1. Red', '  1. Red').replace('  4. Chat', '❯ 4. Chat');
    expect(detectAgentPhase('claude-code', onChat, 'idle')).toBe('blocked');
    expect(detectAgentPhase('claude-code', MULTI_ON_SUBMIT, 'idle')).toBe('blocked');
  });
});
