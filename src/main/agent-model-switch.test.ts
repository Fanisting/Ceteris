/**
 * @file src/main/agent-model-switch.test.ts
 * @purpose Rules of AgentModelSwitcher (ADR-038): clear the input, check it reads /exit before
 *   Enter (a draft left in place is never sent), wait for the shell
 *   prompt, read the id the agent printed, type the relaunch line; the certain-id fallback;
 *   a new conversation when there is no id; every refusal; nothing typed after a timeout.
 *   All deps are fakes; no PTY, no files.
 */
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionInfo, Template } from '@shared/types';
import {
  AgentModelSwitcher,
  CLEAR_KEYS,
  EXIT_TIMEOUT_MS,
  READY_POLL_MS,
  READY_QUIET_MS,
  READY_TIMEOUT_MS,
  type ModelSwitchDeps,
} from './agent-model-switch';

const PRINTED = '7ad8b104-47e5-4db9-a802-25da7c8ee1c0';
const KNOWN = '13208c32-d229-4a96-aba2-42d521ce729b';
/** Ctrl-K and Ctrl-U, one key per write */
const CLEAR = CLEAR_KEYS;
const N = CLEAR_KEYS.length;
/** Claude Code's screen once "/exit" is typed into an empty input box */
const EXIT_TYPED = '──────\n❯ /exit\n──────\n  ❯ /exit      Exit the CLI';

function session(over: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: 's1',
    pathId: 'C:\\p',
    templateId: 'claude-code',
    originalCwd: 'C:\\p',
    currentCwd: 'C:\\p',
    cols: 80,
    rows: 24,
    pid: 1,
    displayName: 'Claude Code',
    ownerWindowId: 'w',
    state: 'idle',
    agentPhase: 'done',
    createdAt: 0,
    agentModel: 'opus',
    agentEffort: 'high',
    ...over,
  };
}

function template(over: Partial<Template> = {}): Template {
  return {
    id: 'claude-code',
    name: 'Claude Code',
    icon: 'C',
    isBuiltin: true,
    command: 'claude',
    args: [],
    env: {},
    shellFirst: true,
    postExitAction: 'keep_shell',
    ...over,
  };
}

interface Harness {
  switcher: AgentModelSwitcher;
  events: EventEmitter;
  written: string[];
  picks: unknown[];
  forgotten: string[];
  /** Every setSwitching call, in order */
  switching: unknown[];
  /** Waits of READY_POLL_MS, i.e. screen reads while waiting for the relaunched agent */
  readyPolls: () => number;
}

function harness(
  opts: {
    s?: SessionInfo | null;
    t?: Template | null;
    local?: boolean;
    /** What the screen shows after the agent exits */
    screen?: string;
    /** What the input box shows once "/exit" is typed (default: exactly "/exit") */
    inputScreen?: string;
    /** The certain id from files; default none */
    knownId?: string | null;
    /** Emit the prompt report as soon as /exit + Enter is typed */
    promptOnExit?: boolean;
    /**
     * The screen once the relaunch line is typed, one entry per read (the last repeats).
     * Default: the agent's input box right below the line, so the wait ends at once.
     */
    back?: string[];
    /** Emit the prompt report once the relaunch line is typed (the agent did not start) */
    promptAfterRelaunch?: boolean;
    /** Called after each screen read while waiting for the relaunched agent */
    onPoll?: (count: number) => void;
  } = {},
): Harness {
  const events = new EventEmitter();
  const written: string[] = [];
  const picks: unknown[] = [];
  const forgotten: string[] = [];
  const switching: unknown[] = [];
  let polls = 0;
  let backReads = 0;
  const s = opts.s === undefined ? session() : opts.s;
  // The relaunch line is the only write after the exit Enter that is longer than one key
  const relaunched = (): string | undefined =>
    written.slice(written.indexOf('\r') + 1).find((w) => w.length > 1);
  const deps: ModelSwitchDeps = {
    session: () => s,
    template: () =>
      opts.t === undefined
        ? template({
            id: s?.templateId ?? 'x',
            command: s?.templateId === 'codex' ? 'codex' : 'claude',
          })
        : opts.t,
    isLocal: () => opts.local ?? true,
    write: (_id, text) => {
      written.push(text);
      if (opts.promptOnExit !== false && text === '\r' && written.at(-2) === '/exit') {
        queueMicrotask(() => events.emit('shellPrompt', { sessionId: 's1' }));
      }
      if (opts.promptAfterRelaunch && text === '\r' && written.at(-2) === relaunched()) {
        events.emit('shellPrompt', { sessionId: 's1' });
      }
      return true;
    },
    events,
    // Before Enter the screen shows the input box; after it, what the agent printed on exit;
    // once the relaunch line is typed, `back` (default: the new agent's box below the line)
    screenOf: () => {
      const line = relaunched();
      if (line && written.at(-1) === '\r' && written.at(-2) === line) {
        const back = opts.back ?? [
          `${opts.screen ?? ''}\nPS C:\\p> ${line}\n❯\u00a0Try "fix lint"`,
        ];
        return back[Math.min(backReads++, back.length - 1)]!;
      }
      return written.includes('\r') ? (opts.screen ?? '') : (opts.inputScreen ?? EXIT_TYPED);
    },
    resumeIdOf: async () => opts.knownId ?? null,
    setPick: (_id, pick) => picks.push(pick),
    setSwitching: (_id, value) => switching.push(value),
    forgetUsage: (id) => forgotten.push(id),
    newId: () => 'new-id',
    sleep: async (ms) => {
      if (ms !== READY_POLL_MS) return;
      polls++;
      opts.onPoll?.(polls);
    },
  };
  return {
    switcher: new AgentModelSwitcher(deps),
    events,
    written,
    picks,
    forgotten,
    switching,
    readyPolls: () => polls,
  };
}

