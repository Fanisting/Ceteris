/**
 * @file src/shared/update-check.test.ts
 * @purpose One test per rule of the update check: version order, release parsing, and the
 *   download picked for each kind of install.
 */
import { describe, expect, it } from 'vitest';
import {
  compareVersions,
  evaluateRelease,
  parseRelease,
  selectAsset,
  type InstallTarget,
  type ReleaseAsset,
} from './update-check';

/** The files v0.3.0 shipped, plus the two electron-builder.yml can also produce. */
const ASSETS: ReleaseAsset[] = [
  'Ceteris-Setup-0.4.0-x64.exe',
  'Ceteris-Portable-0.4.0-x64.exe',
  'Ceteris-0.4.0-arm64.dmg',
  'Ceteris-0.4.0-x64.dmg',
  'Ceteris-0.4.0-x86_64.AppImage',
  'Ceteris-0.4.0-amd64.deb',
  'Ceteris-0.4.0-x86_64.rpm',
].map((name) => ({ name, url: `https://github.com/dl/${name}`, size: 1 }));

function target(partial: Partial<InstallTarget>): InstallTarget {
  return { platform: 'win32', arch: 'x64', portable: false, linuxPackage: null, ...partial };
}

const RELEASE_JSON = {
  tag_name: 'v0.4.0',
  name: 'Ceteris 0.4.0',
  html_url: 'https://github.com/Fanisting/ceteris/releases/tag/v0.4.0',
  published_at: '2026-11-08T00:00:00Z',
  draft: false,
  prerelease: false,
  assets: ASSETS.map((a) => ({ name: a.name, browser_download_url: a.url, size: 1 })),
};

describe('compareVersions', () => {
  it('orders by number, not by text', () => {
    expect(compareVersions('0.10.0', '0.9.9')).toBeGreaterThan(0);
  });

  it('ignores a leading v', () => {
    expect(compareVersions('v0.3.0', '0.3.0')).toBe(0);
  });

  it('puts a prerelease before its release', () => {
    expect(compareVersions('1.0.0-beta.1', '1.0.0')).toBeLessThan(0);
  });

  it('refuses a tag that is not a version', () => {
    expect(() => compareVersions('nightly', '0.3.0')).toThrow(/Cannot compare/);
  });
});

describe('parseRelease', () => {
  it('reads tag, page and direct download links', () => {
    const release = parseRelease(RELEASE_JSON);
    expect(release).toMatchObject({ version: '0.4.0', htmlUrl: RELEASE_JSON.html_url });
    expect(release?.assets).toHaveLength(ASSETS.length);
  });

  it('skips drafts and prereleases', () => {
    expect(parseRelease({ ...RELEASE_JSON, prerelease: true })).toBeNull();
  });

  it('drops asset links that are not https', () => {
    const json = {
      ...RELEASE_JSON,
      assets: [{ name: 'x.exe', browser_download_url: 'file:///x.exe' }],
    };
    expect(parseRelease(json)?.assets).toEqual([]);
  });
});

describe('selectAsset', () => {
  it('gives Windows the Setup exe', () => {
    expect(selectAsset(ASSETS, target({}))?.name).toBe('Ceteris-Setup-0.4.0-x64.exe');
  });

  it('gives a portable Windows build the Portable exe', () => {
    expect(selectAsset(ASSETS, target({ portable: true }))?.name).toBe(
      'Ceteris-Portable-0.4.0-x64.exe',
    );
  });

  it('gives an Apple silicon Mac the arm64 dmg', () => {
    expect(selectAsset(ASSETS, target({ platform: 'darwin', arch: 'arm64' }))?.name).toBe(
      'Ceteris-0.4.0-arm64.dmg',
    );
  });

  it('gives a Debian family Linux the deb', () => {
    expect(selectAsset(ASSETS, target({ platform: 'linux', linuxPackage: 'deb' }))?.name).toBe(
      'Ceteris-0.4.0-amd64.deb',
    );
  });

  it('falls back to the AppImage on Linux when the preferred package is missing', () => {
    const noRpm = ASSETS.filter((a) => !a.name.endsWith('.rpm'));
    expect(selectAsset(noRpm, target({ platform: 'linux', linuxPackage: 'rpm' }))?.name).toBe(
      'Ceteris-0.4.0-x86_64.AppImage',
    );
  });
});

describe('evaluateRelease', () => {
  const release = parseRelease(RELEASE_JSON)!;

  it('reports nothing when the app is already on that version', () => {
    expect(evaluateRelease('0.4.0', release, target({}))).toBeNull();
  });

  it('links the release page when no file fits this computer', () => {
    const update = evaluateRelease('0.3.0', release, target({ platform: 'darwin', arch: 'other' }));
    expect(update).toMatchObject({ downloadUrl: RELEASE_JSON.html_url, assetName: null });
  });
});
