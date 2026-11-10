/**
 * @file src/shared/agent-model.test.ts
 * @purpose Rules of agent-model.ts (ADR-038): validation, folder defaults, launch flags,
 *   relaunch arguments, shell command lines, colour steps.
 */
import { describe, expect, it } from 'vitest';
import {
  contextLevel,
  effortLevel,
  exitResumeId,
  folderDefaultFor,
  sanitizeFolderDefaults,
  isValidFolderAgentDefaults,
  launchArgs,
  modelAgentOf,
  modelLabel,
  relaunchArgs,
  shellCommandLine,
  withFolderDefault,
  type FolderAgentDefault,
} from './agent-model';

const entry = (over: Partial<FolderAgentDefault> = {}): FolderAgentDefault => ({
  pathId: 'C:\\p\\a',
  agent: 'claude-code',
  model: 'opus',
  effort: 'high',
  ...over,
});

describe('modelAgentOf', () => {
  it('knows only Claude Code and Codex', () => {
    expect(modelAgentOf('claude-code')).toBe('claude-code');
    expect(modelAgentOf('codex')).toBe('codex');
    expect(modelAgentOf('shell')).toBeNull();
    expect(modelAgentOf(undefined)).toBeNull();
  });
});

describe('isValidFolderAgentDefaults', () => {
  it('accepts an empty list and well formed entries', () => {
    expect(isValidFolderAgentDefaults([])).toBe(true);
    expect(isValidFolderAgentDefaults([entry(), entry({ agent: 'codex', model: '' })])).toBe(true);
  });

  it('rejects unsafe values, unknown agents, duplicates and non-lists', () => {
    expect(isValidFolderAgentDefaults([entry({ model: 'opus; rm -rf' })])).toBe(false);
    expect(isValidFolderAgentDefaults([entry({ effort: 'a"b' })])).toBe(false);
    expect(isValidFolderAgentDefaults([{ ...entry(), agent: 'aider' }])).toBe(false);
    expect(isValidFolderAgentDefaults([entry(), entry({ model: 'sonnet' })])).toBe(false);
    expect(isValidFolderAgentDefaults([entry({ pathId: '' })])).toBe(false);
    expect(isValidFolderAgentDefaults({})).toBe(false);
  });
});

describe('folder defaults', () => {
  it('reads empty strings when nothing is set', () => {
    expect(folderDefaultFor(undefined, 'x', 'codex')).toEqual({ model: '', effort: '' });
    expect(folderDefaultFor([entry()], 'C:\\p\\a', 'codex')).toEqual({ model: '', effort: '' });
  });

  it('adds, replaces in place and removes', () => {
    const a = entry();
    const b = entry({ pathId: 'C:\\p\\b' });
    const added = withFolderDefault([a], 'C:\\p\\b', 'claude-code', {
      model: 'opus',
      effort: 'high',
    });
    expect(added).toEqual([a, b]);
    const replaced = withFolderDefault(added, 'C:\\p\\a', 'claude-code', {
      model: 'haiku',
      effort: '',
    });
    expect(replaced).toEqual([{ ...a, model: 'haiku', effort: '' }, b]);
    expect(
      withFolderDefault(replaced, 'C:\\p\\a', 'claude-code', { model: '', effort: '' }),
    ).toEqual([b]);
  });
});

describe('launchArgs', () => {
  it('builds Claude Code flags', () => {
    expect(launchArgs('claude-code', { model: 'opus', effort: 'max' })).toEqual([
      '--model',
      'opus',
      '--effort',
      'max',
    ]);
  });

  it('builds Codex flags with a config override for effort', () => {
    expect(launchArgs('codex', { model: 'gpt-6.1-sol', effort: 'high' })).toEqual([
      '-m',
      'gpt-6.1-sol',
      '-c',
      'model_reasoning_effort=high',
    ]);
  });

  it('passes nothing for defaults and skips unsafe values', () => {
    expect(launchArgs('claude-code', { model: '', effort: '' })).toEqual([]);
    expect(launchArgs('codex', { model: 'x y', effort: 'high' })).toEqual([
      '-c',
      'model_reasoning_effort=high',
    ]);
  });
});

