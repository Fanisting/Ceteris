/**
 * @file src/main/agent-resume.test.ts
 * @purpose Finding a resume id in Claude Code's and Codex's own files (ADR-036). Uses a
 *   temporary home directory laid out like the real ones.
 */
import { mkdir, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claudeProjectSlug } from '@shared/shelf';
import {
  agentSessionExists,
  codexDayFolders,
  findAgentSessionId,
  readCodexMeta,
  RESUME_MATCH_SLACK_MS,
  sameDirectory,
} from './agent-resume';
import { createTempDataDir, removeTempDataDir } from './persistence';

const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';
const ID_C = '33333333-3333-4333-8333-333333333333';

let home: string;
const cwd = () => join(home, 'work');
const T0 = Date.UTC(2026, 10, 10, 8, 0, 0);
const HOUR = 3_600_000;

async function touch(path: string, mtimeMs: number, content = '{}\n'): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, content);
  await utimes(path, mtimeMs / 1000, mtimeMs / 1000);
}

async function claudeFile(id: string, mtimeMs: number, dir = cwd()): Promise<void> {
  await touch(join(home, '.claude', 'projects', claudeProjectSlug(dir), `${id}.jsonl`), mtimeMs);
}

function codexLine(id: string, dir: string): string {
  return (
    JSON.stringify({
      timestamp: 'x',
      type: 'session_meta',
      payload: { id, session_id: id, cwd: dir, base_instructions: 'hi' },
    }) + '\n{"type":"other"}\n'
  );
}

async function codexFile(id: string, mtimeMs: number, dir = cwd()): Promise<string> {
  const d = new Date(mtimeMs);
  const folder = join(
    home,
    '.codex',
    'sessions',
    String(d.getFullYear()),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  );
  const path = join(folder, `rollout-2026-11-10T08-00-00-${id}.jsonl`);
  await touch(path, mtimeMs, codexLine(id, dir));
  return path;
}

beforeEach(async () => {
  home = await createTempDataDir('ceteris-resume-');
});

afterEach(async () => {
  await removeTempDataDir(home);
});

describe('findAgentSessionId for Claude Code', () => {
  it('returns the newest transcript written while the tab was alive', async () => {
    await claudeFile(ID_A, T0 + HOUR);
    await claudeFile(ID_B, T0 + 2 * HOUR);
    const id = await findAgentSessionId({
      agent: 'claude-code',
      homeDir: home,
      cwds: [cwd()],
      since: T0,
      until: T0 + 3 * HOUR,
    });
    expect(id).toBe(ID_B);
  });

  it('ignores transcripts from before the tab and from after it went quiet', async () => {
    await claudeFile(ID_A, T0 - HOUR); // older tab in the same folder
    await claudeFile(ID_B, T0 + HOUR); // this tab
    await claudeFile(ID_C, T0 + 5 * HOUR); // another tab, still busy
    const id = await findAgentSessionId({
      agent: 'claude-code',
      homeDir: home,
      cwds: [cwd()],
      since: T0,
      until: T0 + HOUR + RESUME_MATCH_SLACK_MS / 2,
    });
    expect(id).toBe(ID_B);
  });

  it('tries every directory the tab may have used and skips non-uuid names', async () => {
    const other = join(home, 'other');
    await claudeFile(ID_A, T0 + HOUR, other);
    await touch(
      join(home, '.claude', 'projects', claudeProjectSlug(cwd()), 'notes.jsonl'),
      T0 + HOUR,
    );
    const id = await findAgentSessionId({
      agent: 'claude-code',
      homeDir: home,
      cwds: [cwd(), other],
      since: T0,
      until: T0 + 2 * HOUR,
    });
    expect(id).toBe(ID_A);
  });

  it('returns null when the project folder does not exist', async () => {
    const id = await findAgentSessionId({
      agent: 'claude-code',
      homeDir: home,
      cwds: [cwd()],
      since: T0,
      until: T0 + HOUR,
    });
    expect(id).toBeNull();
  });
});

