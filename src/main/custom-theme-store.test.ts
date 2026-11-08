/**
 * @file custom-theme-store.test.ts
 * @purpose The themes folder (ADR-026): template on first use, unique names on create,
 *   and _ files left out of the list. Uses a temp folder, never the real data folder.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CustomThemeStore } from './custom-theme-store';
import { CETERIS_DARK_TEMPLATE, TEMPLATE_FILE_NAME } from '@shared/custom-themes';

let dir: string | null = null;
let store: CustomThemeStore | null = null;

afterEach(async () => {
  store?.stop();
  if (dir) await fs.rm(dir, { recursive: true, force: true });
});

describe('CustomThemeStore', () => {
  it('writes the template, creates themes under free names and lists only themes', async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'ceteris-themes-'));
    store = new CustomThemeStore(join(dir, 'themes'), () => {});
    await store.start();
    await expect(fs.stat(join(dir, 'themes', TEMPLATE_FILE_NAME))).resolves.toBeTruthy();
    expect(await store.list()).toEqual([]);

    const a = await store.create({ ...CETERIS_DARK_TEMPLATE, name: 'Night Owl' });
    const b = await store.create({ ...CETERIS_DARK_TEMPLATE, name: 'Night Owl' });
    expect([a.id, b.id]).toEqual(['custom:night-owl', 'custom:night-owl-2']);
    expect((await store.list()).map((t) => t.id)).toEqual([
      'custom:night-owl',
      'custom:night-owl-2',
    ]);
    expect(store.pathOf('custom:night-owl-2')).toBe(join(dir, 'themes', 'night-owl-2.css'));
  });
});
