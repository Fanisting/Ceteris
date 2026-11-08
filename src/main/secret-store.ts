/**
 * @file src/main/secret-store.ts
 * @purpose Keeps API keys out of settings.json. Each key is encrypted with the OS credential
 *   protection (Electron safeStorage: DPAPI on Windows, Keychain on macOS, libsecret on
 *   Linux) and written to secrets.json, which only the main process reads.
 *
 * @关键设计:
 * - settings.json is broadcast to every window and to remote views over Ceteris Link, and
 *   copied to settings.json.bak on each write. A key there leaks to all of them. Here it
 *   never leaves the main process; settings carries only a keySaved flag.
 * - The cipher text is bound to this Windows user on this PC, so a copied secrets.json is
 *   useless elsewhere. Export bundles never include it.
 * - Without OS encryption (a Linux desktop with no keyring) the key is held in memory for
 *   this run only, never written in plain text.
 *
 * @对应文档章节:docs/软件定义书.md ADR-025
 *
 * @不要在这里做的事:
 * - 不要把明文 key 写进日志、settings 或任何发给 renderer 的消息
 */
import type { JsonStore } from './persistence';
import { logger } from './logger';

export interface SecretsFile {
  version: 1;
  /** base64 of the encrypted OpenRouter key for next prompt suggestions */
  nextPromptKey?: string;
}

/** The parts of Electron's safeStorage this store needs, so tests can pass a fake. */
export interface Encryption {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(cipher: Buffer): string;
}

export class SecretStore {
  private file: SecretsFile = { version: 1 };
  /** Used only when the OS offers no encryption; lost at exit on purpose. */
  private memoryOnlyKey: string | null = null;

  constructor(
    private readonly store: JsonStore<SecretsFile>,
    private readonly encryption: Encryption,
  ) {}

  async initialize(): Promise<void> {
    const { value } = await this.store.load({ version: 1 });
    this.file = { ...value, version: 1 };
  }

  hasNextPromptKey(): boolean {
    return this.getNextPromptKey() !== '';
  }

  /** The plain key, or '' when none is saved or it cannot be decrypted on this PC. */
  getNextPromptKey(): string {
    if (this.memoryOnlyKey !== null) return this.memoryOnlyKey;
    const blob = this.file.nextPromptKey;
    if (!blob || !this.encryption.isEncryptionAvailable()) return '';
    try {
      return this.encryption.decryptString(Buffer.from(blob, 'base64'));
    } catch (err) {
      // Usually a secrets.json copied from another PC or Windows user.
      logger.warn('SecretStore', 'saved next prompt key cannot be decrypted; connect again', err);
      return '';
    }
  }

  /** @param key '' forgets the key */
  setNextPromptKey(key: string): void {
    const trimmed = key.trim();
    this.memoryOnlyKey = null;
    if (!trimmed) {
      delete this.file.nextPromptKey;
    } else if (this.encryption.isEncryptionAvailable()) {
      this.file.nextPromptKey = this.encryption.encryptString(trimmed).toString('base64');
    } else {
      logger.warn(
        'SecretStore',
        'OS encryption is unavailable (on Linux: no keyring); the key lasts until Ceteris quits',
      );
      this.memoryOnlyKey = trimmed;
      delete this.file.nextPromptKey;
    }
    this.store.set({ ...this.file });
  }

  flush(): Promise<void> {
    return this.store.flush();
  }
}
