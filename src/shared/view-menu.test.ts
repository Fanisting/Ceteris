/**
 * @file src/shared/view-menu.test.ts
 * @purpose 守护标题栏徽标的规则:没有配置时也能点开,Tailscale 和 SSH 都能选,远端视图里
 *   不提供会在错误机器上执行的操作。
 */
import { describe, expect, it } from 'vitest';
import { VIEW_TARGET_LOCAL } from './protocol';
import type { LinkHostEntry } from './types';
import { buildViewMenu, liveClient, viewBadgeLabel, type ViewMenuInput } from './view-menu';

const LOCAL = { id: VIEW_TARGET_LOCAL, label: 'Local', active: true };
const host: LinkHostEntry = {
  id: 'h1',
  label: 'Laptop',
  host: '100.1.2.3',
  port: 38787,
  token: 't',
  autoConnect: false,
};
const server = { id: 'p1', name: 'lab' };

function input(over: Partial<ViewMenuInput> = {}): ViewMenuInput {
  return {
    targets: [LOCAL],
    segment: 'local',
    selectedSshProfileId: null,
    savedHosts: [],
    linkClients: [],
    sshProfiles: [],
    ...over,
  };
}

const kinds = (over?: Partial<ViewMenuInput>): string[] =>
  buildViewMenu(input(over)).map((e) => e.kind);

describe('buildViewMenu', () => {
  it('什么都没配置时也能打开,并提供添加入口', () => {
    expect(kinds()).toEqual(['view', 'divider', 'add-link', 'add-ssh', 'setup-guide']);
  });

  it('主进程还没报告状态时按本地窗口处理', () => {
    expect(buildViewMenu(input({ targets: [] }))[0]).toMatchObject({
      id: VIEW_TARGET_LOCAL,
      active: true,
    });
  });

  it('Tailscale 和 SSH 都列出来', () => {
    expect(kinds({ savedHosts: [host], sshProfiles: [server] })).toEqual([
      'view',
      'divider',
      'link',
      'ssh',
      'divider',
      'add-link',
      'add-ssh',
      'setup-guide',
    ]);
  });

  it('已连接的 Host 只作为视图出现一次', () => {
    const entries = buildViewMenu(
      input({
        targets: [LOCAL, { id: 'w2', label: 'Laptop', active: false }],
        savedHosts: [host],
        linkClients: [{ address: '100.1.2.3:38787', state: 'connected' }],
      }),
    );
    expect(entries.filter((e) => e.kind === 'link')).toEqual([]);
    expect(entries.filter((e) => e.kind === 'view')).toHaveLength(2);
  });

  it('正在连接的 Host 不能重复点击', () => {
    const [link] = buildViewMenu(
      input({
        savedHosts: [host],
        linkClients: [{ address: '100.1.2.3:38787', state: 'reconnecting' }],
      }),
    ).filter((e) => e.kind === 'link');
    expect(link).toMatchObject({ connecting: true });
  });

  it('已关闭的连接可以重试', () => {
    const [link] = buildViewMenu(
      input({
        savedHosts: [host],
        linkClients: [{ address: '100.1.2.3:38787', state: 'closed' }],
      }),
    ).filter((e) => e.kind === 'link');
    expect(link).toMatchObject({ connecting: false });
  });

  it('重试时以新连接为准,不被旧的已关闭连接干扰', () => {
    const clients = [
      { address: 'a:1', state: 'closed', lastError: 'old failure' },
      { address: 'a:1', state: 'connecting', lastError: '' },
    ];
    expect(liveClient(clients, 'a:1')).toBe(clients[1]);
  });

  it('同一地址不同端口是另一台 Host', () => {
    const [link] = buildViewMenu(
      input({
        savedHosts: [host],
        linkClients: [{ address: '100.1.2.3:38788', state: 'connected' }],
      }),
    ).filter((e) => e.kind === 'link');
    expect(link).toMatchObject({ connecting: false });
  });

  it('远端视图里只切换视图,不提供 Host 上的配置', () => {
    const over = {
      targets: [
        { ...LOCAL, active: false },
        { id: 'w2', label: 'Laptop', active: true },
      ],
      savedHosts: [host],
      sshProfiles: [server],
    };
    expect(kinds(over)).toEqual(['view', 'view']);
  });

  it('本地文件夹时勾选 Local', () => {
    expect(buildViewMenu(input({ sshProfiles: [server] }))[0]).toMatchObject({ active: true });
  });

  it('SSH 服务器上时勾选服务器,不勾选 Local', () => {
    const entries = buildViewMenu(
      input({ segment: 'remote', selectedSshProfileId: 'p1', sshProfiles: [server] }),
    );
    expect(entries[0]).toMatchObject({ kind: 'view', active: false });
    expect(entries.find((e) => e.kind === 'ssh')).toMatchObject({ active: true });
  });

  it('切回本地标签后不再勾选服务器', () => {
    const entries = buildViewMenu(input({ selectedSshProfileId: 'p1', sshProfiles: [server] }));
    expect(entries.find((e) => e.kind === 'ssh')).toMatchObject({ active: false });
  });
});

describe('viewBadgeLabel', () => {
  it('本地', () => {
    expect(viewBadgeLabel(input())).toBe('Local');
  });

  it('远端视图显示 Host 名', () => {
    expect(
      viewBadgeLabel(
        input({
          targets: [
            { ...LOCAL, active: false },
            { id: 'w2', label: 'Laptop', active: true },
          ],
        }),
      ),
    ).toBe('Laptop');
  });

  it('SSH 服务器上显示服务器名', () => {
    expect(
      viewBadgeLabel(
        input({ segment: 'remote', selectedSshProfileId: 'p1', sshProfiles: [server] }),
      ),
    ).toBe('lab');
  });

  it('远程标签但没选服务器时显示 SSH', () => {
    expect(viewBadgeLabel(input({ segment: 'remote', sshProfiles: [server] }))).toBe('SSH');
  });
});
