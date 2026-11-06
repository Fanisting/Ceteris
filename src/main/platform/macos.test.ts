import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MacOSAdapter, parseLoginPath, parseLsofCwd } from './macos';

describe('parseLoginPath', () => {
  it('ignores anything a shell profile printed first', () => {
    expect(parseLoginPath('Welcome!\n__CETERIS_PATH__/opt/homebrew/bin:/usr/bin\n')).toBe(
      '/opt/homebrew/bin:/usr/bin',
    );
  });

  it('gives null when the marker never appeared', () => {
    expect(parseLoginPath('zsh: command not found\n')).toBeNull();
  });
});

describe('parseLsofCwd', () => {
  it('reads the folder from field output', () => {
    expect(parseLsofCwd('p123\nfcwd\nn/Users/me/repo\n')).toBe('/Users/me/repo');
  });

  it('gives null when lsof found nothing', () => {
    expect(parseLsofCwd('p123\n')).toBeNull();
  });
});

describe('MacOSAdapter zsh launch', () => {
  const folders: string[] = [];
  afterEach(() => {
    for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
  });

  it('puts the hook where zsh looks for it', () => {
    const source = mkdtempSync(join(tmpdir(), 'ceteris-hook-'));
    folders.push(source);
    const hook = join(source, 'zsh.sh');
    writeFileSync(hook, '# hook');

    const { args, env } = new MacOSAdapter().buildShellLaunchParams(
      { id: 'zsh', displayName: 'Zsh', executablePath: '/bin/zsh' },
      hook,
    );
    const dir = env['ZDOTDIR'] as string;
    folders.push(dir);

    expect(args).toEqual(['-i']);
    expect(existsSync(join(dir, '.zshrc'))).toBe(true);
    expect(readFileSync(join(dir, '.zshrc'), 'utf8')).toBe('# hook');
    expect(dirname(hook)).not.toBe(dir);
  });
});
