import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { AgentUpdateNotice, AgentVersionInfo } from '@shared/protocol';
import type { SessionInfo } from '@shared/types';
import {
  AgentReloader,
  CONTINUE_PROMPT,
  EARLY_EXIT_MS,
  READY_TIMEOUT_MS,
  RESUME_ARGS,
  type AgentReloadDeps,
  type ReloadCreateInput,
} from './agent-reload';

vi.mock('./logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

let nextId = 1;

function session(over: Partial<SessionInfo> = {}): SessionInfo {
  const id = over.id ?? `s${nextId++}`;
  return {
    id,
    pathId: 'C:\\work\\a',
    templateId: 'claude-code',
    originalCwd: 'C:\\work\\a',
    currentCwd: 'C:\\work\\a',
    cols: 120,
    rows: 30,
    pid: 100,
    displayName: `tab ${id}`,
    ownerWindowId: 'w1',
    state: 'idle',
    agentPhase: 'done',
    createdAt: nextId,
    ...over,
  };
}

const ctx = { pathId: 'C:\\Users\\me', ownerWindowId: 'w1', cols: 120, rows: 30 };

interface Harness {
  reloader: AgentReloader;
  events: EventEmitter;
  sessions: SessionInfo[];
  created: ReloadCreateInput[];
  closed: string[];
  written: Array<[string, string]>;
  renamed: Array<[string, string]>;
  roles: Array<[string, string | null]>;
  notices: AgentUpdateNotice[];
  calls: string[];
  upgrade: Mock<[], Promise<number | null>>;
  /** 让某个开回来的终端到提示符 */
  ready: (sessionId: string) => void;
  exit: (sessionId: string) => void;
  version: { installed: string; status: AgentVersionInfo['status'] };
}

function setup(
  initial: SessionInfo[],
  over: Partial<AgentReloadDeps> & { exitCode?: number | null; createFails?: boolean } = {},
): Harness {
  const events = new EventEmitter();
  const sessions = [...initial];
  const created: ReloadCreateInput[] = [];
  const closed: string[] = [];
  const written: Array<[string, string]> = [];
  const renamed: Array<[string, string]> = [];
  const roles: Array<[string, string | null]> = [];
  const notices: AgentUpdateNotice[] = [];
  const calls: string[] = [];
  const manual = new Set(initial.filter((s) => s.displayName.startsWith('my ')).map((s) => s.id));
  const version = { installed: '1.0.0', status: 'outdated' as AgentVersionInfo['status'] };
  const upgrade = vi.fn(async () => {
    calls.push('upgrade');
    version.installed = '1.1.0';
    version.status = 'current';
    return over.exitCode === undefined ? 0 : over.exitCode;
  });
  const h: Harness = {
    reloader: null as unknown as AgentReloader,
    events,
    sessions,
    created,
    closed,
    written,
    renamed,
    roles,
    notices,
    calls,
    upgrade,
    version,
    ready: (id) => {
      const s = sessions.find((x) => x.id === id)!;
      s.state = 'idle';
      s.agentPhase = 'done';
      events.emit('sessionStateChanged', {
        sessionId: id,
        changes: { agentPhase: 'done' },
        full: { ...s },
      });
    },
    exit: (id) => {
      const s = sessions.find((x) => x.id === id)!;
      s.state = 'exited';
      events.emit('sessionExited', { sessionId: id, exitCode: 1 });
    },
  };
  h.reloader = new AgentReloader({
    sessions: () => sessions,
    screenOf: () => '',
    isLocal: (pathId) => !pathId.startsWith('ssh:'),
    hasWindow: (id) => id === 'w1',
    close: (id) => {
      calls.push(`close ${id}`);
      closed.push(id);
      const i = sessions.findIndex((s) => s.id === id);
      if (i >= 0) sessions.splice(i, 1);
    },
    create: async (input) => {
      calls.push(`create ${input.pathId}`);
      if (over.createFails) throw new Error('CwdNotAccessible');
      created.push(input);
      // 刚开的终端还没有 agent 相位
      const s = session({
        id: `n${created.length}`,
        pathId: input.pathId,
        templateId: input.templateId,
        ownerWindowId: input.ownerWindowId || null,
        cols: input.cols,
        rows: input.rows,
        state: 'active',
        agentPhase: null,
      });
      sessions.push(s);
      return s;
    },
    isManuallyRenamed: (id) => manual.has(id),
    rename: (id, name) => void renamed.push([id, name]),
    setRole: (id, role) => void roles.push([id, role]),
    write: (id, text) => {
      if (!sessions.some((s) => s.id === id && s.state !== 'exited')) return false;
      written.push([id, text]);
      return true;
    },
    events,
    upgrade,
    version: async () => ({ templateId: 'claude-code', ...version }),
    nameOf: () => 'Claude Code',
    notify: (n) => void notices.push(n),
    sleep: async () => {},
    ...over,
  });
  return h;
}

/** 等 reload 跑到"开回来并在等相位"的那一步 */
async function flush(): Promise<void> {
  for (let i = 0; i < 100; i++) await Promise.resolve();
}

/** 让所有等待 (早退窗口、提示符超时) 都到期,再拿结果 */
async function finish<T>(done: Promise<T>): Promise<T> {
  await flush();
  await vi.advanceTimersByTimeAsync(READY_TIMEOUT_MS + 1);
  return done;
}

describe('AgentReloader.plan', () => {
  beforeEach(() => {
    nextId = 1;
  });

  it('counts only live local tabs of that agent, with running and blocked', () => {
    const h = setup([
      session({ agentPhase: 'working' }),
      session({ agentPhase: 'blocked' }),
      session({ agentPhase: 'done' }),
      session({ state: 'exited', agentPhase: null }),
      session({ pathId: 'ssh:srv:/home', agentPhase: 'working' }),
      session({ templateId: 'codex', agentPhase: 'working' }),
    ]);
    expect(h.reloader.plan('claude-code')).toEqual({
      tabs: 3,
      running: 1,
      blocked: 1,
      otherTabs: 0,
      resumes: true,
      inProgress: false,
    });
  });

  it('reports shell tabs whose screen shows the same agent as otherTabs, untouched', async () => {
    const h = setup(
      [
        session({ id: 'c' }),
        session({ id: 'sh1', templateId: 'shell' }),
        session({ id: 'sh2', templateId: 'shell' }),
      ],
      { screenOf: (id) => (id === 'sh2' ? '> \n? for shortcuts' : 'PS C:\\> ') },
    );
    const plan = h.reloader.plan('claude-code');
    expect(plan.tabs).toBe(1);
    expect(plan.otherTabs).toBe(1);
    // a Codex reload does not count a shell running Claude Code
    expect(h.reloader.plan('codex').otherTabs).toBe(0);
    // shells are never in the reload list, whatever they run
    h.reloader.reload('claude-code', ctx);
    await flush();
    expect(h.closed).toEqual(['c']);
  });

  it('says whether the agent can resume a conversation', () => {
    const h = setup([]);
    expect(h.reloader.plan('claude-code').resumes).toBe(true);
    expect(h.reloader.plan('unknown-agent').resumes).toBe(false);
    expect(RESUME_ARGS['claude-code']).toEqual(['--continue']);
  });
});

describe('AgentReloader.reload', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    nextId = 1;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('closes only that agent, upgrades after closing, reopens in order with resume args', async () => {
    const h = setup([
      session({ id: 'a', pathId: 'C:\\work\\a', createdAt: 2 }),
      session({ id: 'b', pathId: 'C:\\work\\b', createdAt: 1, ownerWindowId: null }),
      session({ id: 'x', templateId: 'codex' }),
      session({ id: 'sh', templateId: 'shell' }),
    ]);
    const r = h.reloader.reload('claude-code', ctx);
    expect(r.started).toBe(true);
    expect(r.tabs).toBe(2);
    const result = await finish(r.done);
    expect(h.closed).toEqual(['b', 'a']);
    expect(h.calls).toEqual([
      'close b',
      'close a',
      'upgrade',
      'create C:\\work\\b',
      'create C:\\work\\a',
    ]);
    expect(h.upgrade).toHaveBeenCalledWith('claude-code', ctx);
    expect(h.created.map((c) => [c.pathId, c.ownerWindowId, c.extraArgs])).toEqual([
      ['C:\\work\\b', '', ['--continue']],
      ['C:\\work\\a', 'w1', ['--continue']],
    ]);
    expect(result).toEqual({ tabs: 2, reopened: 2, continued: 0, updated: true });
    expect(h.sessions.map((s) => s.id)).toEqual(['x', 'sh', 'n1', 'n2']);
  });

  it('restores manual names and roles, drops an owner window that is gone', async () => {
    const h = setup([
      session({ id: 'a', displayName: 'my notes', role: 'coordinator', ownerWindowId: 'gone' }),
      session({ id: 'b', displayName: 'tab b' }),
    ]);
    await finish(h.reloader.reload('claude-code', ctx).done);
    expect(h.renamed).toEqual([['n1', 'my notes']]);
    expect(h.roles).toEqual([['n1', 'coordinator']]);
    expect(h.created[0]!.ownerWindowId).toBe('');
  });

  it('tells a tab that was working to continue once it reaches its prompt', async () => {
    const h = setup([
      session({ id: 'a', agentPhase: 'working' }),
      session({ id: 'b', agentPhase: 'done' }),
    ]);
    const r = h.reloader.reload('claude-code', ctx);
    await flush();
    expect(h.written).toEqual([]);
    h.ready('n1');
    h.ready('n2');
    const result = await finish(r.done);
    expect(h.written).toEqual([
      ['n1', CONTINUE_PROMPT],
      ['n1', '\r'],
    ]);
    expect(result.continued).toBe(1);
    expect(h.notices.at(-1)).toMatchObject({
      kind: 'reloaded',
      tabs: 2,
      continued: 1,
      updated: true,
      to: '1.1.0',
    });
  });

  it('does not send continue to a tab that was blocked or that never reaches its prompt', async () => {
    const h = setup([
      session({ id: 'a', agentPhase: 'blocked' }),
      session({ id: 'b', agentPhase: 'working' }),
    ]);
    const r = h.reloader.reload('claude-code', ctx);
    await flush();
    // b 开回来后一直没到提示符
    await vi.advanceTimersByTimeAsync(READY_TIMEOUT_MS + 1);
    const result = await r.done;
    expect(h.written).toEqual([]);
    expect(result).toEqual({ tabs: 2, reopened: 2, continued: 0, updated: true });
  });

  it('waits for the prompt even when the reopened tab is first seen working', async () => {
    const h = setup([session({ id: 'a', agentPhase: 'working' })]);
    const r = h.reloader.reload('claude-code', ctx);
    await flush();
    const s = h.sessions.find((x) => x.id === 'n1')!;
    s.agentPhase = 'working';
    h.events.emit('sessionStateChanged', {
      sessionId: 'n1',
      changes: { agentPhase: 'working' },
      full: { ...s },
    });
    await flush();
    expect(h.written).toEqual([]);
    h.ready('n1');
    expect((await finish(r.done)).continued).toBe(1);
  });

  it('reopens without resume args when the tab exits right away, then still continues', async () => {
    const h = setup([session({ id: 'a', agentPhase: 'working' })]);
    const r = h.reloader.reload('claude-code', ctx);
    await flush();
    await vi.advanceTimersByTimeAsync(1000);
    h.exit('n1');
    await flush();
    expect(h.created.map((c) => c.extraArgs)).toEqual([['--continue'], undefined]);
    h.ready('n2');
    const result = await finish(r.done);
    expect(h.written.map(([id]) => id)).toEqual(['n2', 'n2']);
    expect(result).toEqual({ tabs: 1, reopened: 1, continued: 1, updated: true });
  });

  it('treats a later exit as the user closing the tab, not as a bad resume flag', async () => {
    const h = setup([session({ id: 'a', agentPhase: 'done' })]);
    const r = h.reloader.reload('claude-code', ctx);
    await flush();
    await vi.advanceTimersByTimeAsync(EARLY_EXIT_MS + 1);
    h.exit('n1');
    const result = await finish(r.done);
    expect(h.created).toHaveLength(1);
    expect(result.reopened).toBe(1);
  });

  it('reopens the tabs even when the upgrade fails, and says the agent did not update', async () => {
    const h = setup([session({ id: 'a' })], { exitCode: 1 });
    const result = await finish(h.reloader.reload('claude-code', ctx).done);
    expect(h.created).toHaveLength(1);
    expect(result.updated).toBe(false);
    expect(h.notices.map((n) => n.kind)).toEqual(['reloading', 'reloaded']);
    expect(h.notices[1]).toMatchObject({ updated: false, tabs: 1, failedTabs: 0 });
  });

  it('reopens the tabs when the upgrade cannot even start', async () => {
    const h = setup([session({ id: 'a' })], {
      upgrade: async () => {
        throw new Error('UpgradeUnknown');
      },
    });
    const result = await finish(h.reloader.reload('claude-code', ctx).done);
    expect(h.created).toHaveLength(1);
    expect(result.updated).toBe(false);
  });

  it('counts a tab that could not be reopened as failed and keeps going', async () => {
    const h = setup([session({ id: 'a' }), session({ id: 'b' })], { createFails: true });
    const result = await finish(h.reloader.reload('claude-code', ctx).done);
    expect(result).toEqual({ tabs: 2, reopened: 0, continued: 0, updated: true });
    expect(h.notices[1]).toMatchObject({ kind: 'reloaded', tabs: 0, failedTabs: 2 });
  });

  it('refuses a second reload of the same agent while one runs, allows another agent', async () => {
    const h = setup([session({ id: 'a' }), session({ id: 'x', templateId: 'codex' })]);
    const first = h.reloader.reload('claude-code', ctx);
    expect(h.reloader.plan('claude-code').inProgress).toBe(true);
    expect(h.reloader.reload('claude-code', ctx).started).toBe(false);
    const second = h.reloader.reload('codex', ctx);
    expect(second.started).toBe(true);
    await finish(first.done);
    await second.done;
    expect(h.reloader.plan('claude-code').inProgress).toBe(false);
    expect(h.reloader.reload('claude-code', ctx).started).toBe(true);
  });

  it('with no tabs open it still updates and reports zero tabs', async () => {
    const h = setup([]);
    const result = await finish(h.reloader.reload('claude-code', ctx).done);
    expect(h.upgrade).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ tabs: 0, reopened: 0, continued: 0, updated: true });
  });

  it('does not resume an agent without resume args', async () => {
    const h = setup([session({ id: 'a', templateId: 'my-agent', agentPhase: 'working' })]);
    const r = h.reloader.reload('my-agent', ctx);
    await flush();
    expect(h.created[0]!.extraArgs).toBeUndefined();
    h.ready('n1');
    expect((await finish(r.done)).continued).toBe(1);
  });
});
