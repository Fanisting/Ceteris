/**
 * @file src/main/text-writer.test.ts
 * @purpose A save replaces the whole file or nothing, and never over someone else's change.
 *   Uses a real temporary folder: the rename is the behaviour under test.
 */
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TEXT_WRITE_MAX_BYTES } from '@shared/text-file';
import { writeTextFile } from './text-writer';

vi.mock('./logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

let dir: string;
const b64 = (text: string): string => Buffer.from(text).toString('base64');
const stamp = async (path: string) => {
  const stat = await fs.stat(path);
  return { mtimeMs: stat.mtimeMs, size: stat.size };
};

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'ceteris-text-writer-'));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('writeTextFile', () => {
  it('replaces the file and returns what the next save must quote', async () => {
    const path = join(dir, 'a.txt');
    await fs.writeFile(path, 'old');
    const res = await writeTextFile({ path, base64: b64('new text'), expected: await stamp(path) });
    expect(await fs.readFile(path, 'utf8')).toBe('new text');
    expect(res).toEqual({ ok: true, ...(await stamp(path)) });
  });

  it('leaves no temporary file behind', async () => {
    const path = join(dir, 'a.txt');
    await fs.writeFile(path, 'old');
    await writeTextFile({ path, base64: b64('new'), expected: await stamp(path) });
    expect(await fs.readdir(dir)).toEqual(['a.txt']);
  });

  it('refuses when the file changed after it was loaded', async () => {
    const path = join(dir, 'a.txt');
    await fs.writeFile(path, 'old');
    const expected = await stamp(path);
    await fs.writeFile(path, 'an agent wrote this');
    const res = await writeTextFile({ path, base64: b64('mine'), expected });
    expect(res).toEqual({ ok: false, reason: 'changed' });
    expect(await fs.readFile(path, 'utf8')).toBe('an agent wrote this');
  });

  it('overwrites when the user chose to, with no expected value', async () => {
    const path = join(dir, 'a.txt');
    await fs.writeFile(path, 'theirs');
    await writeTextFile({ path, base64: b64('mine'), expected: null });
    expect(await fs.readFile(path, 'utf8')).toBe('mine');
  });

  it('does not create a missing file', async () => {
    const path = join(dir, 'missing.txt');
    expect(await writeTextFile({ path, base64: b64('x'), expected: null })).toEqual({
      ok: false,
      reason: 'not-found',
    });
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it.each(['a.exe', 'a.md', 'relative.txt'])('refuses %s', async (name) => {
    const path = name === 'relative.txt' ? name : join(dir, name);
    const res = await writeTextFile({ path, base64: b64('x'), expected: null });
    expect(res).toEqual({ ok: false, reason: 'not-found' });
  });

  it('refuses a save too large for one Link frame', async () => {
    const path = join(dir, 'a.txt');
    await fs.writeFile(path, 'old');
    const base64 = Buffer.alloc(TEXT_WRITE_MAX_BYTES + 3).toString('base64');
    expect(await writeTextFile({ path, base64, expected: null })).toEqual({
      ok: false,
      reason: 'too-large',
    });
    expect(await fs.readFile(path, 'utf8')).toBe('old');
  });

  it('refuses a read-only file', async () => {
    const path = join(dir, 'a.txt');
    await fs.writeFile(path, 'old');
    await fs.chmod(path, 0o444);
    const res = await writeTextFile({ path, base64: b64('new'), expected: null });
    await fs.chmod(path, 0o644);
    expect(res).toEqual({ ok: false, reason: 'denied' });
    expect(await fs.readFile(path, 'utf8')).toBe('old');
  });
});
