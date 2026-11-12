/**
 * @file src/shared/shelf.test.ts
 * @purpose Rules of the tab shelf (ADR-036): who may be shelved, how a tab resumes, and how a
 *   shelf file from disk is accepted.
 */
import { describe, expect, it } from 'vitest';
import type { SessionInfo } from './types';
import {
  claudeProjectSlug,
  pickShelvable,
  pushEntry,
  resumableAgentOf,
  resumeArgs,
  sanitizeShelfFile,
  shelveBlocker,
  SHELF_MAX_ENTRIES,
  type ShelfEntry,
} from './shelf';

const HOUR = 3_600_000;
const NOW = 1_700_000_000_000;

function session(over: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: 's1',
    pathId: 'C:\\work',
    templateId: 'claude-code',
    originalCwd: 'C:\\work',
    currentCwd: 'C:\\work',
    cols: 80,
    rows: 24,
    pid: 1,
    displayName: 'Claude',
    ownerWindowId: null,
    state: 'idle',
    agentPhase: 'done',
    createdAt: NOW - 10 * HOUR,
    ...over,
  };
}

function entry(over: Partial<ShelfEntry> = {}): ShelfEntry {
  return {
    id: 'e1',
    sessionId: 's1',
    pathId: 'C:\\work',
    templateId: 'claude-code',
    displayName: 'Claude',
    cwd: 'C:\\work',
    createdAt: NOW - HOUR,
    lastActivityAt: NOW - HOUR,
    shelvedAt: NOW,
    reason: 'auto',
    resume: null,
    ...over,
  };
}

describe('shelveBlocker', () => {
  it('is off when the setting is 0', () => {
    expect(shelveBlocker(session(), NOW - 10 * HOUR, NOW, 0)).toBe('off');
  });

  it('shelves an idle, unowned tab past the threshold', () => {
    expect(shelveBlocker(session(), NOW - 3 * HOUR, NOW, 3 * HOUR)).toBeNull();
  });

  it('waits while the tab was recently active', () => {
    expect(shelveBlocker(session(), NOW - 3 * HOUR + 1, NOW, 3 * HOUR)).toBe('recent');
  });

  it('never shelves a tab a window is showing', () => {
    expect(shelveBlocker(session({ ownerWindowId: 'w1' }), NOW - 9 * HOUR, NOW, HOUR)).toBe(
      'on-screen',
    );
  });

  it('never shelves coordinators or tabs with a role', () => {
    expect(shelveBlocker(session({ coordinator: true }), NOW - 9 * HOUR, NOW, HOUR)).toBe('role');
    expect(shelveBlocker(session({ role: 'fintuner' }), NOW - 9 * HOUR, NOW, HOUR)).toBe('role');
  });

  it('never shelves a working agent or an active tab', () => {
    expect(shelveBlocker(session({ agentPhase: 'working' }), NOW - 9 * HOUR, NOW, HOUR)).toBe(
      'busy',
    );
    expect(
      shelveBlocker(session({ state: 'active', agentPhase: null }), NOW - 9 * HOUR, NOW, HOUR),
    ).toBe('busy');
  });

  it('shelves a blocked agent and an exited tab like any idle one', () => {
    expect(shelveBlocker(session({ agentPhase: 'blocked' }), NOW - 9 * HOUR, NOW, HOUR)).toBeNull();
    expect(
      shelveBlocker(session({ state: 'exited', agentPhase: null }), NOW - 9 * HOUR, NOW, HOUR),
    ).toBeNull();
  });
});

describe('pickShelvable', () => {
  it('returns only the due tabs, oldest first', () => {
    const a = session({ id: 'a', createdAt: NOW - 5 * HOUR });
    const b = session({ id: 'b', createdAt: NOW - 9 * HOUR });
    const c = session({ id: 'c', ownerWindowId: 'w1' });
    const last: Record<string, number> = {
      a: NOW - 4 * HOUR,
      b: NOW - 4 * HOUR,
      c: NOW - 4 * HOUR,
    };
    expect(pickShelvable([a, b, c], (id) => last[id]!, NOW, 3 * HOUR).map((s) => s.id)).toEqual([
      'b',
      'a',
    ]);
  });

  it('returns nothing when the feature is off', () => {
    expect(pickShelvable([session()], () => 0, NOW, 0)).toEqual([]);
  });
});

