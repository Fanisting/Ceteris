import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./logger', () => ({ logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

import { JsonStore } from './persistence';
import { SecretStore, type Encryption, type SecretsFile } from './secret-store';

/** Stands in for DPAPI: reversible, and never leaves the plain text in the output. */
const fakeEncryption = (available = true): Encryption => ({
  isEncryptionAvailable: () => available,
  encryptString: (plain) => Buffer.from(`enc:${[...plain].reverse().join('')}`),
  decryptString: (cipher) => {
    const text = cipher.toString();
    if (!text.startsWith('enc:')) throw new Error('not ours');
    return [...text.slice(4)].reverse().join('');
  },
});

let dir = '';
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ceteris-test-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const KEY = 'sk-or-v1-plaintext-key';

async function open(encryption: Encryption): Promise<{ secrets: SecretStore; file: string }> {
  const file = join(dir, 'secrets.json');
  const secrets = new SecretStore(new JsonStore<SecretsFile>(file, 0), encryption);
  await secrets.initialize();
  return { secrets, file };
}

describe('SecretStore', () => {
  it('writes only cipher text, and reads the key back after a restart', async () => {
    const first = await open(fakeEncryption());
    first.secrets.setNextPromptKey(KEY);
    await first.secrets.flush();
    expect(await readFile(first.file, 'utf8')).not.toContain(KEY);

    const again = await open(fakeEncryption());
    expect(again.secrets.getNextPromptKey()).toBe(KEY);
    again.secrets.setNextPromptKey('');
    await again.secrets.flush();
    expect(again.secrets.hasNextPromptKey()).toBe(false);
  });

  it('treats a file it cannot decrypt, as from another PC, as no key', async () => {
    const first = await open(fakeEncryption());
    first.secrets.setNextPromptKey(KEY);
    await first.secrets.flush();
    const other = await open({
      ...fakeEncryption(),
      decryptString: () => {
        throw new Error('DPAPI');
      },
    });
    expect(other.secrets.getNextPromptKey()).toBe('');
  });

  it('keeps the key in memory only when the OS cannot encrypt', async () => {
    const { secrets, file } = await open(fakeEncryption(false));
    secrets.setNextPromptKey(KEY);
    await secrets.flush();
    expect(secrets.getNextPromptKey()).toBe(KEY);
    expect(await readFile(file, 'utf8')).not.toContain(KEY);
  });
});
