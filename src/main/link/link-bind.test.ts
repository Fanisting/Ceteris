/**
 * @file src/main/link/link-bind.test.ts
 * @purpose 验证 Host 绑定地址的决策逻辑。无人值守的机器重启后要靠它恢复远程访问:
 *   Ceteris 往往先于 Tailscale 启动,此时只能绑 127.0.0.1,之后必须自己换到 tailnet
 *   地址,并且绝不能退回 0.0.0.0。
 *
 * @对应文档章节: docs/远程访问指南.md 第 7 章
 */
import type * as NodeOs from 'node:os';
import type { NetworkInterfaceInfo } from 'node:os';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const interfaces = vi.hoisted(() => ({
  current: {} as Record<string, Array<Partial<NetworkInterfaceInfo>>>,
}));

vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof NodeOs>()),
  networkInterfaces: () => interfaces.current,
}));
vi.mock('electron', () => ({ app: { getVersion: () => '0.0.0-test' } }));
vi.mock('../ipc', () => ({ setLinkCommandForwarder: vi.fn(), dispatchLocalCommand: vi.fn() }));
vi.mock('../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { needsRebind, resolveBindAddress } = await import('./link-manager');

const lan = { address: '192.168.1.20', family: 'IPv4', internal: false };
const tailscale = { address: '100.64.0.2', family: 'IPv4', internal: false };
const loopback = { address: '127.0.0.1', family: 'IPv4', internal: true };

beforeEach(() => {
  interfaces.current = {};
});

describe('resolveBindAddress', () => {
  it('auto 优先选 Tailscale 地址', () => {
    interfaces.current = { Ethernet: [lan as never], Tailscale: [tailscale as never] };
    expect(resolveBindAddress('auto')).toBe('100.64.0.2');
  });

  it('没有 Tailscale 时退回 127.0.0.1,不暴露到局域网', () => {
    interfaces.current = { Ethernet: [lan as never], lo: [loopback as never] };
    expect(resolveBindAddress('auto')).toBe('127.0.0.1');
  });

  it.each(['100.63.255.255', '100.128.0.1'])('%s 不在 CGNAT 段内,不当作 Tailscale', (address) => {
    interfaces.current = { Other: [{ ...lan, address } as never] };
    expect(resolveBindAddress('auto')).toBe('127.0.0.1');
  });

  it('用户明确填写的地址原样使用', () => {
    interfaces.current = { Tailscale: [tailscale as never] };
    expect(resolveBindAddress('192.168.1.20')).toBe('192.168.1.20');
  });
});

describe('needsRebind', () => {
  it('Ceteris 先于 Tailscale 启动:地址出现后需要重新绑定', () => {
    expect(needsRebind({ listening: true, boundAddress: '127.0.0.1' }, '100.64.0.2')).toBe(true);
  });

  it('Tailscale 地址变化时需要重新绑定', () => {
    expect(needsRebind({ listening: true, boundAddress: '100.64.0.2' }, '100.64.0.9')).toBe(true);
  });

  it('监听失败后需要重试', () => {
    expect(needsRebind({ listening: false, boundAddress: '' }, '100.64.0.2')).toBe(true);
  });

  it('地址一致时不动,已连接的客户端不受打扰', () => {
    expect(needsRebind({ listening: true, boundAddress: '100.64.0.2' }, '100.64.0.2')).toBe(false);
  });
});