const claudeExit = `Resume this session with:\nclaude --model opus --effort high --resume ${PRINTED}\nPS C:\\p>`;

describe('AgentModelSwitcher', () => {
  it('clears the input, exits, and resumes the conversation the agent printed', async () => {
    const h = harness({ screen: claudeExit, knownId: KNOWN });
    expect(await h.switcher.switch('s1', { model: 'sonnet' })).toEqual({
      applied: true,
      resumed: true,
    });
    expect(h.written).toEqual([
      ...CLEAR,
      '/exit',
      '\r',
      `claude --resume ${PRINTED} --model sonnet --effort high`,
      '\r',
    ]);
    expect(h.picks).toEqual([{ model: 'sonnet', effort: 'high', launchId: PRINTED }]);
    expect(h.forgotten).toEqual(['s1']);
  });

  it('resumes Codex by the id it printed, with -m and an unquoted effort override', async () => {
    const h = harness({
      s: session({ templateId: 'codex', agentModel: '', agentEffort: '' }),
      screen: `To continue this session, run:\n  codex resume ${PRINTED}\n`,
    });
    await h.switcher.switch('s1', { model: 'gpt-x', effort: 'xhigh' });
    expect(h.written[N + 2]).toBe(
      `codex resume ${PRINTED} -m gpt-x -c model_reasoning_effort=xhigh`,
    );
  });

  it('falls back to the certain id from files when the agent printed none', async () => {
    const h = harness({ knownId: KNOWN });
    await h.switcher.switch('s1', { model: 'haiku' });
    expect(h.written[N + 2]).toBe(`claude --resume ${KNOWN} --model haiku --effort high`);
  });

  it('starts a new conversation, and says so, when no id is printed or known', async () => {
    const h = harness();
    expect(await h.switcher.switch('s1', { effort: 'max' })).toEqual({
      applied: true,
      resumed: false,
    });
    expect(h.written[N + 2]).toBe('claude --session-id new-id --model opus --effort max');
    expect(h.picks).toEqual([{ model: 'opus', effort: 'max', launchId: 'new-id' }]);
  });

  it('keeps plain template arguments in front', async () => {
    const h = harness({ t: template({ args: ['--verbose'] }), screen: claudeExit });
    await h.switcher.switch('s1', { model: 'haiku' });
    expect(h.written[N + 2]).toBe(
      `claude --verbose --resume ${PRINTED} --model haiku --effort high`,
    );
  });

  it('never presses Enter while a draft is left in the input box, and erases its /exit', async () => {
    const h = harness({ inputScreen: '──────\n❯ http://example.invalid/#/home//exit\n──────' });
    expect(await h.switcher.switch('s1', { model: 'sonnet' })).toEqual({
      applied: false,
      reason: 'input-not-clear',
    });
    expect(h.written).toEqual([...CLEAR, '/exit', '\x7f'.repeat(5)]);
    expect(h.picks).toEqual([]);
  });

  describe('switching loader (ADR-054)', () => {
    const line = `claude --resume ${PRINTED} --model sonnet --effort high`;

    it('marks the tab with what was asked for, and clears it when the switch ends', async () => {
      const h = harness({ screen: claudeExit });
      await h.switcher.switch('s1', { model: 'sonnet' });
      expect(h.switching).toEqual([{ model: 'sonnet' }, null]);
    });

    it('clears the mark when the switch stops before the relaunch', async () => {
      const h = harness({ inputScreen: '❯ some draft/exit' });
      await h.switcher.switch('s1', { effort: 'low' });
      expect(h.switching).toEqual([{ effort: 'low' }, null]);
    });

    it('waits until the relaunched agent shows its input box on a still screen', async () => {
      const banner = `${claudeExit}\nPS C:\\p> ${line}\n Claude Code v2`;
      const boxed = `${banner}\n❯\u00a0Try "fix lint"`;
      const h = harness({ screen: claudeExit, back: [banner, banner, banner, boxed] });
      await h.switcher.switch('s1', { model: 'sonnet' });
      // Three reads without the box, then reads until the box has been still long enough
      expect(h.readyPolls()).toBe(3 + READY_QUIET_MS / READY_POLL_MS);
      expect(h.switching.at(-1)).toBeNull();
    });

    it('does not take the old agent box above the typed line for the new one', async () => {
      const h = harness({
        screen: claudeExit,
        back: [`❯\u00a0/exit\n${claudeExit}\nPS C:\\p> ${line}\n Resuming`],
      });
      await h.switcher.switch('s1', { model: 'sonnet' });
      expect(h.readyPolls()).toBe(READY_TIMEOUT_MS / READY_POLL_MS + 1);
      expect(h.switching.at(-1)).toBeNull();
    });

    it('stops waiting when the shell prompt comes back (the agent did not start)', async () => {
      const h = harness({
        screen: claudeExit,
        back: ['claude: not found'],
        promptAfterRelaunch: true,
      });
      expect(await h.switcher.switch('s1', { model: 'sonnet' })).toEqual({
        applied: true,
        resumed: true,
      });
      expect(h.readyPolls()).toBe(0);
      expect(h.switching).toEqual([{ model: 'sonnet' }, null]);
    });

    it('stops waiting when the relaunched agent asks a question', async () => {
      const s = session();
      const h = harness({
        s,
        screen: claudeExit,
        back: ['Do you trust this folder?'],
        onPoll: (n) => {
          if (n === 2) s.agentPhase = 'blocked';
        },
      });
      await h.switcher.switch('s1', { model: 'sonnet' });
      expect(h.readyPolls()).toBe(2);
      expect(h.switching.at(-1)).toBeNull();
    });
  });

  describe('refusals type nothing', () => {
    const cases: Array<[string, Parameters<typeof harness>[0], string]> = [
      ['unknown tab', { s: null }, 'session-not-found'],
      ['shell tab', { s: session({ templateId: 'shell' }) }, 'not-agent'],
      ['exited tab', { s: session({ state: 'exited' }) }, 'exited'],
      ['mid-turn', { s: session({ agentPhase: 'working' }) }, 'busy'],
      ['waiting on approval', { s: session({ agentPhase: 'blocked' }) }, 'busy'],
      ['SSH tab', { local: false }, 'cannot-restart'],
      [
        'template closes with the agent',
        { t: template({ postExitAction: 'close_session' }) },
        'cannot-restart',
      ],
      ['template without a shell', { t: template({ shellFirst: false }) }, 'cannot-restart'],
      [
        'argument that is not a plain word',
        { t: template({ args: ['C:\\my dir'] }) },
        'cannot-restart',
      ],
    ];
    for (const [name, opts, reason] of cases) {
      it(name, async () => {
        const h = harness(opts);
        expect(await h.switcher.switch('s1', { model: 'sonnet' })).toEqual({
          applied: false,
          reason,
        });
        expect(h.written).toEqual([]);
        expect(h.picks).toEqual([]);
        expect(h.switching).toEqual([]);
      });
    }
  });

  describe('when the prompt does not come back', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('gives up after the timeout without typing the relaunch line', async () => {
      const h = harness({ promptOnExit: false });
      const done = h.switcher.switch('s1', { model: 'sonnet' });
      await vi.advanceTimersByTimeAsync(EXIT_TIMEOUT_MS + 10);
      expect(await done).toEqual({ applied: false, reason: 'exit-timeout' });
      expect(h.written).toEqual([...CLEAR, '/exit', '\r']);
    });

    it('answers busy to a second click while the first is running', async () => {
      const h = harness({ promptOnExit: false });
      const first = h.switcher.switch('s1', { model: 'sonnet' });
      await vi.advanceTimersByTimeAsync(0);
      expect(await h.switcher.switch('s1', { model: 'haiku' })).toEqual({
        applied: false,
        reason: 'busy',
      });
      h.events.emit('sessionExited', { sessionId: 's1' });
      expect(await first).toEqual({ applied: false, reason: 'exited' });
    });
  });
});
