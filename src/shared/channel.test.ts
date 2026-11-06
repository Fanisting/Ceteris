/**
 * @file src/shared/channel.test.ts
 * @purpose 守护 stable / beta / dev 的隔离:任何两个 channel 共用一个值,就可能互相干扰。
 */
import { describe, expect, it } from 'vitest';
import { LINK_DEFAULT_PORT } from './link-protocol';
import { CHANNELS } from './channel';

const profiles = Object.values(CHANNELS);

describe('CHANNELS', () => {
  it.each(['label', 'tmuxSocket', 'linkPort'] as const)('每个 channel 的 %s 都不同', (key) => {
    expect(new Set(profiles.map((p) => p[key])).size).toBe(profiles.length);
  });

  it('stable 保持原有默认值,已有的远端 session 和配置不受影响', () => {
    expect(CHANNELS.stable.tmuxSocket).toBe('ceteris');
    expect(CHANNELS.stable.linkPort).toBe(LINK_DEFAULT_PORT);
  });

  it('tmux socket 能安全地放进远端 shell', () => {
    for (const { tmuxSocket } of profiles) expect(tmuxSocket).toMatch(/^[a-z0-9-]+$/);
  });

  it('端口都在设置页允许的范围内', () => {
    for (const { linkPort } of profiles) {
      expect(linkPort).toBeGreaterThanOrEqual(1024);
      expect(linkPort).toBeLessThanOrEqual(65535);
    }
  });
});
