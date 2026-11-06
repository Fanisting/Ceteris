import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SettingsArchiveV1 } from '@shared/protocol';
import {
  encodeClaudeProject,
  importAgents,
  measureAgentChats,
  readArchive,
  readManifest,
  readTabs,
  remapClaudeProject,
  remapHomePath,
  resumeCommand,
  stripSecrets,
  withLocalSecrets,
  writeBundle,
} from './data-bundle';

const SECRET = 'SECRET-LOGIN-TOKEN';

function archive(): SettingsArchiveV1 {
  return {
    format: 'ceteris-archive',
    version: 1,
    exportedAt: 1,
    exportedFrom: 'test',
    settings: {
      ai: {
        apiKey: SECRET,
        statusRecheckEnabled: true,
        nextPrompt: { enabled: true, apiKey: SECRET, model: 'm' },
      },
      link: {
        hostEnabled: true,
        hostToken: SECRET,
        savedHosts: [{ id: '1', label: 'pc', host: 'h', port: 1, token: SECRET, autoConnect: true }],
      },
    },
    bookmarks: { paths: [] },
    recent: { paths: [] },
    templates: { defaultTemplateId: 'shell', templates: [{ id: 't', env: { KEY: SECRET } }] },
  } as unknown as SettingsArchiveV1;
}

async function write(path: string, text: string, mtime?: Date): Promise<void> {
  await fs.mkdir(join(path, '..'), { recursive: true });
  await fs.writeFile(path, text);
  if (mtime) await fs.utimes(path, mtime, mtime);
}

async function allFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { recursive: true, withFileTypes: true });
  return entries.filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name));
}

describe('data bundle', () => {
  let base: string;
  let home: string;
  let other: string;
  let bundle: string;

  const OLD = new Date('2026-01-01');
  const NEW = new Date('2026-06-01');

  const seed = async (): Promise<void> => {
    await write(join(home, '.claude/projects/C--Users-a-proj/chat.jsonl'), 'claude chat', OLD);
    await write(join(home, '.claude/history.jsonl'), 'history');
    await write(join(home, '.claude/.credentials.json'), SECRET);
    await write(join(home, '.claude/settings.json'), SECRET);
    await write(join(home, '.claude/plugins/big.bin'), 'x');
    await write(join(home, '.codex/sessions/2026/11/rollout.jsonl'), 'codex chat');
    await write(join(home, '.codex/session_index.jsonl'), 'index');
    await write(join(home, '.codex/auth.json'), SECRET);
    await write(join(home, '.codex/config.toml'), SECRET);
    await write(join(home, '.codex/packages/huge.bin'), 'x');
  };

  const makeBundle = (agents: Array<'claude' | 'codex'>) =>
    writeBundle({
      dir: bundle,
      home,
      hostname: 'pc',
      now: 1,
      archive: archive(),
      tabs: [],
      agents,
    });

  beforeEach(async () => {
    base = await fs.mkdtemp(join(tmpdir(), 'ceteris-bundle-'));
    home = join(base, 'home');
    other = join(base, 'other');
    bundle = join(base, 'bundle');
    await seed();
  });
  afterEach(async () => {
    await fs.rm(base, { recursive: true, force: true });
  });

  it('with no agents chosen the bundle is only the light Ceteris files', async () => {
    await makeBundle([]);
    const names = (await fs.readdir(bundle)).sort();
    expect(names).toEqual(['ceteris.json', 'manifest.json', 'tabs.json']);
  });

  it('copies only the agents that were chosen', async () => {
    await makeBundle(['codex']);
    expect((await fs.readdir(join(bundle, 'agents')))).toEqual(['codex']);
  });

  it('SECURITY: no credential or secret reaches the bundle in any form', async () => {
    await makeBundle(['claude', 'codex']);
    for (const file of await allFiles(bundle)) {
      expect(await fs.readFile(file, 'utf-8')).not.toContain(SECRET);
    }
    const names = (await allFiles(bundle)).join('\n');
    expect(names).not.toMatch(/credentials|auth\.json|config\.toml/);
  });

  it('skips what is not chat, which keeps the size down', async () => {
    await makeBundle(['claude', 'codex']);
    expect((await allFiles(bundle)).join('\n')).not.toMatch(/plugins|packages/);
  });

  it('measures what an export would copy', async () => {
    const stats = await measureAgentChats(home, 'claude');
    expect(stats.files).toBe(2);
    expect(stats.bytes).toBe('claude chat'.length + 'history'.length);
  });

  it('import finds each agent itself and puts chats in that agent folder', async () => {
    const manifest = await makeBundle(['claude', 'codex']);
    const results = await importAgents(bundle, other, manifest);
    expect(results.claude?.files).toBe(2);
    expect(results.codex?.files).toBe(2);
    await expect(fs.readFile(join(other, '.codex/sessions/2026/11/rollout.jsonl'), 'utf-8')).resolves.toBe('codex chat');
  });

  it('import ignores an agent that is not in the bundle', async () => {
    const manifest = await makeBundle(['claude']);
    const results = await importAgents(bundle, other, manifest);
    expect(results.codex).toBeUndefined();
    await expect(fs.stat(join(other, '.codex'))).rejects.toThrow();
  });

  it('moves Claude project folders to the new user name', async () => {
    const manifest = { ...(await makeBundle(['claude'])), home: 'C:\\Users\\a' };
    await importAgents(bundle, other, manifest);
    const expected = encodeClaudeProject(other);
    const projects = await fs.readdir(join(other, '.claude/projects'));
    expect(projects[0]?.startsWith(expected)).toBe(true);
    expect(projects[0]?.endsWith('-proj')).toBe(true);
  });

  it('never overwrites a newer chat on the new PC', async () => {
    const manifest = await makeBundle(['claude']);
    const target = join(other, '.claude/history.jsonl');
    await write(target, 'mine', new Date(Date.now() + 86_400_000));
    await importAgents(bundle, other, manifest);
    await expect(fs.readFile(target, 'utf-8')).resolves.toBe('mine');
  });

  it('replaces an older copy of the same chat', async () => {
    const manifest = await makeBundle(['claude']);
    const target = join(other, '.claude/history.jsonl');
    await write(target, 'stale', new Date('2020-01-01'));
    await importAgents(bundle, other, manifest);
    await expect(fs.readFile(target, 'utf-8')).resolves.toBe('history');
  });

  it('keeps the new PC Codex index if it already has one', async () => {
    await write(join(home, '.codex/thread_history_1.sqlite'), 'old pc');
    const manifest = await makeBundle(['codex']);
    await write(join(other, '.codex/thread_history_1.sqlite'), 'new pc', NEW);
    await importAgents(bundle, other, manifest);
    await expect(fs.readFile(join(other, '.codex/thread_history_1.sqlite'), 'utf-8')).resolves.toBe('new pc');
  });

  it('keeps chat timestamps, because agents sort by them', async () => {
    const manifest = await makeBundle(['claude']);
    await importAgents(bundle, other, manifest);
    const file = (await allFiles(join(other, '.claude/projects')))[0] as string;
    expect(Math.abs((await fs.stat(file)).mtimeMs - OLD.getTime())).toBeLessThan(2000);
  });

  it('rejects a folder that is not a finished export', async () => {
    await expect(readManifest(base)).rejects.toThrow(/manifest\.json/);
  });

  it('a stripped archive still round trips through reading', async () => {
    await makeBundle([]);
    expect((await readArchive(bundle)).settings.ai.apiKey).toBe('');
  });

  it('reopens tabs and skips folders this PC does not have', async () => {
    await fs.mkdir(bundle, { recursive: true });
    await fs.writeFile(
      join(bundle, 'tabs.json'),
      JSON.stringify([
        { pathId: home, templateId: 'shell', displayName: 'a', currentCwd: home, agent: null },
        { pathId: home, templateId: 'claude-code', displayName: 'b', currentCwd: home, agent: 'claude' },
        { pathId: join(base, 'gone'), templateId: 'shell', displayName: 'c', currentCwd: null, agent: null },
      ]),
    );
    const { tabs, missing } = await readTabs(bundle, home, home);
    expect(missing).toBe(1);
    expect(tabs[0]?.input).toBe('');
    expect(tabs[1]?.templateId).toBe('shell');
    expect(Buffer.from(tabs[1]?.input ?? '', 'base64').toString()).toBe('claude --continue\r');
  });
});

