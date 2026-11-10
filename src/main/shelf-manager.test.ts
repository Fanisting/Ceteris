/**
 * @file src/main/shelf-manager.test.ts
 * @purpose ShelfManager (ADR-036): the sweep, manual shelving, resume lookup order, restore
 *   plans and persistence. The host is a fake; the store writes to a temp dir.
 */
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ShelfChangedPayload } from '@shared/protocol';
import type { ShelfFile } from '@shared/shelf';
import type { SessionInfo, Template } from '@shared/types';
import { createTempDataDir, JsonStore, removeTempDataDir } from './persistence';
import { ShelfManager, type ShelfHost } from './shelf-manager';

const HOUR = 3_600_000;
let NOW = 1_700_000_000_000;
let dir: string;

const TEMPLATES: Record<string, Template> = {
  'claude-code': template('claude-code', 'claude'),
  codex: template('codex', 'codex'),
  shell: template('shell', ''),
};

function template(id: string, command: string): Template {
  return {
    id,
    name: id,
    icon: '',
    isBuiltin: true,
    command,
    args: [],
    env: {},
    shellFirst: true,
    postExitAction: 'keep_shell',
  };
}

function session(id: string, over: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id,
    pathId: 'C:\\work',
    templateId: 'claude-code',
    originalCwd: 'C:\\work',
    currentCwd: 'C:\\work',
    cols: 80,
    rows: 24,
    pid: 1,
    displayName: `tab ${id}`,
    ownerWindowId: null,
    state: 'idle',
    agentPhase: 'done',
    createdAt: NOW - 10 * HOUR,
    ...over,
  };
}

interface Fake {
  sessions: SessionInfo[];
  activity: Record<string, number>;
  announced: Record<string, { agent: 'claude-code' | 'codex'; sessionId: string }>;
  destroyed: string[];
  hours: number;
  found: string | null;
  lookups: unknown[];
  host: ShelfHost;
}

function fake(sessions: SessionInfo[], hours = 3): Fake {
  const f: Fake = {
    sessions,
    activity: {},
    announced: {},
    destroyed: [],
    hours,
    found: null,
    lookups: [],
    host: undefined as unknown as ShelfHost,
  };
  f.host = {
    listSessions: () => f.sessions,
    getSession: (id) => f.sessions.find((s) => s.id === id) ?? null,
    lastActivityAt: (id) => f.activity[id] ?? NOW - 9 * HOUR,
    agentSession: (id) => f.announced[id] ?? null,
    destroy: (id) => {
      f.destroyed.push(id);
      f.sessions = f.sessions.filter((s) => s.id !== id);
    },
    template: (id) => {
      const t = TEMPLATES[id];
      if (!t) throw new Error(`no template ${id}`);
      return t;
    },
    idleHours: () => f.hours,
    findResumeId: async (lookup) => {
      f.lookups.push(lookup);
      return f.found;
    },
    homeDir: 'H:\\home',
    now: () => NOW,
  };
  return f;
}

/** Every manager made in a test, flushed before its folder is removed. */
let managers: ShelfManager[] = [];

async function make(
  f: Fake,
): Promise<{ shelf: ShelfManager; store: JsonStore<ShelfFile>; events: ShelfChangedPayload[] }> {
  const store = new JsonStore<ShelfFile>(join(dir, 'shelf.json'), 0);
  const shelf = new ShelfManager(store, f.host);
  managers.push(shelf);
  await shelf.initialize();
  const events: ShelfChangedPayload[] = [];
  shelf.on('changed', (p: ShelfChangedPayload) => events.push(p));
  return { shelf, store, events };
}

beforeEach(async () => {
  dir = await createTempDataDir('ceteris-shelf-');
  NOW = 1_700_000_000_000;
  managers = [];
});

afterEach(async () => {
  for (const m of managers) {
    m.stopSweep();
    await m.flush();
  }
  await removeTempDataDir(dir);
});

