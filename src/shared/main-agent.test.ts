/**
 * @file src/shared/main-agent.test.ts
 * @purpose One test per rule of the main agent helpers (ADR-042).
 */
import { describe, expect, it } from 'vitest';
import {
  isAgentTemplateId,
  mainAgentFirst,
  preselectMainAgent,
  quickLaunchWithMain,
  resolveMainAgent,
} from './main-agent';
import { QUICK_LAUNCH_MAX_ITEMS, type QuickLaunchItem } from './quick-launch';

const templates = [{ id: 'shell' }, { id: 'claude-code' }, { id: 'codex' }, { id: 'gemini-cli' }];

describe('isAgentTemplateId', () => {
  it('counts every template except the two plain shells', () => {
    expect(isAgentTemplateId('shell')).toBe(false);
    expect(isAgentTemplateId('admin-shell')).toBe(false);
    expect(isAgentTemplateId('codex')).toBe(true);
    expect(isAgentTemplateId('my-wrapper')).toBe(true);
  });
});

describe('resolveMainAgent', () => {
  it('returns the stored agent when it exists and is installed', () => {
    expect(resolveMainAgent('codex', templates, new Set())).toBe('codex');
  });

  it('falls back to the first installed agent when nothing is stored', () => {
    expect(resolveMainAgent('', templates, new Set(['claude-code']))).toBe('codex');
  });

  it('skips a stored agent that is no longer on PATH', () => {
    expect(resolveMainAgent('codex', templates, new Set(['codex']))).toBe('claude-code');
  });

  it('skips a stored agent whose template was deleted', () => {
    expect(resolveMainAgent('aider', templates, new Set())).toBe('claude-code');
  });

  it('treats nothing as missing while the installed list is unknown', () => {
    expect(resolveMainAgent('gemini-cli', templates, null)).toBe('gemini-cli');
  });

  it('still names the first agent template when none is installed', () => {
    const all = new Set(['claude-code', 'codex', 'gemini-cli']);
    expect(resolveMainAgent('codex', templates, all)).toBe('claude-code');
  });

  it('returns null when there are only shells', () => {
    expect(resolveMainAgent('', [{ id: 'shell' }, { id: 'admin-shell' }], null)).toBeNull();
  });
});

describe('preselectMainAgent', () => {
  it('picks the agent opened most often', () => {
    const counts = new Map([
      ['claude-code', 2],
      ['codex', 9],
    ]);
    expect(preselectMainAgent(['claude-code', 'codex'], counts)).toBe('codex');
  });

  it('picks the first agent when none was ever opened', () => {
    expect(preselectMainAgent(['codex', 'claude-code'], new Map())).toBe('codex');
  });

  it('ignores counts of agents that are not offered', () => {
    expect(preselectMainAgent(['codex'], new Map([['claude-code', 50]]))).toBe('codex');
  });

  it('returns null for an empty list', () => {
    expect(preselectMainAgent([], new Map())).toBeNull();
  });
});

describe('quickLaunchWithMain', () => {
  const t = (id: string): QuickLaunchItem => ({ kind: 'template', id });
  const s = (id: string): QuickLaunchItem => ({ kind: 'shell', id });

  it('moves an agent already in the list to the front', () => {
    expect(quickLaunchWithMain([t('claude-code'), t('codex')], 'codex')).toEqual([
      t('codex'),
      t('claude-code'),
    ]);
  });

  it('adds an agent that was not in the list at the front', () => {
    expect(quickLaunchWithMain([s('pwsh')], 'codex')).toEqual([t('codex'), s('pwsh')]);
  });

  it('drops the last agent, not a shell, when the list is full', () => {
    const full = [
      t('claude-code'),
      t('opencode'),
      ...Array.from({ length: QUICK_LAUNCH_MAX_ITEMS - 2 }, (_, i) => s(`sh${i}`)),
    ];
    const next = quickLaunchWithMain(full, 'codex');
    expect(next).toHaveLength(QUICK_LAUNCH_MAX_ITEMS);
    expect(next[0]).toEqual(t('codex'));
    expect(next).not.toContainEqual(t('opencode'));
    expect(next).toContainEqual(t('claude-code'));
  });

  it('drops the last item when a full list holds only shells', () => {
    const full = Array.from({ length: QUICK_LAUNCH_MAX_ITEMS }, (_, i) => s(`sh${i}`));
    const next = quickLaunchWithMain(full, 'codex');
    expect(next).toHaveLength(QUICK_LAUNCH_MAX_ITEMS);
    expect(next).not.toContainEqual(s(`sh${QUICK_LAUNCH_MAX_ITEMS - 1}`));
  });

  it('does not touch a shell item that shares the agent id', () => {
    expect(quickLaunchWithMain([s('codex')], 'codex')).toEqual([t('codex'), s('codex')]);
  });
});

describe('mainAgentFirst', () => {
  it('puts the main agent first and keeps the rest in order', () => {
    const ids = mainAgentFirst(templates, 'codex').map((x) => x.id);
    expect(ids).toEqual(['codex', 'shell', 'claude-code', 'gemini-cli']);
  });

  it('keeps the order when the main agent is not in the list', () => {
    expect(mainAgentFirst(templates, null)).toEqual(templates);
  });
});