describe('secrets in settings', () => {
  it('strips keys, tokens and template env', () => {
    const out = JSON.stringify(stripSecrets(archive()));
    expect(out).not.toContain(SECRET);
  });

  it('does not change the archive it was given', () => {
    const input = archive();
    stripSecrets(input);
    expect(input.settings.ai.apiKey).toBe(SECRET);
  });

  it('keeps this PC keys and remote setup on import', () => {
    const current = archive().settings;
    const merged = withLocalSecrets(stripSecrets(archive()), current);
    expect(merged.settings.ai.apiKey).toBe(SECRET);
    expect(merged.settings.link.hostToken).toBe(SECRET);
  });

  it('turns off features that would have no key on the new PC', () => {
    const current = archive().settings;
    current.ai.apiKey = '';
    current.ai.nextPrompt.apiKey = '';
    const merged = withLocalSecrets(archive(), current);
    expect(merged.settings.ai.statusRecheckEnabled).toBe(false);
    expect(merged.settings.ai.nextPrompt.enabled).toBe(false);
  });
});

describe('path helpers', () => {
  it('moves a Claude project to the new home', () => {
    expect(remapClaudeProject('C--Users-a-Desktop-x', 'C:\\Users\\a', 'C:\\Users\\b')).toBe('C--Users-b-Desktop-x');
    expect(remapClaudeProject('C--Users-a', 'C:\\Users\\a', 'C:\\Users\\b')).toBe('C--Users-b');
  });

  it('leaves projects outside the home alone, including lookalike names', () => {
    expect(remapClaudeProject('D--work-x', 'C:\\Users\\a', 'C:\\Users\\b')).toBe('D--work-x');
    expect(remapClaudeProject('C--Users-abc', 'C:\\Users\\a', 'C:\\Users\\b')).toBe('C--Users-abc');
  });

  it('moves paths under the home and no others', () => {
    expect(remapHomePath('C:\\Users\\a\\x', 'C:\\Users\\a', 'C:\\Users\\b')).toBe('C:\\Users\\b\\x');
    expect(remapHomePath('C:\\Users\\abc', 'C:\\Users\\a', 'C:\\Users\\b')).toBe('C:\\Users\\abc');
  });

  it('resumes the agent, changing folder only when it moved', () => {
    expect(resumeCommand('codex', 'C:\\x', 'c:\\X')).toBe('codex resume --last\r');
    expect(resumeCommand('claude', 'C:\\x\\sub', 'C:\\x')).toBe('cd "C:\\x\\sub"; claude --continue\r');
  });
});
