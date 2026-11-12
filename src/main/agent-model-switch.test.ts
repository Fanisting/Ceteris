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
  } = {},
): Harness {
  const events = new EventEmitter();
  const written: string[] = [];
  const picks: unknown[] = [];
  const forgotten: string[] = [];
  const s = opts.s === undefined ? session() : opts.s;
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
      return true;
    },
    events,
    // Before Enter the screen shows the input box; after it, what the agent printed on exit
    screenOf: () =>
      written.includes('\r') ? (opts.screen ?? '') : (opts.inputScreen ?? EXIT_TYPED),
    resumeIdOf: async () => opts.knownId ?? null,
    setPick: (_id, pick) => picks.push(pick),
    forgetUsage: (id) => forgotten.push(id),
    newId: () => 'new-id',
    sleep: async () => undefined,
  };
  return { switcher: new AgentModelSwitcher(deps), events, written, picks, forgotten };
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
