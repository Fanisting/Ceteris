/**
 * @file src/main/session-restore.test.ts
 * @purpose SessionRestorer (ADR-039): what restore.json holds while the app runs, the last
 *   save at quit, and how a launch reopens, resumes, shelves or skips each saved tab. The
 *   session side is a fake; the store writes to a temp dir.
 */
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RestoreFile, RestoreTab } from '@shared/session-restore';
import type { ShelfEntry } from '@shared/shelf';
import type { SessionInfo, Template } from '@shared/types';
import { createTempDataDir, JsonStore, removeTempDataDir } from './persistence';
import {
  SessionRestorer,
  type RestoreCreateInput,
  type SessionRestoreDeps,
} from './session-restore';

const NOW = 1_700_000_000_000;
let dir: string;

function template(id: string, command: string, isBuiltin = true): Template {
  return {
    id,
    name: id,
    icon: '',
    isBuiltin,
    command,
    args: [],
    env: {},
    shellFirst: true,
    postExitAction: 'keep_shell',
  };
}

const TEMPLATES: Record<string, Template> = {
  shell: template('shell', ''),
  'claude-code': template('claude-code', 'claude'),
  codex: template('codex', 'codex'),
  opencode: template('opencode', 'opencode'),
  deploy: template('deploy', 'npm', false),
};

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
    createdAt: NOW - 1000,
    ...over,
  };
}

function savedTab(over: Partial<RestoreTab> = {}): RestoreTab {
  return {
    pathId: 'C:\\work',
    templateId: 'claude-code',
    displayName: 'fix login',
    keepName: true,
    role: null,
    cwd: 'C:\\work',
    originalCwd: 'C:\\work',
    createdAt: NOW - 5000,
    lastActivityAt: NOW - 100,
    lastEnterAt: 0,
    shown: false,
    resume: null,
    ...over,
  };
}

interface Fake {
  events: EventEmitter;
  sessions: SessionInfo[];
  manual: Set<string>;
  announced: Record<string, { agent: 'claude-code' | 'codex'; sessionId: string }>;
  created: RestoreCreateInput[];
  renamed: Array<[string, string]>;
  /** setRole and rename calls in order */
  order: string[];
  roles: Array<[string, string | null]>;
  agentIds: Array<[string, string]>;
  shelved: Array<Omit<ShelfEntry, 'id' | 'shelvedAt' | 'reason'>>;
  enabled: boolean;
  /** Ids the transcript lookup returns, one per call, in order */
  found: Array<string | null>;
  /** Template ids whose launch throws */
  failing: Set<string>;
  /** Resume ids whose transcript is gone */
  missing: Set<string>;
  deps: SessionRestoreDeps;
}

function fake(sessions: SessionInfo[] = []): Fake {
  let n = 0;
  const f: Fake = {
    events: new EventEmitter(),
    sessions,
    manual: new Set(),
    announced: {},
    created: [],
    renamed: [],
    order: [],
    roles: [],
    agentIds: [],
    shelved: [],
    enabled: true,
    found: [],
    failing: new Set(),
    missing: new Set(),
    deps: undefined as unknown as SessionRestoreDeps,
  };
  f.deps = {
    events: f.events,
    listSessions: () => f.sessions,
    lastActivityAt: () => NOW - 10,
    lastEnterAt: (id) => (id === 'b' ? NOW - 20 : 0),
    agentSession: (id) => f.announced[id] ?? null,
    isManuallyRenamed: (id) => f.manual.has(id),
    template: (id) => TEMPLATES[id] ?? null,
    isSshPath: (pathId) => pathId.startsWith('ssh:'),
    create: async (input) => {
      if (f.failing.has(input.templateId)) throw new Error('spawn failed');
      f.created.push(input);
      const s = session(`new${++n}`, {
        pathId: input.pathId,
        templateId: input.templateId,
        ownerWindowId: input.ownerWindowId || null,
      });
      f.sessions.push(s);
      return s;
    },
    rename: (id, name) => {
      f.renamed.push([id, name]);
      f.order.push(`rename ${id}`);
    },
    setRole: (id, role) => {
      f.roles.push([id, role]);
      f.order.push(`role ${id}`);
    },
    setAgentSession: (id, _agent, agentId) => f.agentIds.push([id, agentId]),
    shelve: async (tab) => {
      f.shelved.push(tab);
    },
    enabled: () => f.enabled,
    folderResumeArgs: {
      'claude-code': ['--continue'],
      codex: ['resume', '--last'],
      opencode: ['--continue'],
    },
    findResumeId: async () => f.found.shift() ?? null,
    resumeIdExists: async ({ sessionId }) => !f.missing.has(sessionId),
    homeDir: 'H:\\home',
    now: () => NOW,
    saveDebounceMs: 5,
  };
  return f;
}

