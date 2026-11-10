/**
 * @file tab-control-server.test.ts
 * @purpose Who may control which tabs over the tab control pipe (ADR-024), and what typing
 *   sends to the PTY. One test per rule.
 */
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SessionInfo, Template } from '@shared/types';
import { TAB_CONTROL_VERSION, type TabControlReply } from '@shared/tab-control';
import { TabControlService, type TabControlHost } from './tab-control-server';

function session(id: string, over: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id,
    pathId: 'C:\\proj\\a',
    templateId: 'shell',
    originalCwd: 'C:\\proj\\a',
    currentCwd: 'C:\\proj\\a',
    cols: 100,
    rows: 30,
    pid: 1,
    displayName: id,
    ownerWindowId: null,
    state: 'idle',
    createdAt: id.charCodeAt(0),
    ...over,
  };
}

const TEMPLATES = [
  { id: 'shell', name: 'Shell', command: '', args: [] },
  { id: 'claude-code', name: 'Claude Code', command: 'claude', args: [] },
] as unknown as Template[];

function setup(
  sessions: SessionInfo[],
  opts: { enabled?: boolean; paste?: boolean; files?: string[] } = {},
) {
  const writes: { id: string; data: string }[] = [];
  const closed: string[] = [];
  const created: Parameters<TabControlHost['create']>[0][] = [];
  const shown: Parameters<TabControlHost['showFile']>[0][] = [];
  const announced: { sessionId: string; agent: string; agentSessionId: string }[] = [];
  const host: TabControlHost = {
    enabled: () => opts.enabled ?? true,
    list: () => sessions,
    get: (id) => sessions.find((s) => s.id === id) ?? null,
    templates: () => TEMPLATES,
    create: async (input) => {
      created.push(input);
      const s = session('new-tab', { pathId: input.pathId, templateId: input.templateId });
      sessions.push(s);
      return s;
    },
    close: (id) => closed.push(id),
    rename: (id, name) => {
      const s = sessions.find((x) => x.id === id);
      if (s) s.displayName = name;
    },
    write: (id, data) => {
      writes.push({ id, data });
      return true;
    },
    screenTail: (id, rows) => `screen of ${id}, ${rows} rows`,
    bracketedPaste: () => opts.paste ?? false,
    isFile: async (path) => (opts.files ?? []).includes(path),
    showFile: (input) => shown.push(input),
    setAgentSession: (sessionId, agent, agentSessionId) =>
      announced.push({ sessionId, agent, agentSessionId }),
  };
  const service = new TabControlService(host, { submitMs: 0, keyMs: 0 });
  const tokenOf = (id: string): string => service.issue(id);
  const call = (token: string, op: string, args: Record<string, unknown> = {}) =>
    service.handle({ v: TAB_CONTROL_VERSION, token, op: op as never, args });
  return { service, tokenOf, call, writes, closed, created, shown, announced };
}

const errorCode = (reply: TabControlReply): string | null => (reply.ok ? null : reply.code);

describe('TabControlService access', () => {
  it('refuses a tab that is not a coordinator', async () => {
    const { tokenOf, call } = setup([session('a'), session('b')]);
    expect(errorCode(await call(tokenOf('a'), 'list'))).toBe('not-coordinator');
  });

  it('refuses a coordinator while the extension is off', async () => {
    const { tokenOf, call } = setup([session('a', { coordinator: true })], { enabled: false });
    expect(errorCode(await call(tokenOf('a'), 'list'))).toBe('disabled');
  });

  it('refuses a token from a destroyed tab', async () => {
    const { service, tokenOf, call } = setup([session('a', { coordinator: true })]);
    const token = tokenOf('a');
    service.revoke('a');
    expect(errorCode(await call(token, 'list'))).toBe('unknown-token');
  });

  it('refuses an exited coordinator', async () => {
    const { tokenOf, call } = setup([session('a', { coordinator: true, state: 'exited' })]);
    expect(errorCode(await call(tokenOf('a'), 'list'))).toBe('not-coordinator');
  });

  it('lists and reaches only the tabs of the coordinator folder', async () => {
    const { tokenOf, call } = setup([
      session('a', { coordinator: true }),
      session('b'),
      session('c', { pathId: 'C:\\proj\\other' }),
    ]);
    const token = tokenOf('a');
    const listed = await call(token, 'list');
    expect(
      listed.ok && (listed.result as { tabs: { id: string }[] }).tabs.map((t) => t.id),
    ).toEqual(['a', 'b']);
    expect(errorCode(await call(token, 'close', { tab: 'c' }))).toBe('not-found');
  });

  it('will not close or type into the coordinator itself', async () => {
    const { tokenOf, call } = setup([session('a', { coordinator: true })]);
    const token = tokenOf('a');
    expect(errorCode(await call(token, 'close', { tab: 'a' }))).toBe('self');
    expect(errorCode(await call(token, 'input', { tab: 'a', text: 'x' }))).toBe('self');
  });
});

