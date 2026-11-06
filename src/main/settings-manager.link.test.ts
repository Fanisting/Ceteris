/**
 * @file src/main/settings-manager.link.test.ts
 * @purpose 校验 Ceteris Link 设置的 schema 规则。
 *
 * @为什么单独一个文件:
 * settings-manager.test.ts 已经很长,而 link 段的校验有一条特别容易被后人
 * 无意破坏的不变式("开启 Host 就必须有 token"),值得单独立一组用例说清
 * 它为什么存在。
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, validateSettings, SettingsError } from './settings-manager';
import type { Settings } from '@shared/types';

/** 基于默认设置造一个 link 段被覆盖过的 Settings。 */
function withLink(partial: Partial<Settings['link']>): Settings {
  return {
    ...structuredClone(DEFAULT_SETTINGS),
    link: { ...structuredClone(DEFAULT_SETTINGS.link), ...partial },
  };
}

describe('Link 设置默认值', () => {
  it('默认全关,token 为空', () => {
    expect(DEFAULT_SETTINGS.link.hostEnabled).toBe(false);
    expect(DEFAULT_SETTINGS.link.hostToken).toBe('');
    expect(DEFAULT_SETTINGS.link.savedHosts).toEqual([]);
  });

  it('默认绑定地址是 auto,而不是 0.0.0.0', () => {
    // 这条断言锁定一个安全默认:auto 在找不到 Tailscale 时退回 127.0.0.1
    // (谁都连不上),而不是把终端服务暴露到整个局域网。
    expect(DEFAULT_SETTINGS.link.hostBindAddress).toBe('auto');
  });

  it('默认设置本身通过校验', () => {
    expect(() => validateSettings(structuredClone(DEFAULT_SETTINGS))).not.toThrow();
  });
});

describe('hostEnabled 与 hostToken 的不变式', () => {
  it('开启 Host 但 token 为空 → 拒绝', () => {
    // 没有 token 时密钥派生会抛错,任何客户端都连不上。这是配置错误,
    // 不是"更开放的模式",必须在写入前拦下 —— 否则用户会看到一个"已开启"
    // 的开关配上永远失败的连接,极难自查。
    expect(() => validateSettings(withLink({ hostEnabled: true, hostToken: '' }))).toThrow(
      SettingsError,
    );
  });

  it('开启 Host 且有 token → 通过', () => {
    expect(() =>
      validateSettings(withLink({ hostEnabled: true, hostToken: 'a'.repeat(43) })),
    ).not.toThrow();
  });

  it('关闭 Host 时 token 为空是允许的', () => {
    expect(() => validateSettings(withLink({ hostEnabled: false, hostToken: '' }))).not.toThrow();
  });
});

describe('端口范围', () => {
  it('1024 以下被拒(部分系统需要管理员权限)', () => {
    expect(() => validateSettings(withLink({ hostPort: 80 }))).toThrow(SettingsError);
    expect(() => validateSettings(withLink({ hostPort: 1023 }))).toThrow(SettingsError);
  });

  it('65535 以上被拒', () => {
    expect(() => validateSettings(withLink({ hostPort: 65536 }))).toThrow(SettingsError);
  });

  it('边界值 1024 与 65535 被接受', () => {
    expect(() => validateSettings(withLink({ hostPort: 1024 }))).not.toThrow();
    expect(() => validateSettings(withLink({ hostPort: 65535 }))).not.toThrow();
  });

  it('非数字被拒', () => {
    expect(() => validateSettings(withLink({ hostPort: Number.NaN }))).toThrow(SettingsError);
  });
});

describe('savedHosts 校验', () => {
  const validEntry = {
    id: 'link-1',
    label: '家里台式机',
    host: '100.64.0.2',
    port: 8787,
    token: 'x'.repeat(43),
    autoConnect: false,
  };

  it('合法条目通过', () => {
    expect(() => validateSettings(withLink({ savedHosts: [validEntry] }))).not.toThrow();
  });

  it('非数组被拒', () => {
    expect(() =>
      validateSettings(
        withLink({ savedHosts: 'nope' as unknown as Settings['link']['savedHosts'] }),
      ),
    ).toThrow(SettingsError);
  });

  it('缺 id 被拒', () => {
    expect(() => validateSettings(withLink({ savedHosts: [{ ...validEntry, id: '' }] }))).toThrow(
      SettingsError,
    );
  });

  it('缺 host 被拒', () => {
    expect(() => validateSettings(withLink({ savedHosts: [{ ...validEntry, host: '' }] }))).toThrow(
      SettingsError,
    );
  });

  it('端口越界被拒', () => {
    expect(() => validateSettings(withLink({ savedHosts: [{ ...validEntry, port: 22 }] }))).toThrow(
      SettingsError,
    );
  });

  it('多个条目逐个校验,坏的那个被指出', () => {
    expect(() =>
      validateSettings(
        withLink({ savedHosts: [validEntry, { ...validEntry, id: 'link-2', host: '' }] }),
      ),
    ).toThrow(/savedHosts\[1\]/);
  });

  it('token 为空是允许的(导入的归档会被剥掉 token)', () => {
    // 配置导出会清空所有 token。导入方拿到的归档里 token 是空串,校验必须
    // 放行,否则用户根本无法导入别人分享的配置。
    expect(() =>
      validateSettings(withLink({ savedHosts: [{ ...validEntry, token: '' }] })),
    ).not.toThrow();
  });
});
