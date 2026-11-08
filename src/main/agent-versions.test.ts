import { describe, expect, it, vi } from 'vitest';
import {
  AgentVersionChecker,
  agentStatus,
  compareVersions,
  findAgentSpec,
  formatUpgradeCommand,
  parseVersion,
  planUpgrade,
  readRegistryVersion,
  type FileProbe,
} from './agent-versions';

const noFiles: FileProbe = { exists: () => false, readText: () => null };

function plan(templateId: string, exe: string, real = exe, probe: FileProbe = noFiles): string | null {
  const p = planUpgrade(findAgentSpec(templateId)!, exe, real, probe);
  return p ? `${p.method}: ${formatUpgradeCommand(p)}` : null;
}

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

  it('updates with the package manager whose folder the running copy lives in', () => {
    // Homebrew: symlink in bin resolves into Cellar or Caskroom
    expect(plan('gemini-cli', '/opt/homebrew/bin/gemini', '/opt/homebrew/Cellar/gemini-cli/0.9.0/bin/gemini'))
      .toBe('brew: brew upgrade gemini-cli');
    expect(plan('codex', '/opt/homebrew/bin/codex', '/opt/homebrew/Caskroom/codex/0.46.0/codex'))
      .toBe('brew: brew upgrade --cask codex');
    // winget: Links\codex.exe resolves into Packages\<Id>_<Source>_<hash>
    expect(plan('codex', 'C:\\WinGet\\Links\\codex.exe',
      'C:\\Users\\u\\AppData\\Local\\Microsoft\\WinGet\\Packages\\OpenAI.Codex_Microsoft.Winget.Source_8wekyb3d8bbwe\\codex.exe'))
      .toBe('winget: winget upgrade --id OpenAI.Codex --exact');
    // scoop: the shim is not a link; the .shim file beside it names the app
    const shimProbe: FileProbe = {
      exists: () => false,
      readText: (p) => (p.endsWith('codex.shim') ? 'path = "C:\\Users\\u\\scoop\\apps\\codex\\current\\codex.exe"' : null),
    };
    expect(plan('codex', 'C:\\Users\\u\\scoop\\shims\\codex.exe', undefined, shimProbe))
      .toBe('scoop: scoop update codex');
    // Python tools
    expect(plan('aider', '/home/u/.local/bin/aider', '/home/u/.local/share/pipx/venvs/aider-chat/bin/aider'))
      .toBe('pipx: pipx upgrade aider-chat');
    expect(plan('aider', '/home/u/.local/bin/aider', '/home/u/.local/share/uv/tools/aider-chat/bin/aider'))
      .toBe('uv: uv tool upgrade aider-chat');
    // JS package managers
    expect(plan('gemini-cli', 'C:\\Users\\u\\.bun\\bin\\gemini.exe'))
      .toBe('bun: bun add -g @google/gemini-cli@latest');
    expect(plan('codex', 'C:\\Users\\u\\AppData\\Local\\pnpm\\codex.cmd'))
      .toBe('pnpm: pnpm add -g @openai/codex@latest');
  });

  it('recognises npm on both Windows and POSIX prefix layouts', () => {
    const winExe = 'C:\\Users\\u\\AppData\\Roaming\\npm\\codex.cmd';
    const winProbe: FileProbe = {
      exists: (p) => p === 'C:/Users/u/AppData/Roaming/npm/node_modules/@openai/codex/package.json',
      readText: () => null,
    };
    expect(plan('codex', winExe, winExe, winProbe)).toBe('npm: npm install -g @openai/codex@latest');
    expect(plan('codex', '/usr/local/bin/codex', '/usr/local/lib/node_modules/@openai/codex/bin/codex.js'))
      .toBe('npm: npm install -g @openai/codex@latest');
  });

  it('falls back to the agent\'s own update command, and offers nothing when there is none', () => {
    expect(plan('claude-code', 'C:\\Users\\u\\.local\\bin\\claude.exe')).toBe('self: claude update');
    expect(plan('codex', 'C:\\tools\\codex.exe')).toBeNull();
  });

  it('checks the first copy on PATH, reports the others, and re-checks after invalidate', async () => {
    const runVersion = vi.fn(async () => '1.0.0');
    const checker = new AgentVersionChecker({
      findOnPath: (cmd) => (cmd === 'gemini' ? ['C:\\u\\.bun\\bin\\gemini.exe', 'C:\\u\\npm\\gemini.cmd'] : []),
      realPath: (p) => p,
      probe: noFiles,
      runVersion,
      fetchJson: async () => ({ version: '1.1.0' }),
    });
    const first = await checker.list();
    expect(first.find((a) => a.templateId === 'gemini-cli')).toMatchObject({
      status: 'outdated',
      installed: '1.0.0',
      latest: '1.1.0',
      installMethod: 'bun',
      upgradeCommand: 'bun add -g @google/gemini-cli@latest',
      path: 'C:\\u\\.bun\\bin\\gemini.exe',
      otherCopies: ['C:\\u\\npm\\gemini.cmd'],
    });
    expect(first.find((a) => a.templateId === 'codex')?.status).toBe('missing');
    expect(await checker.upgradeFor('codex')).toBeNull();
    await checker.list();
    expect(runVersion).toHaveBeenCalledTimes(1);
    checker.invalidate('gemini-cli');
    await checker.list();
    expect(runVersion).toHaveBeenCalledTimes(2);
  });
});