let restorers: SessionRestorer[] = [];
let stores: JsonStore<RestoreFile>[] = [];

function storeAt(): JsonStore<RestoreFile> {
  const s = new JsonStore<RestoreFile>(join(dir, 'restore.json'), 0);
  stores.push(s);
  return s;
}

async function seed(tabs: RestoreTab[]): Promise<void> {
  const s = storeAt();
  s.set({ version: 1, savedAt: NOW - 50, tabs });
  await s.flush();
}

async function readFile(): Promise<RestoreFile> {
  const s = new JsonStore<RestoreFile>(join(dir, 'restore.json'), 0);
  return (await s.load({ version: 1, savedAt: 0, tabs: [] })).value;
}

function make(f: Fake): SessionRestorer {
  const r = new SessionRestorer(storeAt(), f.deps);
  restorers.push(r);
  return r;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(async () => {
  dir = await createTempDataDir('ceteris-restore-');
  restorers = [];
  stores = [];
});

afterEach(async () => {
  for (const r of restorers) {
    r.freeze();
    await r.flush();
  }
  for (const s of stores) await s.flush();
  await removeTempDataDir(dir);
});

describe('SessionRestorer snapshot', () => {
  it('skips exited tabs and records what a launch needs', () => {
    const f = fake([
      session('a', { templateId: 'shell', currentCwd: 'C:\\work\\src' }),
      session('b', { ownerWindowId: 'w1', role: 'coordinator' }),
      session('c', { state: 'exited' }),
    ]);
    f.announced['b'] = { agent: 'claude-code', sessionId: 'id-b' };
    const snap = make(f).snapshot();
    expect(snap.tabs.map((t) => t.displayName)).toEqual(['tab a', 'tab b']);
    expect(snap.tabs[0]).toMatchObject({ cwd: 'C:\\work\\src', keepName: false, shown: false });
    expect(snap.tabs[1]).toMatchObject({
      keepName: true,
      shown: true,
      role: 'coordinator',
      lastEnterAt: NOW - 20,
      resume: { agent: 'claude-code', sessionId: 'id-b' },
    });
  });

  it('a renamed shell keeps its name', () => {
    const f = fake([session('a', { templateId: 'shell' })]);
    f.manual.add('a');
    expect(make(f).snapshot().tabs[0]!.keepName).toBe(true);
  });

  it('saves after session events while running', async () => {
    const f = fake();
    f.enabled = false;
    const r = make(f);
    await r.restore(null);
    f.sessions.push(session('a'));
    f.events.emit('sessionCreated', { sessionId: 'a' });
    await wait(30);
    await r.flush();
    expect((await readFile()).tabs).toHaveLength(1);
  });

  it('freeze keeps the last tabs although shutdown then closes them all', async () => {
    const f = fake([session('a'), session('b')]);
    f.enabled = false;
    const r = make(f);
    await r.restore(null);
    r.freeze();
    f.sessions = [];
    f.events.emit('sessionDestroyed', { sessionId: 'a', reason: 'app-quit' });
    await wait(30);
    await r.flush();
    expect((await readFile()).tabs).toHaveLength(2);
  });
});

describe('SessionRestorer restore', () => {
  it('reopens tabs in order, resumes by id, and gives the shown tab to the window', async () => {
    await seed([
      savedTab({ templateId: 'shell', displayName: 'pwsh', keepName: false, createdAt: 1 }),
      savedTab({
        displayName: 'fix login',
        createdAt: 2,
        shown: true,
        role: 'coordinator',
        resume: { agent: 'claude-code', sessionId: 'id-1' },
      }),
    ]);
    const f = fake();
    const result = await make(f).restore('w1');
    expect(f.created).toEqual([
      expect.objectContaining({ templateId: 'shell', ownerWindowId: '' }),
      expect.objectContaining({
        templateId: 'claude-code',
        ownerWindowId: 'w1',
        extraArgs: ['--resume', 'id-1'],
      }),
    ]);
    expect(f.created[0]!.extraArgs).toBeUndefined();
    expect(f.renamed).toEqual([['new2', 'fix login']]);
    expect(f.roles).toEqual([['new2', 'coordinator']]);
    // setRole renames to the role's name, so it must come before the saved name.
    expect(f.order).toEqual(['role new2', 'rename new2']);
    expect(f.agentIds).toEqual([['new2', 'id-1']]);
    expect(result).toEqual({ reopened: 2, resumed: 1, shelved: 0, skipped: 0 });
  });

  it('no window means no tab is shown', async () => {
    await seed([savedTab({ shown: true, resume: { agent: 'claude-code', sessionId: 'x' } })]);
    const f = fake();
    await make(f).restore(null);
    expect(f.created[0]!.ownerWindowId).toBe('');
  });

  it('custom commands and SSH go to the shelf; deleted templates are skipped', async () => {
    await seed([
      savedTab({ templateId: 'deploy', displayName: 'deploy' }),
      savedTab({ templateId: 'shell', pathId: 'ssh:p1:%2Fhome', displayName: 'box' }),
      savedTab({ templateId: 'gone' }),
    ]);
    const f = fake();
    const result = await make(f).restore('w1');
    expect(f.created).toEqual([]);
    expect(f.shelved.map((t) => t.displayName)).toEqual(['deploy', 'box']);
    expect(result).toMatchObject({ shelved: 2, skipped: 1, reopened: 0 });
  });

  it('looks up missing ids, never gives one id to two tabs, and then starts fresh', async () => {
    await seed([savedTab({ createdAt: 1 }), savedTab({ createdAt: 2 })]);
    const f = fake();
    f.found = ['same', 'same'];
    await make(f).restore(null);
    expect(f.created[0]!.extraArgs).toEqual(['--resume', 'same']);
    // Two Claude tabs in one folder: no --continue either, it could take the other's chat.
    expect(f.created[1]!.extraArgs).toBeUndefined();
  });

  it('Claude without an id starts fresh; another agent alone in its folder continues', async () => {
    await seed([savedTab({ createdAt: 1 }), savedTab({ templateId: 'opencode', createdAt: 2 })]);
    const f = fake();
    await make(f).restore(null);
    expect(f.created[0]!.extraArgs).toBeUndefined();
    expect(f.created[1]!.extraArgs).toEqual(['--continue']);
  });

  it('an announced id whose transcript is gone starts fresh', async () => {
    await seed([savedTab({ resume: { agent: 'claude-code', sessionId: 'dead' } })]);
    const f = fake();
    f.missing.add('dead');
    const result = await make(f).restore('w1');
    expect(f.created[0]!.extraArgs).toBeUndefined();
    expect(f.agentIds).toEqual([]);
    expect(result).toMatchObject({ reopened: 1, resumed: 0 });
  });

  it('a tab that fails to start is skipped and the rest still open', async () => {
    await seed([
      savedTab({ templateId: 'codex', createdAt: 1 }),
      savedTab({ templateId: 'shell', createdAt: 2 }),
    ]);
    const f = fake();
    f.failing.add('codex');
    const result = await make(f).restore(null);
    expect(f.created.map((c) => c.templateId)).toEqual(['shell']);
    expect(result).toMatchObject({ reopened: 1, skipped: 1 });
  });

  it('off in settings: opens nothing but keeps saving', async () => {
    await seed([savedTab()]);
    const f = fake([session('a', { templateId: 'shell' })]);
    f.enabled = false;
    const r = make(f);
    await r.restore('w1');
    expect(f.created).toEqual([]);
    await r.flush();
    expect((await readFile()).tabs.map((t) => t.templateId)).toEqual(['shell']);
  });

  it('runs once per process', async () => {
    await seed([savedTab({ templateId: 'shell' })]);
    const f = fake();
    const r = make(f);
    await r.restore(null);
    expect(await r.restore(null)).toEqual({ reopened: 0, resumed: 0, shelved: 0, skipped: 0 });
    expect(f.created).toHaveLength(1);
  });

  it('a damaged file opens nothing', async () => {
    const s = storeAt();
    s.set('nonsense' as unknown as RestoreFile);
    await s.flush();
    const f = fake();
    const result = await make(f).restore('w1');
    expect(result.reopened).toBe(0);
  });

  it('after restoring, the file holds the reopened tabs with their ids', async () => {
    await seed([savedTab({ resume: { agent: 'claude-code', sessionId: 'id-9' } })]);
    const f = fake();
    // The reopened tab announces nothing yet; the restorer told SessionManager the id.
    f.deps.agentSession = (id) =>
      id === 'new1' ? { agent: 'claude-code', sessionId: 'id-9' } : null;
    const r = make(f);
    await r.restore(null);
    await r.flush();
    const saved = await readFile();
    expect(saved.tabs).toHaveLength(1);
    expect(saved.tabs[0]!.resume).toEqual({ agent: 'claude-code', sessionId: 'id-9' });
  });
});