describe('resumableAgentOf / resumeArgs', () => {
  it('knows the built-in agent templates', () => {
    expect(resumableAgentOf({ id: 'claude-code', command: 'claude' })).toBe('claude-code');
    expect(resumableAgentOf({ id: 'codex', command: 'codex' })).toBe('codex');
    expect(resumableAgentOf({ id: 'shell', command: '' })).toBeNull();
    expect(resumableAgentOf({ id: 'gemini-cli', command: 'gemini' })).toBeNull();
  });

  it('recognises a custom template by its program name, with path or extension', () => {
    expect(resumableAgentOf({ id: 'x', command: 'C:\\tools\\claude.cmd' })).toBe('claude-code');
    expect(resumableAgentOf({ id: 'y', command: '/usr/local/bin/codex' })).toBe('codex');
    expect(resumableAgentOf({ id: 'z', command: 'claude-helper' })).toBeNull();
  });

  it('builds the resume arguments each agent expects', () => {
    expect(resumeArgs('claude-code', 'abc')).toEqual(['--resume', 'abc']);
    expect(resumeArgs('codex', 'abc')).toEqual(['resume', 'abc']);
  });
});

describe('claudeProjectSlug', () => {
  it('replaces every non-alphanumeric character with a dash', () => {
    expect(claudeProjectSlug('C:\\Users\\me\\Desktop\\ceteris')).toBe(
      'C--Users-me-Desktop-ceteris',
    );
    expect(claudeProjectSlug('/home/me/my project')).toBe('-home-me-my-project');
  });
});

describe('pushEntry', () => {
  it('puts the new entry first and caps the list', () => {
    let entries: ShelfEntry[] = [];
    for (let i = 0; i < SHELF_MAX_ENTRIES + 5; i++) {
      entries = pushEntry(entries, entry({ id: `e${i}` }));
    }
    expect(entries).toHaveLength(SHELF_MAX_ENTRIES);
    expect(entries[0]!.id).toBe(`e${SHELF_MAX_ENTRIES + 4}`);
    expect(entries.at(-1)!.id).toBe('e5');
  });
});

describe('sanitizeShelfFile', () => {
  it('accepts a good file and fills optional fields', () => {
    const file = sanitizeShelfFile({
      version: 1,
      entries: [
        {
          id: 'e1',
          pathId: 'C:\\work',
          templateId: 'codex',
          displayName: 'Codex',
          cwd: 'C:\\work',
          shelvedAt: NOW,
          resume: { agent: 'codex', sessionId: 'abc' },
        },
      ],
    });
    expect(file.entries).toHaveLength(1);
    const e = file.entries[0]!;
    expect(e.resume).toEqual({ agent: 'codex', sessionId: 'abc' });
    expect(e.createdAt).toBe(NOW);
    expect(e.lastActivityAt).toBe(NOW);
    expect(e.reason).toBe('auto');
    expect(e.sessionId).toBe('');
  });

  it('drops entries missing required fields and bad resume blocks', () => {
    const file = sanitizeShelfFile({
      entries: [
        { id: 'bad' },
        null,
        { ...entry({ id: 'ok' }), resume: { agent: 'gemini', sessionId: 'x' } },
      ],
    });
    expect(file.entries.map((e) => e.id)).toEqual(['ok']);
    expect(file.entries[0]!.resume).toBeNull();
  });

  it('gives an empty shelf for garbage', () => {
    expect(sanitizeShelfFile(null).entries).toEqual([]);
    expect(sanitizeShelfFile('x').entries).toEqual([]);
    expect(sanitizeShelfFile({ entries: 'nope' }).entries).toEqual([]);
  });
});
