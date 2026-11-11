/**
 * @file tab-control-mcp.test.ts
 * @purpose The ceteris-tabs plugin's MCP server (extensions/ceteris-tabs/server) against a real
 *   tab control pipe (ADR-024): the two copies of the wire format agree, a coordinator's tool
 *   call reaches the tab, and a tab outside Ceteris gets no tools.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { SessionInfo, Template } from '@shared/types';
import { TAB_CONTROL_KEYS, TAB_CONTROL_VERSION } from '@shared/tab-control';
import {
  KEY_NAMES,
  PROTOCOL_VERSION,
  handleMessage,
  needsAttention,
} from '../../extensions/ceteris-tabs/server/ceteris-tabs-mcp.mjs';
import { TabControlServer, type TabControlHost } from './tab-control-server';

function session(id: string, over: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id,
    pathId: 'C:\\proj\\a',
    templateId: 'shell',
    originalCwd: 'C:\\proj\\a',
    currentCwd: 'C:\\proj\\a',
    cols: 80,
    rows: 24,
    pid: 1,
    displayName: id,
    ownerWindowId: null,
    state: 'idle',
    createdAt: 0,
    ...over,
  };
}

let server: TabControlServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

async function start(sessions: SessionInfo[]) {
  const writes: string[] = [];
  const shown: { sessionId: string; path: string }[] = [];
  const host: TabControlHost = {
    enabled: () => true,
    list: () => sessions,
    get: (id) => sessions.find((s) => s.id === id) ?? null,
    templates: () => [] as Template[],
    create: async () => {
      throw new Error('not used');
    },
    close: () => {},
    rename: () => {},
    write: (_id, data) => {
      writes.push(data);
      return true;
    },
    screenTail: () => '',
    bracketedPaste: () => false,
    isFile: async (path) => path.endsWith('answer.md'),
    showFile: ({ sessionId, path }) => shown.push({ sessionId, path }),
    setAgentSession: () => {},
  };
  server = new TabControlServer(host, 'node');
  await server.start();
  return { server, writes, shown };
}

describe('ceteris-tabs MCP server', () => {
  it('uses the same protocol version and key names as Ceteris', () => {
    expect(PROTOCOL_VERSION).toBe(TAB_CONTROL_VERSION);
    expect([...KEY_NAMES].sort()).toEqual(Object.keys(TAB_CONTROL_KEYS).sort());
  });

  it('offers no tools outside a Ceteris tab', async () => {
    const reply = await handleMessage({}, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(reply.result.tools).toEqual([]);
  });

  it('sends a coordinator prompt to a worker tab through the pipe', async () => {
    const { server: s, writes } = await start([
      session('boss', { coordinator: true }),
      session('worker'),
    ]);
    const env = s.envFor('boss');
    const reply = await handleMessage(env, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'send_input', arguments: { tab: 'worker', text: 'run tests' } },
    });
    expect(reply.result.isError).toBeUndefined();
    expect(writes).toEqual(['run tests', '\r']);
  });

  it('asks Ceteris to show a file beside the coordinator tab', async () => {
    const { server: s, shown } = await start([session('boss', { coordinator: true })]);
    const reply = await handleMessage(s.envFor('boss'), {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'open_file', arguments: { path: 'answer.md' } },
    });
    expect(reply.result.isError).toBeUndefined();
    expect(reply.result.content[0].text).toContain('markdown');
    expect(shown).toHaveLength(1);
    expect(shown[0]!.sessionId).toBe('boss');
    expect(shown[0]!.path.endsWith('answer.md')).toBe(true);
  });

  it('reports a refusal from Ceteris as a tool error', async () => {
    const { server: s } = await start([session('boss'), session('worker')]);
    const reply = await handleMessage(s.envFor('boss'), {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'list_tabs', arguments: {} },
    });
    expect(reply.result.isError).toBe(true);
    expect(reply.result.content[0].text).toContain('not-coordinator');
  });

  it('treats a quiet shell as finished but waits for an agent to say done', () => {
    const shell = { state: 'idle', agentPhase: null, templateId: 'shell' };
    const agent = { state: 'idle', agentPhase: null, templateId: 'claude-code' };
    expect(needsAttention(shell, 2)).toBe(true);
    expect(needsAttention(agent, 5)).toBe(false);
    expect(needsAttention({ ...agent, agentPhase: 'blocked' }, 0)).toBe(true);
  });
});