describe('ShelfManager sweep', () => {
  it('shelves idle tabs past the threshold and leaves the rest', async () => {
    const f = fake([
      session('old'),
      session('shown', { ownerWindowId: 'w1' }),
      session('fresh'),
      session('coord', { coordinator: true }),
    ]);
    f.activity.fresh = NOW - HOUR;
    const { shelf } = await make(f);
    const made = await shelf.sweep();
    expect(made.map((e) => e.sessionId)).toEqual(['old']);
    expect(f.destroyed).toEqual(['old']);
    expect(shelf.list().map((e) => e.displayName)).toEqual(['tab old']);
  });

  it('does nothing while the setting is off', async () => {
    const f = fake([session('old')], 0);
    const { shelf } = await make(f);
    expect(await shelf.sweep()).toEqual([]);
    expect(f.destroyed).toEqual([]);
  });

  it('runs on the timer and reads the setting each tick', async () => {
    vi.useFakeTimers();
    try {
      const f = fake([session('old')], 0);
      const { shelf } = await make(f);
      shelf.startSweep(1000);
      await vi.advanceTimersByTimeAsync(1000);
      expect(f.destroyed).toEqual([]);
      f.hours = 1;
      await vi.advanceTimersByTimeAsync(1000);
      expect(f.destroyed).toEqual(['old']);
      shelf.stopSweep();
      await vi.advanceTimersByTimeAsync(5000);
      expect(f.destroyed).toEqual(['old']);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('ShelfManager shelve', () => {
  it('announces the entry before destroying the session', async () => {
    const f = fake([session('a')]);
    const { shelf, events } = await make(f);
    let aliveAtEvent: boolean | null = null;
    shelf.on('changed', () => {
      aliveAtEvent = f.host.getSession('a') !== null;
    });
    const entry = await shelf.shelve('a', 'manual');
    expect(entry?.reason).toBe('manual');
    expect(aliveAtEvent).toBe(true);
    expect(events[0]?.shelvedSessionId).toBe('a');
    expect(f.destroyed).toEqual(['a']);
  });

  it('uses the announced agent session over the file lookup', async () => {
    const f = fake([session('a')]);
    f.announced.a = { agent: 'claude-code', sessionId: 'announced-id' };
    f.found = 'file-id';
    const { shelf } = await make(f);
    const entry = await shelf.shelve('a', 'auto');
    expect(entry?.resume).toEqual({ agent: 'claude-code', sessionId: 'announced-id' });
    expect(f.lookups).toHaveLength(0);
  });

  it('looks in the agent files with the tab directories and time window', async () => {
    const f = fake([session('a', { templateId: 'codex', currentCwd: 'C:\\work\\sub' })]);
    f.activity.a = NOW - 4 * HOUR;
    f.found = 'file-id';
    const { shelf } = await make(f);
    const entry = await shelf.shelve('a', 'auto');
    expect(entry?.resume).toEqual({ agent: 'codex', sessionId: 'file-id' });
    expect(f.lookups[0]).toEqual({
      agent: 'codex',
      homeDir: 'H:\\home',
      cwds: ['C:\\work\\sub', 'C:\\work'],
      since: NOW - 10 * HOUR,
      until: NOW - 4 * HOUR,
    });
    expect(entry?.cwd).toBe('C:\\work\\sub');
  });

  it('shelves a plain shell with no resume id and never looks for one', async () => {
    const f = fake([session('a', { templateId: 'shell' })]);
    const { shelf } = await make(f);
    const entry = await shelf.shelve('a', 'auto');
    expect(entry?.resume).toBeNull();
    expect(f.lookups).toHaveLength(0);
  });

  it('refuses a working agent and an unknown session', async () => {
    const f = fake([session('a', { agentPhase: 'working' })]);
    const { shelf } = await make(f);
    await expect(shelf.shelve('a', 'manual')).rejects.toThrow(/SessionBusy|working/);
    await expect(shelf.shelve('nope', 'manual')).rejects.toThrow(/no session/);
    expect(f.destroyed).toEqual([]);
  });

  it('shelves the same session only once when asked twice at the same time', async () => {
    const f = fake([session('a')]);
    const { shelf } = await make(f);
    const [x, y] = await Promise.all([shelf.shelve('a', 'manual'), shelf.shelve('a', 'manual')]);
    expect([x, y].filter(Boolean)).toHaveLength(1);
    expect(f.destroyed).toEqual(['a']);
  });
});

describe('ShelfManager restore, forget, clear and persistence', () => {
  it('plans a resume for the same agent and a fresh start otherwise', async () => {
    const f = fake([session('a'), session('b', { templateId: 'shell' })]);
    f.announced.a = { agent: 'claude-code', sessionId: 'id-a' };
    const { shelf } = await make(f);
    const ea = (await shelf.shelve('a', 'auto'))!;
    const eb = (await shelf.shelve('b', 'auto'))!;
    expect(shelf.planRestore(ea.id)).toMatchObject({
      pathId: 'C:\\work',
      templateId: 'claude-code',
      extraArgs: ['--resume', 'id-a'],
    });
    expect(shelf.planRestore(eb.id).extraArgs).toEqual([]);
    expect(() => shelf.planRestore('missing')).toThrow(/no shelf entry/);
  });

  it('drops resume flags when the template no longer starts that agent', async () => {
    TEMPLATES['my-claude'] = template('my-claude', 'claude');
    const f = fake([session('a', { templateId: 'my-claude' })]);
    f.announced.a = { agent: 'claude-code', sessionId: 'id-a' };
    const { shelf } = await make(f);
    const e = (await shelf.shelve('a', 'auto'))!;
    expect(shelf.planRestore(e.id).extraArgs).toEqual(['--resume', 'id-a']);
    TEMPLATES['my-claude'] = template('my-claude', 'gemini');
    try {
      expect(shelf.planRestore(e.id).extraArgs).toEqual([]);
    } finally {
      delete TEMPLATES['my-claude'];
    }
  });

  it('forgets one entry, clears all, and announces each change', async () => {
    const f = fake([session('a'), session('b')]);
    const { shelf, events } = await make(f);
    const ea = (await shelf.shelve('a', 'auto'))!;
    await shelf.shelve('b', 'auto');
    shelf.forget(ea.id);
    expect(shelf.list().map((e) => e.sessionId)).toEqual(['b']);
    shelf.forget('unknown');
    shelf.clear();
    expect(shelf.list()).toEqual([]);
    shelf.clear();
    expect(events).toHaveLength(4); // 2 shelves + forget + clear; no-ops stay silent
    expect(events.at(-1)?.shelvedSessionId).toBeUndefined();
  });

  it('survives a restart through shelf.json', async () => {
    const f = fake([session('a')]);
    f.announced.a = { agent: 'claude-code', sessionId: 'id-a' };
    const { shelf } = await make(f);
    await shelf.shelve('a', 'auto');
    await shelf.flush();
    const again = new ShelfManager(new JsonStore<ShelfFile>(join(dir, 'shelf.json')), f.host);
    await again.initialize();
    expect(again.list()).toHaveLength(1);
    expect(again.list()[0]?.resume).toEqual({ agent: 'claude-code', sessionId: 'id-a' });
  });

  it('starts empty from a damaged shelf.json', async () => {
    const store = new JsonStore<ShelfFile>(join(dir, 'shelf.json'));
    store.set({ version: 1, entries: 'junk' as unknown as [] });
    await store.flush();
    const shelf = new ShelfManager(store, fake([]).host);
    await shelf.initialize();
    expect(shelf.list()).toEqual([]);
  });
});
