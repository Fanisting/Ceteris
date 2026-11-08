import { describe, expect, it, vi } from 'vitest';
import {
  AgentVersionChecker,
  agentStatus,
  compareVersions,
  parseVersion,
  readRegistryVersion,
} from './agent-versions';

describe('agent-versions', () => {
  it('reads the version out of each CLI style of --version output', () => {
    expect(parseVersion('2.1.3 (Claude Code)')).toBe('2.1.3');
    expect(parseVersion('codex-cli 0.46.0')).toBe('0.46.0');
    expect(parseVersion('aider 0.86')).toBe('0.86');
    expect(parseVersion('command not found')).toBeNull();
  });

  it('compares versions by number, not by text', () => {
    expect(compareVersions('0.9.0', '0.10.0')).toBeLessThan(0);
    expect(compareVersions('1.2', '1.2.0')).toBe(0);
  });

  it('marks an agent outdated only when both versions are known and installed is lower', () => {
    expect(agentStatus(false, null, '1.0.0')).toBe('missing');
    expect(agentStatus(true, null, '1.0.0')).toBe('installed');
    expect(agentStatus(true, '1.0.0', null)).toBe('installed');
    expect(agentStatus(true, '1.0.0', '1.0.1')).toBe('outdated');
    expect(agentStatus(true, '1.0.1', '1.0.1')).toBe('current');
  });

  it('reads npm and PyPI response shapes', () => {
    expect(readRegistryVersion('npm', { version: '2.0.1' })).toBe('2.0.1');
    expect(readRegistryVersion('pypi', { info: { version: '0.86.1' } })).toBe('0.86.1');
    expect(readRegistryVersion('npm', null)).toBeNull();
  });

  it('caches results and re-runs --version for an agent after invalidate', async () => {
    const runVersion = vi.fn(async () => '1.0.0');
    const checker = new AgentVersionChecker({
      resolveExecutable: (cmd) => (cmd === 'claude' ? '/bin/claude' : null),
      runVersion,
      fetchJson: async () => ({ version: '1.1.0' }),
    });
    const first = await checker.list();
    expect(first.find((a) => a.templateId === 'claude-code')).toMatchObject({
      status: 'outdated',
      installed: '1.0.0',
      latest: '1.1.0',
      upgradeCommand: 'claude update',
    });
    expect(first.find((a) => a.templateId === 'codex')?.status).toBe('missing');
    await checker.list();
    expect(runVersion).toHaveBeenCalledTimes(1);
    checker.invalidate('claude-code');
    await checker.list();
    expect(runVersion).toHaveBeenCalledTimes(2);
  });
});
