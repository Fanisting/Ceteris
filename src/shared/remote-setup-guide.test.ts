/**
 * @file src/shared/remote-setup-guide.test.ts
 * @purpose 守护远程设置引导 (ADR-032) 的纯逻辑:平台识别、prompt 是一行且指向正确的指南文件、
 *   agent 模板按快捷启动列表选。
 */
import { describe, expect, it } from 'vitest';
import {
  REMOTE_SETUP_GUIDE_FILES,
  buildRemoteSetupPrompt,
  detectGuidePlatform,
  pickGuideTemplateId,
} from './remote-setup-guide';

const WIN_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0.0.0 Electron/33.0.0';
const MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/130.0.0.0';
const LINUX_UA = 'Mozilla/5.0 (X11; Linux x86_64) Chrome/130.0.0.0';

describe('detectGuidePlatform', () => {
  it('认出三个平台', () => {
    expect(detectGuidePlatform(WIN_UA)).toBe('win32');
    expect(detectGuidePlatform(MAC_UA)).toBe('darwin');
    expect(detectGuidePlatform(LINUX_UA)).toBe('linux');
  });

  it('认不出的按 Windows 处理', () => {
    expect(detectGuidePlatform('')).toBe('win32');
  });
});

describe('REMOTE_SETUP_GUIDE_FILES', () => {
  it('两个角色各有一个 markdown 文件', () => {
    expect(REMOTE_SETUP_GUIDE_FILES.host).toMatch(/^remote-setup-host\.md$/);
    expect(REMOTE_SETUP_GUIDE_FILES.client).toMatch(/^remote-setup-client\.md$/);
  });
});

describe('buildRemoteSetupPrompt', () => {
  const path = 'C:\\Program Files\\Ceteris\\resources\\guides\\remote-setup-host.md';

  it('是一行,带引号的路径和平台名', () => {
    const prompt = buildRemoteSetupPrompt({
      role: 'host',
      platform: 'win32',
      guidePath: path,
      locale: 'en-US',
    });
    expect(prompt).not.toContain('\n');
    expect(prompt).toContain(`"${path}"`);
    expect(prompt).toContain('runs Windows');
    expect(prompt).toContain('install what is missing');
  });

  it('角色决定目标句', () => {
    const host = buildRemoteSetupPrompt({
      role: 'host',
      platform: 'linux',
      guidePath: path,
      locale: 'en-US',
    });
    const client = buildRemoteSetupPrompt({
      role: 'client',
      platform: 'linux',
      guidePath: path,
      locale: 'en-US',
    });
    expect(host).toMatch(/^Help me set up SSH access to this machine/);
    expect(client).toMatch(/^Help me connect this machine to another machine/);
    expect(host).toContain('runs Linux');
  });

  it('中文版用中文说明并要求用中文交流', () => {
    const prompt = buildRemoteSetupPrompt({
      role: 'client',
      platform: 'darwin',
      guidePath: path,
      locale: 'zh-CN',
    });
    expect(prompt).not.toContain('\n');
    expect(prompt).toContain('macOS');
    expect(prompt).toContain('用中文和我交流');
    expect(prompt).toContain(`"${path}"`);
  });

  it('路径里的双引号被去掉,不会截断引号', () => {
    const prompt = buildRemoteSetupPrompt({
      role: 'host',
      platform: 'win32',
      guidePath: 'C:\\a"b\\g.md',
      locale: 'en-US',
    });
    expect(prompt).toContain('"C:\\ab\\g.md"');
  });
});

describe('pickGuideTemplateId', () => {
  const templates = [
    { id: 'shell' },
    { id: 'claude-code' },
    { id: 'codex' },
    { id: 'admin-shell' },
  ];

  it('取快捷启动里第一个 agent', () => {
    expect(
      pickGuideTemplateId(
        [
          { kind: 'shell', id: 'pwsh' },
          { kind: 'template', id: 'codex' },
          { kind: 'template', id: 'claude-code' },
        ],
        templates,
      ),
    ).toBe('codex');
  });

  it('跳过 shell 和 admin-shell 模板', () => {
    expect(
      pickGuideTemplateId(
        [
          { kind: 'template', id: 'shell' },
          { kind: 'template', id: 'admin-shell' },
        ],
        templates,
      ),
    ).toBe('claude-code');
  });

  it('列表里的模板已被删除时跳过它', () => {
    expect(pickGuideTemplateId([{ kind: 'template', id: 'gone' }], templates)).toBe('claude-code');
  });

  it('列表为空时用 Claude Code', () => {
    expect(pickGuideTemplateId([], templates)).toBe('claude-code');
  });
});
