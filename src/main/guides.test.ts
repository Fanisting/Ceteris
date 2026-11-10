/**
 * @file src/main/guides.test.ts
 * @purpose 守护指南文件的位置 (ADR-032):安装版在 resources/guides,dev 在仓库的 guides/,
 *   并且两份远程设置指南真的在仓库里 (打包时 extraResources 原样带走)。
 */
import { existsSync } from 'fs';
import { join, resolve } from 'path';
import { describe, expect, it } from 'vitest';
import { bundledGuidesDir, remoteSetupGuidePaths } from './guides';

const where = { resourcesPath: join('C:', 'App', 'resources'), appPath: join('D:', 'repo') };

describe('bundledGuidesDir', () => {
  it('安装版用 resources/guides,dev 用仓库的 guides', () => {
    expect(bundledGuidesDir({ ...where, isPackaged: true })).toBe(
      join('C:', 'App', 'resources', 'guides'),
    );
    expect(bundledGuidesDir({ ...where, isPackaged: false })).toBe(join('D:', 'repo', 'guides'));
  });
});

describe('remoteSetupGuidePaths', () => {
  it('两个角色各指向目录下的一个文件', () => {
    const paths = remoteSetupGuidePaths({ ...where, isPackaged: true });
    expect(paths.host).toBe(join('C:', 'App', 'resources', 'guides', 'remote-setup-host.md'));
    expect(paths.client).toBe(join('C:', 'App', 'resources', 'guides', 'remote-setup-client.md'));
  });

  it('仓库里真的有这两份指南', () => {
    const repoRoot = resolve(__dirname, '..', '..');
    const paths = remoteSetupGuidePaths({
      isPackaged: false,
      resourcesPath: '',
      appPath: repoRoot,
    });
    expect(existsSync(paths.host)).toBe(true);
    expect(existsSync(paths.client)).toBe(true);
  });
});
