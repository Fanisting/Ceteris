/**
 * @file src/main/build-type.test.ts
 * @purpose getBuildType() 三态分支。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return mockIsPackaged;
    },
  },
}));

let mockIsPackaged = false;
let origPortable: string | undefined;

import {
  __resetBuildTypeCacheForTest,
  getAppLabel,
  getChannel,
  getRelaunchOptions,
  getBuildType,
  isBetaBuild,
} from './build-type';

const realExecPath = process.execPath;
function setExecPath(path: string): void {
  Object.defineProperty(process, 'execPath', { value: path, configurable: true });
}

describe('beta isolation', () => {
  afterEach(() => {
    __resetBuildTypeCacheForTest();
    setExecPath(realExecPath);
    delete process.env['PORTABLE_EXECUTABLE_DIR'];
  });

  it('a directly launched CeterisBeta.exe is never treated as installed', () => {
    mockIsPackaged = true;
    delete process.env['PORTABLE_EXECUTABLE_DIR'];
    setExecPath('C:\\tmp\\win-unpacked\\CeterisBeta.exe');
    expect(isBetaBuild()).toBe(true);
    expect(getBuildType()).toBe('portable');
    expect(getAppLabel()).toBe('Ceteris Beta');
    expect(getChannel()).toBe('beta');
  });

  it('an installed build restarts itself', () => {
    delete process.env['PORTABLE_EXECUTABLE_FILE'];
    expect(getRelaunchOptions()).toEqual({});
  });

  it('a portable build restarts through the exe the user launched', () => {
    process.env['PORTABLE_EXECUTABLE_FILE'] = 'C:\\tools\\CeterisBeta-1.0.0.exe';
    expect(getRelaunchOptions()).toEqual({
      execPath: 'C:\\tools\\CeterisBeta-1.0.0.exe',
      args: process.argv.slice(1),
    });
    delete process.env['PORTABLE_EXECUTABLE_FILE'];
  });

  it('npm run dev is its own channel', () => {
    mockIsPackaged = false;
    expect(getChannel()).toBe('dev');
    expect(getAppLabel()).toBe('Ceteris (dev)');
  });

  it('the installed Ceteris.exe is not a beta', () => {
    mockIsPackaged = true;
    delete process.env['PORTABLE_EXECUTABLE_DIR'];
    setExecPath('C:\\Users\\me\\AppData\\Local\\Programs\\Ceteris\\Ceteris.exe');
    expect(isBetaBuild()).toBe(false);
    expect(getBuildType()).toBe('installed');
    expect(getAppLabel()).toBe('Ceteris');
    expect(getChannel()).toBe('stable');
  });

  it('an unpackaged run is not a beta even with that exe name', () => {
    mockIsPackaged = false;
    setExecPath('C:\\tmp\\CeterisBeta.exe');
    expect(isBetaBuild()).toBe(false);
  });
});

describe('getBuildType', () => {
  afterEach(() => {
    __resetBuildTypeCacheForTest();
    if (origPortable === undefined) {
      delete process.env['PORTABLE_EXECUTABLE_DIR'];
    } else {
      process.env['PORTABLE_EXECUTABLE_DIR'] = origPortable;
    }
    origPortable = undefined;
  });

  it('!isPackaged → dev', () => {
    mockIsPackaged = false;
    expect(getBuildType()).toBe('dev');
  });

  it('isPackaged + PORTABLE_EXECUTABLE_DIR → portable', () => {
    mockIsPackaged = true;
    origPortable = process.env['PORTABLE_EXECUTABLE_DIR'];
    process.env['PORTABLE_EXECUTABLE_DIR'] = 'C:\\Users\\me\\Downloads';
    expect(getBuildType()).toBe('portable');
  });

  it('isPackaged + no PORTABLE_EXECUTABLE_DIR → installed', () => {
    mockIsPackaged = true;
    origPortable = process.env['PORTABLE_EXECUTABLE_DIR'];
    delete process.env['PORTABLE_EXECUTABLE_DIR'];
    expect(getBuildType()).toBe('installed');
  });

  it('结果被缓存', () => {
    mockIsPackaged = false;
    const first = getBuildType();
    mockIsPackaged = true;
    expect(getBuildType()).toBe(first);
  });
});
