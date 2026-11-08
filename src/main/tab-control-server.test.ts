/**
 * @file tab-control-server.test.ts
 * @purpose Who may control which tabs over the tab control pipe (ADR-022), and what typing
 *   sends to the PTY. One test per rule.
 */
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

function setup(sessions: SessionInfo[], opts: { enabled?: boolean; paste?: boolean } = {}) {
  const writes: { id: string; data: string }[] = [];
  const closed: string[] = [];
  const created: Parameters<TabControlHost['create']>[0][] = [];
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
  };
  const service = new TabControlService(host, { submitMs: 0, keyMs: 0 });
  const tokenOf = (id: string): string => service.issue(id);
  const call = (token: string, op: string, args: Record<string, unknown> = {}) =>
    service.handle({ v: TAB_CONTROL_VERSION, token, op: op as never, args });
  return { service, tokenOf, call, writes, closed, created };
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
