/**
 * @file src/main/update-checker.test.ts
 * @purpose Scheduling side rules of UpdateChecker and install detection. Version and asset
 *   rules are tested in src/shared/update-check.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { UpdateChecker, detectInstallTarget, type FetchResult } from './update-checker';

const RELEASE = {
  tag_name: 'v0.4.0',
  html_url: 'https://github.com/Fanisting/ceteris/releases/tag/v0.4.0',
  assets: [
    {
      name: 'Ceteris-Setup-0.4.0-x64.exe',
      browser_download_url: 'https://github.com/dl/Ceteris-Setup-0.4.0-x64.exe',
    },
  ],
};

function checker(responses: Array<FetchResult | Error>): UpdateChecker {
  return new UpdateChecker({
    currentVersion: '0.3.0',
    target: { platform: 'win32', arch: 'x64', portable: false, linuxPackage: null },
    fetchLatest: async () => {
      const next = responses.shift();
      if (!next || next instanceof Error) throw next ?? new Error('no response');
      return next;
    },
    isAutoCheckEnabled: () => false,
    onStatus: () => {},
  });
}

describe('UpdateChecker', () => {
  it('finds a newer release and links the direct download', async () => {
    const status = await checker([{ status: 200, json: RELEASE }]).checkNow('manual');
    expect(status.update?.downloadUrl).toBe(RELEASE.assets[0]!.browser_download_url);
  });

  it('keeps a found update when a later check is rate limited', async () => {
    const c = checker([
      { status: 200, json: RELEASE },
      { status: 403, json: null },
    ]);
    await c.checkNow('manual');
    const status = await c.checkNow('interval');
    expect(status).toMatchObject({ state: 'available', error: 'rate-limited' });
  });
});

describe('detectInstallTarget', () => {
  it('treats a Linux install on the Debian family as deb', () => {
    const t = detectInstallTarget('linux', 'x64', {}, (p) => p === '/etc/debian_version');
    expect(t.linuxPackage).toBe('deb');
  });
});
