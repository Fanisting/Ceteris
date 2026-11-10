/**
 * @file src/shared/session-restore.test.ts
 * @purpose Rules for reopening tabs at launch (ADR-039): which tabs start, which resume
 *   flags they get, which tab the first window shows, and how restore.json is read.
 */
import { describe, expect, it } from 'vitest';
import {
  launchArgs,
  pickFocusTab,
  restoreKind,
  sanitizeRestoreFile,
  RESTORE_MAX_TABS,
  type RestoreTab,
} from './session-restore';

const FOLDER_ARGS = { 'claude-code': ['--continue'], opencode: ['--continue'] };

function tab(over: Partial<RestoreTab> = {}): RestoreTab {
  return {
    pathId: 'C:\\work',
    templateId: 'claude-code',
    displayName: 'fix login',
    keepName: true,
    role: null,
    cwd: 'C:\\work',
    originalCwd: 'C:\\work',
    createdAt: 1000,
    lastActivityAt: 2000,
    lastEnterAt: 0,
    shown: false,
    resume: null,
    ...over,
  };
}

describe('restoreKind', () => {
  const t = (id: string, command: string, isBuiltin = true) => ({ id, command, isBuiltin });

  it('a deleted template is skipped', () => {
    expect(restoreKind(null, false)).toBe('skip');
  });

  it('a plain shell starts again', () => {
    expect(restoreKind(t('shell', ''), false)).toBe('launch');
    expect(restoreKind(t('my-shell', '  ', false), false)).toBe('launch');
  });

  it('built-in agents start again', () => {
    expect(restoreKind(t('claude-code', 'claude'), false)).toBe('launch');
    expect(restoreKind(t('codex', 'codex'), false)).toBe('launch');
  });

  it('custom commands and the Admin Shell wait in the shelf', () => {
    expect(restoreKind(t('deploy', 'npm', false), false)).toBe('shelf');
    expect(restoreKind(t('admin-shell', 'powershell.exe'), false)).toBe('shelf');
  });

  it('every SSH tab waits in the shelf, even a shell', () => {
    expect(restoreKind(t('shell', ''), true)).toBe('shelf');
  });
});

describe('launchArgs', () => {
  it('an id resumes that exact conversation', () => {
    const a = tab({ resume: { agent: 'claude-code', sessionId: 'abc' } });
    expect(launchArgs(a, [a], FOLDER_ARGS)).toEqual(['--resume', 'abc']);
    const c = tab({ templateId: 'codex', resume: { agent: 'codex', sessionId: 'x' } });
    expect(launchArgs(c, [c], FOLDER_ARGS)).toEqual(['resume', 'x']);
  });

  it('Claude Code and Codex without an id start fresh', () => {
    const a = tab();
    expect(launchArgs(a, [a], FOLDER_ARGS)).toEqual([]);
    const c = tab({ templateId: 'codex' });
    expect(launchArgs(c, [c], { codex: ['resume', '--last'] })).toEqual([]);
  });

  it('other agents use the folder flag only as the one tab of their agent there', () => {
    const a = tab({ templateId: 'opencode' });
    expect(launchArgs(a, [a], FOLDER_ARGS)).toEqual(['--continue']);
    const b = tab({ templateId: 'opencode', createdAt: 1500 });
    expect(launchArgs(a, [a, b], FOLDER_ARGS)).toEqual([]);
    const elsewhere = tab({ templateId: 'opencode', pathId: 'D:/other' });
    expect(launchArgs(a, [a, elsewhere], FOLDER_ARGS)).toEqual(['--continue']);
  });

  it('agents without resume flags and shells start plain', () => {
    const s = tab({ templateId: 'shell' });
    expect(launchArgs(s, [s], FOLDER_ARGS)).toEqual([]);
  });
});

describe('pickFocusTab', () => {
  it('-1 when no window showed a tab', () => {
    expect(pickFocusTab([tab(), tab()])).toBe(-1);
    expect(pickFocusTab([])).toBe(-1);
  });

  it('of several shown tabs, the last Enter wins, then the last activity', () => {
    const tabs = [
      tab({ shown: true, lastEnterAt: 50 }),
      tab({ shown: true, lastEnterAt: 90 }),
      tab({ shown: false, lastEnterAt: 999 }),
    ];
    expect(pickFocusTab(tabs)).toBe(1);
    const tie = [
      tab({ shown: true, lastActivityAt: 10 }),
      tab({ shown: true, lastActivityAt: 30 }),
    ];
    expect(pickFocusTab(tie)).toBe(1);
  });
});

describe('sanitizeRestoreFile', () => {
  it('garbage gives an empty file', () => {
    expect(sanitizeRestoreFile(null).tabs).toEqual([]);
    expect(sanitizeRestoreFile({ tabs: 'x' }).tabs).toEqual([]);
  });

  it('drops bad tabs one by one and fills defaults', () => {
    const out = sanitizeRestoreFile({
      savedAt: 5,
      tabs: [
        { pathId: '', templateId: 'shell', createdAt: 1 },
        { templateId: 'shell', createdAt: 1 },
        {
          pathId: 'C:\\a',
          templateId: 'claude-code',
          createdAt: 3,
          role: 'boss',
          resume: { agent: 'vim', sessionId: 'x' },
        },
      ],
    });
    expect(out.savedAt).toBe(5);
    expect(out.tabs).toHaveLength(1);
    expect(out.tabs[0]).toMatchObject({
      pathId: 'C:\\a',
      role: null,
      resume: null,
      lastActivityAt: 3,
      lastEnterAt: 0,
      shown: false,
      keepName: false,
    });
  });

  it('keeps a valid role and resume id', () => {
    const out = sanitizeRestoreFile({
      tabs: [tab({ role: 'coordinator', resume: { agent: 'codex', sessionId: 'id1' } })],
    });
    expect(out.tabs[0]!.role).toBe('coordinator');
    expect(out.tabs[0]!.resume).toEqual({ agent: 'codex', sessionId: 'id1' });
  });

  it('sorts by creation and keeps only the newest RESTORE_MAX_TABS', () => {
    const many = Array.from({ length: RESTORE_MAX_TABS + 5 }, (_, i) =>
      tab({ createdAt: RESTORE_MAX_TABS + 5 - i }),
    );
    const out = sanitizeRestoreFile({ tabs: many });
    expect(out.tabs).toHaveLength(RESTORE_MAX_TABS);
    expect(out.tabs[0]!.createdAt).toBe(6);
    expect(out.tabs.at(-1)!.createdAt).toBe(RESTORE_MAX_TABS + 5);
  });
});
