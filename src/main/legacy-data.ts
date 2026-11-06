/**
 * @file src/main/legacy-data.ts
 * @purpose Carries data from the old Marina data folder into the Ceteris one, once.
 *
 * @关键设计:
 * - Copy, never move. The old folder is only read, so Marina can still be started and the
 *   user can go back. Nothing here deletes or edits anything in it.
 * - An allowlist, not a folder copy. Marina may be running, and its folder also holds
 *   caches and logs that can run to gigabytes.
 * - Local State has to come along. It holds the key that safeStorage encrypts with, so
 *   without it every saved SSH password fails to decrypt even though the profile copied.
 *   Electron keeps it under session-data here because index.ts moves sessionData.
 * - Synchronous, in bootstrap. Chromium reads Local State only after the main script has
 *   run, so this is early enough and no restart is needed. Measured on the built app: a
 *   secret encrypted in one profile decrypts in a profile migrated during startup.
 *   It also has to finish before any JsonStore loads.
 * - It runs only while the new folder holds no data, so it cannot overwrite anything.
 *
 * @对应文档章节: 软件定义书.md ADR-014
 *
 * @不要在这里做的事:
 * - 不要写入、改名或删除 `from` 目录里的任何文件
 * - 不要把缓存加进清单:它们可以重建,而且可能很大
 * - No electron imports, so this can be tested against temp folders.
 */
import { cpSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/** The stores that make a data folder count as in use. Each has a .bak beside it. */
const STORE_FILES = [
  'bookmarks.json',
  'recent.json',
  'ssh-profiles.json',
  'known-hosts-history.json',
  'templates.json',
  'settings.json',
] as const;

/** Copied after the stores. Paths are relative to the data folder. */
const BROWSER_ITEMS = [
  'Local State',
  join('session-data', 'Local State'),
  join('session-data', 'Local Storage'),
] as const;

export interface LegacyCopyResult {
  /** Why nothing was copied, or null when a copy ran. */
  skipped: 'no-legacy-data' | 'already-has-data' | null;
  copied: string[];
  failed: Array<{ item: string; error: string }>;
}

/**
 * The data folder name the same build used under the old name, or null when the name
 * did not change. 'Ceteris (dev)' gives 'Marina (dev)', and so on for each build type.
 */
export function legacyAppName(appName: string): string | null {
  return appName.startsWith('Ceteris') ? appName.replace('Ceteris', 'Marina') : null;
}

/**
 * Copies the old data into the new folder, if the old one exists and the new one is unused.
 *
 * @param from the old data folder, never written to
 * @param to the new data folder
 * @returns what was copied. One item failing does not stop the rest: a file Marina holds
 *   open should cost that one item, not the whole migration.
 *
 * @常见问题排查:
 * - SSH 密码解密失败但 profile 还在 → failed 里应该有 Local State,看 main.log
 * - 复制了但设置没变 → 新目录已有数据时这里会跳过,skipped 是 already-has-data
 */
export function copyLegacyData(from: string, to: string): LegacyCopyResult {
  const result: LegacyCopyResult = { skipped: null, copied: [], failed: [] };
  if (!STORE_FILES.some((file) => existsSync(join(from, file)))) {
    return { ...result, skipped: 'no-legacy-data' };
  }
  if (STORE_FILES.some((file) => existsSync(join(to, file)))) {
    return { ...result, skipped: 'already-has-data' };
  }

  const stores = STORE_FILES.flatMap((file) => [file, `${file}.bak`]);
  for (const item of [...stores, ...BROWSER_ITEMS]) {
    const source = join(from, item);
    if (!existsSync(source)) continue;
    try {
      // force: false keeps the promise above even if something appeared in the meantime.
      cpSync(source, join(to, item), { recursive: true, force: false, errorOnExist: false });
      result.copied.push(item);
    } catch (err) {
      result.failed.push({ item, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}