describe('findAgentSessionId for Codex', () => {
  it('matches the rollout whose session_meta cwd is the tab folder', async () => {
    await codexFile(ID_A, T0 + HOUR, join(home, 'elsewhere'));
    await codexFile(ID_B, T0 + 2 * HOUR);
    const id = await findAgentSessionId({
      agent: 'codex',
      homeDir: home,
      cwds: [cwd()],
      since: T0,
      until: T0 + 3 * HOUR,
    });
    expect(id).toBe(ID_B);
  });

  it('compares directories without caring about slash direction', async () => {
    await codexFile(ID_A, T0 + HOUR, cwd().replace(/\\/g, '/'));
    const id = await findAgentSessionId({
      agent: 'codex',
      homeDir: home,
      cwds: [cwd()],
      since: T0,
      until: T0 + 2 * HOUR,
    });
    expect(id).toBe(ID_A);
  });

  it('skips files outside the time window and unreadable first lines', async () => {
    await codexFile(ID_A, T0 + 6 * HOUR);
    const bad = await codexFile(ID_B, T0 + HOUR);
    await writeFile(bad, 'not json\n');
    const id = await findAgentSessionId({
      agent: 'codex',
      homeDir: home,
      cwds: [cwd()],
      since: T0,
      until: T0 + 2 * HOUR,
    });
    expect(id).toBeNull();
  });

  it('reads id and cwd from a first line too long to parse whole', async () => {
    const path = join(home, 'long.jsonl');
    const head = `{"type":"session_meta","payload":{"id":"${ID_C}","cwd":"C:\\\\w o\\\\rk","base_instructions":"`;
    await writeFile(path, head + 'x'.repeat(300 * 1024));
    expect(await readCodexMeta(path)).toEqual({ id: ID_C, cwd: 'C:\\w o\\rk' });
  });
});

describe('codexDayFolders', () => {
  it('lists each local day from since to until, inclusive', () => {
    const since = new Date(2026, 10, 9, 23, 30).getTime();
    const until = new Date(2026, 10, 11, 0, 30).getTime();
    expect(codexDayFolders(since, until)).toEqual([
      join('2026', '11', '09'),
      join('2026', '11', '10'),
      join('2026', '11', '11'),
    ]);
  });
});

describe('sameDirectory', () => {
  it('ignores trailing slashes and slash direction', () => {
    expect(sameDirectory('C:\\a\\b\\', 'C:/a/b')).toBe(true);
    expect(sameDirectory('/x/y', '/x/z')).toBe(false);
  });
});

describe('agentSessionExists (ADR-039)', () => {
  it('Claude Code: true only for a transcript in one of the given folders', async () => {
    await claudeFile(ID_A, T0);
    await claudeFile(ID_B, T0, join(home, 'elsewhere'));
    const ask = (sessionId: string) =>
      agentSessionExists({ agent: 'claude-code', homeDir: home, cwds: [cwd()], sessionId });
    expect(await ask(ID_A)).toBe(true);
    expect(await ask(ID_B)).toBe(false);
    expect(await ask(ID_C)).toBe(false);
    expect(await ask('not-a-uuid')).toBe(false);
  });

  it('Codex: true for a rollout with that id in any day folder', async () => {
    await codexFile(ID_A, T0 - 40 * 24 * HOUR, join(home, 'other'));
    const ask = (sessionId: string) =>
      agentSessionExists({ agent: 'codex', homeDir: home, cwds: [cwd()], sessionId });
    expect(await ask(ID_A)).toBe(true);
    expect(await ask(ID_B)).toBe(false);
  });

  it('false when the agent folder does not exist', async () => {
    expect(
      await agentSessionExists({ agent: 'codex', homeDir: home, cwds: [], sessionId: ID_A }),
    ).toBe(false);
  });
});
