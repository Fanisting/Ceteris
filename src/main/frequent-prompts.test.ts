import { mkdtemp, rm, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./logger', () => ({ logger: { warn: vi.fn(), debug: vi.fn() } }));

import { agentHistoryFiles, FrequentPromptReader } from './frequent-prompts';

let dir = '';
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ceteris-test-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const lines = (key: string, text: string, n: number): string =>
  `${JSON.stringify({ [key]: text })}\n`.repeat(n);

describe('FrequentPromptReader', () => {
  it('merges both agents, survives a missing file, and rereads after a new message', async () => {
    const claude = join(dir, 'claude.jsonl');
    const codex = join(dir, 'codex.jsonl');
    await writeFile(claude, lines('display', 'commit and push', 2));
    await writeFile(codex, lines('text', 'commit and push', 1));
    const reader = new FrequentPromptReader([claude, codex, join(dir, 'missing.jsonl')]);
    expect(await reader.get()).toEqual([{ text: 'commit and push', count: 3 }]);

    await appendFile(codex, lines('text', 'commit and push', 1));
    expect(await reader.get()).toEqual([{ text: 'commit and push', count: 4 }]);
  });

  it('follows CLAUDE_CONFIG_DIR and CODEX_HOME like the agents do', () => {
    expect(agentHistoryFiles({ CLAUDE_CONFIG_DIR: join(dir, 'c'), CODEX_HOME: join(dir, 'x') }, 'home')).toEqual([
      join(dir, 'c', 'history.jsonl'),
      join(dir, 'x', 'history.jsonl'),
    ]);
  });
});
