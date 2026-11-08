/**
 * @file src/main/askpass-policy.test.ts
 * @purpose 登录提示的分类与回答决策。文案取自 OpenSSH 和 Duo PAM 的真实输出。
 */
import { describe, expect, it } from 'vitest';
import { classifyPrompt, decideAnswer } from './askpass-policy';

describe('classifyPrompt', () => {
  it('密码提示的两种写法', () => {
    expect(classifyPrompt("me@hpc.example's password: ", null)).toBe('password');
    expect(classifyPrompt('(me@hpc.example) Password: ', null)).toBe('password');
  });

  it('Duo 的验证码不是密码', () => {
    expect(classifyPrompt('(me@hpc.example) Passcode or option (1-3): ', null)).toBe('text');
    expect(classifyPrompt('(me@hpc.example) Passcode: ', null)).toBe('text');
  });

  it('主机密钥确认', () => {
    expect(
      classifyPrompt(
        "The authenticity of host 'hpc (1.2.3.4)' can't be established.\n" +
          'Are you sure you want to continue connecting (yes/no/[fingerprint])? ',
        null,
      ),
    ).toBe('host-key');
  });

  it('密钥口令', () => {
    expect(classifyPrompt("Enter passphrase for key '/home/me/.ssh/id_ed25519': ", null)).toBe(
      'passphrase',
    );
  });

  it('SSH_ASKPASS_PROMPT=confirm 优先', () => {
    expect(classifyPrompt('Allow use of key? ', 'confirm')).toBe('confirm');
  });

  it('其它都是文本', () => {
    expect(classifyPrompt('Verification code: ', null)).toBe('text');
  });
});

describe('decideAnswer', () => {
  it('保存的密码只自动填一次,不管连接是否交互', () => {
    expect(
      decideAnswer('password', { savedPassword: 'pw', passwordUsed: false, interactive: false }),
    ).toEqual({ action: 'answer', value: 'pw' });
    expect(
      decideAnswer('password', { savedPassword: 'pw', passwordUsed: true, interactive: false }),
    ).toEqual({ action: 'deny' });
    expect(
      decideAnswer('password', { savedPassword: 'pw', passwordUsed: true, interactive: true }),
    ).toEqual({ action: 'ask', input: 'secret' });
  });

  it('保存的密码不会填进 Duo 验证码', () => {
    expect(
      decideAnswer('text', { savedPassword: 'pw', passwordUsed: false, interactive: true }),
    ).toEqual({ action: 'ask', input: 'text' });
  });

  it('后台连接一律拒绝', () => {
    for (const kind of ['password', 'passphrase', 'host-key', 'confirm', 'text'] as const) {
      expect(decideAnswer(kind, { passwordUsed: false, interactive: false })).toEqual({
        action: 'deny',
      });
    }
  });

  it('交互连接按种类选输入框', () => {
    const ctx = { passwordUsed: false, interactive: true };
    expect(decideAnswer('password', ctx)).toEqual({ action: 'ask', input: 'secret' });
    expect(decideAnswer('passphrase', ctx)).toEqual({ action: 'ask', input: 'secret' });
    expect(decideAnswer('host-key', ctx)).toEqual({ action: 'ask', input: 'confirm' });
    expect(decideAnswer('confirm', ctx)).toEqual({ action: 'ask', input: 'confirm' });
    expect(decideAnswer('text', ctx)).toEqual({ action: 'ask', input: 'text' });
  });

  it('空密码等于没保存', () => {
    expect(
      decideAnswer('password', { savedPassword: '', passwordUsed: false, interactive: false }),
    ).toEqual({ action: 'deny' });
  });
});