describe('TabControlService actions', () => {
  it('opens a tab by template name in the coordinator folder at its size', async () => {
    const { tokenOf, call, created } = setup([session('a', { coordinator: true })]);
    const reply = await call(tokenOf('a'), 'create', { template: 'claude code', name: 'worker' });
    expect(created).toEqual([
      { pathId: 'C:\\proj\\a', templateId: 'claude-code', cols: 100, rows: 30 },
    ]);
    expect(reply.ok && (reply.result as { name: string }).name).toBe('worker');
  });

  it('types text, then keys, then Enter as separate writes', async () => {
    const { tokenOf, call, writes } = setup([
      session('a', { coordinator: true }),
      session('bbbb1'),
    ]);
    await call(tokenOf('a'), 'input', { tab: 'bbbb', text: 'hi', keys: ['escape'], submit: true });
    expect(writes.map((w) => w.data)).toEqual(['hi', '\x1b', '\r']);
  });

  it('wraps multi-line text in a bracketed paste when the tab asked for it', async () => {
    const { tokenOf, call, writes } = setup([session('a', { coordinator: true }), session('b')], {
      paste: true,
    });
    await call(tokenOf('a'), 'input', { tab: 'b', text: 'one\ntwo', submit: false });
    expect(writes.map((w) => w.data)).toEqual(['\x1b[200~one\ntwo\x1b[201~']);
  });

  it('refuses an unknown key name without typing anything', async () => {
    const { tokenOf, call, writes } = setup([session('a', { coordinator: true }), session('b')]);
    expect(
      errorCode(await call(tokenOf('a'), 'input', { tab: 'b', text: 'x', keys: ['f13'] })),
    ).toBe('bad-request');
    expect(writes).toEqual([]);
  });
});

describe('TabControlService open-file (ADR-033)', () => {
  const cwd = resolve('/proj/a');
  const note = resolve(cwd, 'notes', 'answer.md');

  it('shows a relative path from the coordinator cwd beside the coordinator itself', async () => {
    const { tokenOf, call, shown } = setup(
      [session('a', { coordinator: true, currentCwd: cwd }), session('b')],
      { files: [note] },
    );
    const reply = await call(tokenOf('a'), 'open-file', { path: 'notes/answer.md' });
    expect(reply.ok && reply.result).toMatchObject({
      path: note,
      name: 'answer.md',
      kind: 'markdown',
      tab: { id: 'a', self: true },
    });
    expect(shown).toEqual([{ sessionId: 'a', name: 'answer.md', path: note }]);
  });

  it('works from a plain worker tab with the extension off', async () => {
    const { tokenOf, call, shown } = setup([session('w', { currentCwd: cwd })], {
      enabled: false,
      files: [note],
    });
    const reply = await call(tokenOf('w'), 'open-file', { path: 'notes/answer.md' });
    expect(reply.ok).toBe(true);
    expect(shown.map((s) => s.sessionId)).toEqual(['w']);
    expect(errorCode(await call(tokenOf('w'), 'list'))).toBe('disabled');
  });

  it('still refuses an exited tab', async () => {
    const { tokenOf, call } = setup([session('w', { state: 'exited' })], { files: [note] });
    expect(errorCode(await call(tokenOf('w'), 'open-file', { path: note }))).toBe(
      'not-coordinator',
    );
  });

  it('shows an absolute path beside a named tab of the folder', async () => {
    const { tokenOf, call, shown } = setup(
      [session('a', { coordinator: true }), session('bbbb1', { currentCwd: cwd })],
      { files: [note] },
    );
    const reply = await call(tokenOf('a'), 'open-file', { tab: 'bbbb', path: note });
    expect(reply.ok && (reply.result as { tab: { id: string } }).tab.id).toBe('bbbb1');
    expect(shown.map((s) => s.sessionId)).toEqual(['bbbb1']);
  });

  it('refuses a kind the viewer cannot show without touching the disk', async () => {
    const { tokenOf, call, shown } = setup([session('a', { coordinator: true })], {
      files: [resolve(cwd, 'main.ts')],
    });
    const reply = await call(tokenOf('a'), 'open-file', { path: resolve(cwd, 'main.ts') });
    expect(errorCode(reply)).toBe('bad-request');
    expect(shown).toEqual([]);
  });

  it('refuses a file that does not exist', async () => {
    const { tokenOf, call, shown } = setup([session('a', { coordinator: true })]);
    expect(errorCode(await call(tokenOf('a'), 'open-file', { path: note }))).toBe('not-found');
    expect(shown).toEqual([]);
  });

  it('refuses an empty path and a tab of another folder', async () => {
    const { tokenOf, call } = setup(
      [session('a', { coordinator: true }), session('other', { pathId: 'D:/proj/b' })],
      { files: [note] },
    );
    expect(errorCode(await call(tokenOf('a'), 'open-file', { path: '  ' }))).toBe('bad-request');
    expect(errorCode(await call(tokenOf('a'), 'open-file', { tab: 'other', path: note }))).toBe(
      'not-found',
    );
  });

  it('refuses in an SSH folder, where the file is on the other machine', async () => {
    const { tokenOf, call } = setup(
      [session('a', { coordinator: true, pathId: 'ssh:box:/home/u' })],
      { files: [note] },
    );
    expect(errorCode(await call(tokenOf('a'), 'open-file', { path: note }))).toBe('bad-request');
  });
});

describe('TabControlService agent-session (ADR-036)', () => {
  const uuid = '0a4086ef-5f12-425e-a27a-e918b2302170';

  it('records the calling tab agent session from any live tab, extension off', async () => {
    const { tokenOf, call, announced } = setup([session('w')], { enabled: false });
    const reply = await call(tokenOf('w'), 'agent-session', {
      agent: 'claude-code',
      sessionId: uuid,
    });
    expect(reply.ok).toBe(true);
    expect(announced).toEqual([{ sessionId: 'w', agent: 'claude-code', agentSessionId: uuid }]);
  });

  it('refuses an unknown agent or a non-uuid id', async () => {
    const { tokenOf, call, announced } = setup([session('w')]);
    expect(
      errorCode(await call(tokenOf('w'), 'agent-session', { agent: 'gemini', sessionId: uuid })),
    ).toBe('bad-request');
    expect(
      errorCode(
        await call(tokenOf('w'), 'agent-session', { agent: 'codex', sessionId: '; rm -rf' }),
      ),
    ).toBe('bad-request');
    expect(announced).toEqual([]);
  });
});