describe('relaunchArgs', () => {
  const pick = { model: 'sonnet', effort: 'low' };

  it('resumes the Claude Code conversation with session flags', () => {
    expect(relaunchArgs('claude-code', pick, 'abc-1', 'new')).toEqual({
      args: ['--resume', 'abc-1', '--model', 'sonnet', '--effort', 'low'],
      launchId: 'abc-1',
    });
  });

  it('gives Claude Code a fresh session id when nothing was written yet', () => {
    expect(relaunchArgs('claude-code', pick, null, 'new-id')).toEqual({
      args: ['--session-id', 'new-id', '--model', 'sonnet', '--effort', 'low'],
      launchId: 'new-id',
    });
  });

  it('resumes Codex by id, or starts it fresh', () => {
    const codexPick = { model: 'gpt-x', effort: 'high' };
    expect(relaunchArgs('codex', codexPick, 'r-1', 'n')).toEqual({
      args: ['resume', 'r-1', '-m', 'gpt-x', '-c', 'model_reasoning_effort=high'],
    });
    expect(relaunchArgs('codex', { model: '', effort: '' }, null, 'n')).toEqual({ args: [] });
  });

  it('refuses an id with shell characters', () => {
    expect(() => relaunchArgs('claude-code', pick, 'a;b', 'n')).toThrow(/not a plain id/);
  });
});

describe('shellCommandLine', () => {
  it('joins plain words as they are', () => {
    expect(shellCommandLine('codex', ['resume', 'a-1', '-c', 'model_reasoning_effort=high'])).toBe(
      'codex resume a-1 -c model_reasoning_effort=high',
    );
  });

  it('refuses any word a shell might read differently', () => {
    // spaces, quotes ($ " “), pwsh array and splat (, @), zsh glob ([ ]), bash escape (\ !),
    // cmd variables (%), newlines, non-ASCII and empty words
    for (const bad of [
      'C:\\my dir',
      'a"b',
      '$HOME',
      'x”y',
      'a,b',
      '@args',
      'opus[1m]',
      'C:\\x',
      'hi!',
      '%PATH%',
      'x\ny',
      'ü',
      '',
    ]) {
      expect(() => shellCommandLine('claude', [bad])).toThrow(/not a plain word/);
    }
  });
});

describe('exitResumeId', () => {
  const id1 = '7ad8b104-47e5-4db9-a802-25da7c8ee1c0';
  const id2 = '01a1c626-6db9-7860-b062-d228a8c0a97e';

  it('reads what Claude Code prints on exit, taking the last id on screen', () => {
    const screen = `PS> claude --resume ${id2} --model opus\n...\nResume this session with:\nclaude --model opus --effort high --resume ${id1}\nPS>`;
    expect(exitResumeId('claude-code', screen)).toBe(id1);
  });

  it('reads what Codex prints on exit', () => {
    const screen = `To continue this session, run:\n  codex resume ${id2}\nOr run codex resume and select it.`;
    expect(exitResumeId('codex', screen)).toBe(id2);
  });

  it('returns null when the agent printed no id', () => {
    expect(exitResumeId('claude-code', 'PS C:\\p>')).toBeNull();
    expect(exitResumeId('codex', `claude --resume ${id1}`)).toBeNull();
  });
});

describe('sanitizeFolderDefaults', () => {
  it('keeps valid entries and drops bad shapes, unsafe values and repeats', () => {
    const good = entry();
    expect(
      sanitizeFolderDefaults([
        good,
        null,
        { ...good, model: 'x y' },
        { ...good },
        entry({ agent: 'codex' }),
      ]),
    ).toEqual([good, entry({ agent: 'codex' })]);
  });

  it('turns anything that is not a list into an empty list', () => {
    expect(sanitizeFolderDefaults(null)).toEqual([]);
    expect(sanitizeFolderDefaults({ a: 1 })).toEqual([]);
  });
});

describe('labels and colour steps', () => {
  it('names Claude aliases and keeps Codex slugs', () => {
    expect(modelLabel('claude-code', 'opus')).toBe('Opus');
    expect(modelLabel('codex', 'gpt-6.1-sol')).toBe('gpt-6.1-sol');
  });

  it('turns context yellow at 70 and red at 85', () => {
    expect(contextLevel(69)).toBe('ok');
    expect(contextLevel(70)).toBe('warn');
    expect(contextLevel(85)).toBe('high');
  });

  it('steps effort from low to top', () => {
    expect(['low', 'medium', 'high', 'max', 'odd'].map(effortLevel)).toEqual([
      'low',
      'mid',
      'high',
      'top',
      'mid',
    ]);
  });
});
