/**
 * @file src/main/template-usage.test.ts
 * @purpose TemplateUsageTracker round trip through a real JsonStore in a temp dir, and recovery
 *   from a damaged file.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { JsonStore, createTempDataDir, removeTempDataDir } from './persistence';
import { TemplateUsageTracker } from './template-usage';
import type { TemplateUsageFile } from '@shared/template-usage';

describe('TemplateUsageTracker', () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await createTempDataDir();
    file = join(dir, 'template-usage.json');
  });

  afterEach(async () => {
    await removeTempDataDir(dir);
  });

  it('starts empty when there is no file', async () => {
    const tracker = new TemplateUsageTracker(new JsonStore<TemplateUsageFile>(file, 0));
    await tracker.initialize();
    expect(tracker.list()).toEqual([]);
  });

  it('counts launches and reads them back after a restart', async () => {
    const tracker = new TemplateUsageTracker(new JsonStore<TemplateUsageFile>(file, 0));
    await tracker.initialize();
    tracker.record('claude-code', 100);
    tracker.record('shell:pwsh', 200);
    tracker.record('claude-code', 300);
    await tracker.flush();

    const again = new TemplateUsageTracker(new JsonStore<TemplateUsageFile>(file, 0));
    await again.initialize();
    expect(again.list()).toEqual([
      { key: 'shell:pwsh', count: 1, lastUsedAt: 200 },
      { key: 'claude-code', count: 2, lastUsedAt: 300 },
    ]);
  });

  it('returns copies, so callers cannot change the stored entries', async () => {
    const tracker = new TemplateUsageTracker(new JsonStore<TemplateUsageFile>(file, 0));
    await tracker.initialize();
    tracker.record('codex', 1);
    const list = tracker.list();
    list[0]!.count = 99;
    expect(tracker.list()[0]!.count).toBe(1);
  });

  it('ignores damaged entries in the file instead of throwing', async () => {
    await fs.writeFile(
      file,
      JSON.stringify({
        version: 1,
        entries: [
          { key: 'codex', count: 'lots', lastUsedAt: 1 },
          { key: 'aider', count: 4, lastUsedAt: 2 },
        ],
      }),
    );
    const tracker = new TemplateUsageTracker(new JsonStore<TemplateUsageFile>(file, 0));
    await tracker.initialize();
    expect(tracker.list()).toEqual([{ key: 'aider', count: 4, lastUsedAt: 2 }]);
  });

  it('starts empty when the file is not JSON', async () => {
    await fs.writeFile(file, '{not json');
    const tracker = new TemplateUsageTracker(new JsonStore<TemplateUsageFile>(file, 0));
    await tracker.initialize();
    expect(tracker.list()).toEqual([]);
  });
});
