/**
 * @file src/main/platform/windows.test.ts
 * @purpose 覆盖 WindowsAdapter 的 Explorer 右键集成 reg.exe 调用形态。
 *
 * 关键设计:
 * - 不真的调 reg.exe,通过 __setRunRegImplForTest 注入 mock,断言参数数组形态
 * - 验证 register 先 unregister 再 add 4 个 key,unregister 容忍 not found
 * - 验证 cleanupLegacyExplorerIntegration 删两个 EasyTerm key
 *
 * @对应文档章节: 软件定义书.md 12.2;Explorer 右键集成工作记录
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  WindowsAdapter,
  accentHex,
  __getShellCandidatesForTest,
  __parseWslDistroListOutputForTest,
  __setListWslDistrosImplForTest,
  __setReadRegistryPathImplForTest,
  __setRunRegImplForTest,
  setExplorerLabel,
  windowsRscriptPaths,
} from './windows';

describe('WindowsAdapter: PowerShell profile loads once', () => {
  // PowerShell loads $PROFILE before -Command runs. The hook used to dot-source
  // it again, so profile banners printed twice in every tab. Both halves are
  // needed: the launch args must keep the profile (no -NoProfile, which would
  // also skip AllUsers profiles) and the hook must not load it a second time.
  it('launch args keep the automatic profile load', () => {
    const adapter = new WindowsAdapter();
    for (const id of ['pwsh', 'powershell'] as const) {
      const params = adapter.buildShellLaunchParams(
        { id, displayName: id, executablePath: `${id}.exe` },
        'C:/hook.ps1',
      );
      expect(params.args).not.toContain('-NoProfile');
    }
  });

  it('pwsh.ps1 hook does not dot-source $PROFILE again', () => {
    const hook = readFileSync(join(__dirname, '../../shell-hooks/pwsh.ps1'), 'utf-8');
    const code = hook
      .split(/\r?\n/)
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');
    expect(code).not.toMatch(/\.\s+\$PROFILE/i);
  });
});

describe('WindowsAdapter — WSL shell support', () => {
  afterEach(() => {
    __setListWslDistrosImplForTest(null);
  });

  it('候选 shell 列表包含 wsl.exe 路径', () => {
    const candidates = __getShellCandidatesForTest();
    const wsl = candidates.find((s) => s.id === 'wsl');
    expect(wsl).toBeTruthy();
    expect(wsl?.displayName).toBe('WSL');
    expect(wsl?.paths.some((p) => p.toLowerCase().endsWith('\\system32\\wsl.exe'))).toBe(true);
  });

  it('buildShellLaunchParams exitAfter:shell 跑完命令就退出,不留交互', () => {
    const adapter = new WindowsAdapter();
    const cmd = { command: 'claude', args: ['update'], exitAfter: true };
    const pwsh = adapter.buildShellLaunchParams(
      { id: 'pwsh', displayName: 'PowerShell 7', executablePath: 'pwsh.exe' },
      'C:/hook.ps1',
      cmd,
    );
    expect(pwsh.args).not.toContain('-NoExit');
    // 命令不存在时 $LASTEXITCODE 未设置,必须靠 $? 才能以非 0 退出
    expect(pwsh.args[1]).toContain("& 'claude' 'update'; if ($?) { exit 0 }");
    expect(pwsh.args[1]).toMatch(/else \{ exit 1 \}$/);
    const cmdExe = adapter.buildShellLaunchParams(
      { id: 'cmd', displayName: 'Command Prompt', executablePath: 'cmd.exe' },
      'C:/hook.cmd',
      cmd,
    );
    expect(cmdExe.args[0]).toBe('/C');
    const bash = adapter.buildShellLaunchParams(
      { id: 'git-bash', displayName: 'Git Bash', executablePath: 'bash.exe' },
      'C:/hook.sh',
      cmd,
    );
    expect(bash.args.at(-1)).not.toContain('exec bash');
  });

  it('buildShellLaunchParams(wsl) 无命令时不传参数(走发行版默认 shell)', () => {
    const adapter = new WindowsAdapter();
    const result = adapter.buildShellLaunchParams(
      { id: 'wsl', displayName: 'WSL', executablePath: 'C:\\Windows\\System32\\wsl.exe' },
      'C:\\ignored\\hook.sh',
    );
    expect(result.args).toEqual([]);
    expect(result.env).toEqual({});
  });

  it('buildShellLaunchParams(wsl) 有命令时走默认交互 shell加载用户 PATH', () => {
    const adapter = new WindowsAdapter();
    const result = adapter.buildShellLaunchParams(
      { id: 'wsl', displayName: 'WSL', executablePath: 'C:\\Windows\\System32\\wsl.exe' },
      'C:\\ignored\\hook.sh',
      { command: 'echo', args: ['hello world'] },
    );
    expect(result.args[0]).toBe('--exec');
    expect(result.args[1]).toBe('sh');
    expect(result.args[2]).toBe('-lc');
    expect(result.args[3]).toContain('exec "${SHELL:-/bin/sh}" -i -c');
    expect(result.args[3]).toMatch(/echo.*hello world/);
    expect(result.env).toEqual({});
  });

  it('detectShells: 有多个发行版时,追加 WSL(<distro>) 选项', async () => {
    __setListWslDistrosImplForTest(async () => ['Ubuntu', 'Debian']);
    const adapter = new WindowsAdapter();
    const shells = await adapter.detectShells();
    const ids = shells.map((s) => s.id);
    expect(ids).not.toContain('wsl');
    expect(ids).toContain('wsl:Ubuntu');
    expect(ids).toContain('wsl:Debian');
    expect(shells.find((s) => s.id === 'wsl:Ubuntu')?.displayName).toBe('WSL (Ubuntu)');
  });

  it('buildShellLaunchParams(wsl:<distro>) 带 -d <distro>', () => {
    const adapter = new WindowsAdapter();
    const result = adapter.buildShellLaunchParams(
      {
        id: 'wsl:Ubuntu',
        displayName: 'WSL (Ubuntu)',
        executablePath: 'C:\\Windows\\System32\\wsl.exe',
      },
      'C:\\ignored\\hook.sh',
      { command: 'pwd', args: [] },
    );
    expect(result.args[0]).toBe('-d');
    expect(result.args[1]).toBe('Ubuntu');
    expect(result.args[2]).toBe('--exec');
    expect(result.args[3]).toBe('sh');
    expect(result.args[4]).toBe('-lc');
    expect(result.args[5]).toContain('exec "${SHELL:-/bin/sh}" -i -c');
  });

  it('WSL 发行版解析兼容 UTF-16LE 输出,避免中文名乱码', () => {
    const text = ['Ubuntu', '我', ''].join('\r\n');
    const buf = Buffer.from(text, 'utf16le');
    const got = __parseWslDistroListOutputForTest(buf);
    expect(got).toEqual(['Ubuntu', '我']);
  });
});

describe('WindowsAdapter — registerFileManagerIntegration', () => {
  let calls: string[][] = [];

  beforeEach(() => {
    calls = [];
    __setRunRegImplForTest(async (args: string[]) => {
      calls.push(args);
      // 所有调用默认成功
      return { stderr: '', code: 0 };
    });
  });

  afterEach(() => {
    __setRunRegImplForTest(null);
  });

  it('register 先 unregister 两次,再 add 六个 key', async () => {
    const adapter = new WindowsAdapter();
    await adapter.registerFileManagerIntegration('C:\\Program Files\\Ceteris\\Ceteris.exe');

    // 2 个 unregister(Directory + Background)+ 6 个 add
    // (2 个 menu 文案 + 2 个 Icon 值 + 2 个 command)
    expect(calls).toHaveLength(8);
    expect(calls.slice(0, 2)).toEqual([
      ['delete', 'HKCU\\Software\\Classes\\Directory\\shell\\Ceteris', '/f'],
      ['delete', 'HKCU\\Software\\Classes\\Directory\\Background\\shell\\Ceteris', '/f'],
    ]);
  });

  it('register 写 Icon 字段引用 exe 内嵌图标 ",0"', async () => {
    const adapter = new WindowsAdapter();
    await adapter.registerFileManagerIntegration('C:\\Program Files\\Ceteris\\Ceteris.exe');
    // 两个 hive 各一条 Icon
    const iconCalls = calls.filter(
      (a) => a[0] === 'add' && a.includes('/v') && a[a.indexOf('/v') + 1] === 'Icon',
    );
    expect(iconCalls).toHaveLength(2);
    for (const c of iconCalls) {
      const dIdx = c.indexOf('/d');
      expect(c[dIdx + 1]).toBe('C:\\Program Files\\Ceteris\\Ceteris.exe,0');
    }
  });

  it('beta 有自己的注册表项,不碰稳定版的菜单', async () => {
    const adapter = new WindowsAdapter();
    setExplorerLabel('Ceteris Beta');
    try {
      await adapter.registerFileManagerIntegration('C:\\tools\\CeterisBeta.exe');
      await adapter.unregisterFileManagerIntegration();
    } finally {
      setExplorerLabel('Ceteris');
    }
    const keys = calls.map((a) => a[1] ?? '');
    expect(keys.some((k) => k.endsWith('Directory\\shell\\Ceteris Beta'))).toBe(true);
    expect(keys.some((k) => /shell\\Ceteris(\\command)?$/.test(k))).toBe(false);
  });

  it('register 写菜单文案 "在 Ceteris 终端中打开"', async () => {
    const adapter = new WindowsAdapter();
    await adapter.registerFileManagerIntegration('C:\\Ceteris.exe');
    const menuCall = calls.find(
      (a) =>
        a[0] === 'add' &&
        a[1] === 'HKCU\\Software\\Classes\\Directory\\shell\\Ceteris' &&
        a.includes('/ve'),
    );
    expect(menuCall).toBeTruthy();
    expect(menuCall).toContain('在 Ceteris 终端中打开');
  });

  it('Directory\\shell command 用 %1 占位符', async () => {
    const adapter = new WindowsAdapter();
    await adapter.registerFileManagerIntegration('C:\\My App\\Ceteris.exe');
    const cmdCall = calls.find((a) => a[1]?.endsWith('Directory\\shell\\Ceteris\\command'));
    expect(cmdCall).toBeTruthy();
    const idx = cmdCall!.indexOf('/d');
    expect(cmdCall![idx + 1]).toBe('"C:\\My App\\Ceteris.exe" --open-here "%1"');
  });

  it('Directory\\Background\\shell command 用 %V 占位符', async () => {
    const adapter = new WindowsAdapter();
    await adapter.registerFileManagerIntegration('C:\\Ceteris.exe');
    const cmdCall = calls.find((a) =>
      a[1]?.endsWith('Directory\\Background\\shell\\Ceteris\\command'),
    );
    expect(cmdCall).toBeTruthy();
    const idx = cmdCall!.indexOf('/d');
    expect(cmdCall![idx + 1]).toBe('"C:\\Ceteris.exe" --open-here "%V"');
  });

  it('unregister 删两个根 key (Directory + Background)', async () => {
    const adapter = new WindowsAdapter();
    await adapter.unregisterFileManagerIntegration();
    expect(calls).toEqual([
      ['delete', 'HKCU\\Software\\Classes\\Directory\\shell\\Ceteris', '/f'],
      ['delete', 'HKCU\\Software\\Classes\\Directory\\Background\\shell\\Ceteris', '/f'],
    ]);
  });

  it('unregister 容忍 not-found (reg.exe exit code 1)', async () => {
    __setRunRegImplForTest(async () => ({
      stderr: 'ERROR: 系统找不到指定的注册表项或值。',
      code: 1,
    }));
    const adapter = new WindowsAdapter();
    // 不应抛错
    await expect(adapter.unregisterFileManagerIntegration()).resolves.toBeUndefined();
  });

  it('register 的 add 失败(非 1)向上抛错', async () => {
    let n = 0;
    __setRunRegImplForTest(async () => {
      n++;
      // 前 2 个 unregister 成功,第 3 个(第一个 add)假装失败
      if (n <= 2) return { stderr: '', code: 0 };
      return { stderr: 'access denied', code: 5 };
    });
    const adapter = new WindowsAdapter();
    await expect(adapter.registerFileManagerIntegration('C:\\Ceteris.exe')).rejects.toThrow(
      /code=5/,
    );
  });

  it('cleanupLegacyExplorerIntegration 删两个 EasyTerm key,容忍 not found', async () => {
    __setRunRegImplForTest(async () => ({
      stderr: '系统找不到指定的注册表项或值。',
      code: 1,
    }));
    const adapter = new WindowsAdapter();
    await expect(adapter.cleanupLegacyExplorerIntegration()).resolves.toBeUndefined();
    // 实际调用断言
    const realCalls: string[][] = [];
    __setRunRegImplForTest(async (args) => {
      realCalls.push(args);
      return { stderr: '', code: 0 };
    });
    const a2 = new WindowsAdapter();
    await a2.cleanupLegacyExplorerIntegration();
    expect(realCalls).toEqual([
      ['delete', 'HKCU\\Software\\Classes\\Directory\\shell\\EasyTerm', '/f'],
      ['delete', 'HKCU\\Software\\Classes\\Directory\\Background\\shell\\EasyTerm', '/f'],
    ]);
  });
});

describe('WindowsAdapter — getRefreshedPath (BETA-001 + BETA-ENV-1)', () => {
  const originalSystemRoot = process.env.SystemRoot;
  const originalSYSTEMROOT = process.env.SYSTEMROOT;

  beforeEach(() => {
    // 钉死 SystemRoot,避免测试机环境差异(CI / 本地)影响展开结果
    process.env.SystemRoot = 'C:\\Windows';
    process.env.SYSTEMROOT = 'C:\\Windows';
  });

  afterEach(() => {
    __setReadRegistryPathImplForTest(null);
    if (originalSystemRoot === undefined) delete process.env.SystemRoot;
    else process.env.SystemRoot = originalSystemRoot;
    if (originalSYSTEMROOT === undefined) delete process.env.SYSTEMROOT;
    else process.env.SYSTEMROOT = originalSYSTEMROOT;
  });

  it('合并 HKLM + HKCU,顺序 HKLM 在前(BETA-001 原行为)', () => {
    __setReadRegistryPathImplForTest((hive) => {
      if (hive.startsWith('HKLM')) return 'C:\\Windows\\System32;C:\\bin';
      return 'D:\\user\\local';
    });
    const adapter = new WindowsAdapter();
    expect(adapter.getRefreshedPath()).toBe('C:\\Windows\\System32;C:\\bin;D:\\user\\local');
  });

  it('注册表里残留 %SystemRoot% 字面量 → 返回值必须已展开(BETA-ENV-1 核心)', () => {
    // 还原真实场景:HKLM PATH 在注册表里是 REG_EXPAND_SZ,reg query 给出的字面
    // 串里含 %SystemRoot%\System32 等占位符。展开后才能让 spawn 出来的子进程
    // 找到 powershell / cmd / reg / wmic 等 system32 系工具。
    __setReadRegistryPathImplForTest((hive) => {
      if (hive.startsWith('HKLM')) {
        return (
          '%SystemRoot%\\system32;%SystemRoot%;%SystemRoot%\\System32\\Wbem;' +
          '%SYSTEMROOT%\\System32\\WindowsPowerShell\\v1.0;' +
          '%SYSTEMROOT%\\System32\\OpenSSH'
        );
      }
      return null;
    });
    const adapter = new WindowsAdapter();
    const got = adapter.getRefreshedPath();
    expect(got).not.toMatch(/%SystemRoot%/i);
    expect(got).toContain('C:\\Windows\\System32\\WindowsPowerShell\\v1.0');
    expect(got).toContain('C:\\Windows\\System32\\OpenSSH');
  });

  it('HKCU 缺失(干净系统)→ 仅返回 HKLM 的内容,不报错', () => {
    __setReadRegistryPathImplForTest((hive) => {
      if (hive.startsWith('HKLM')) return 'C:\\Windows\\System32';
      throw new Error('ERROR: 系统找不到指定的注册表项或值。');
    });
    const adapter = new WindowsAdapter();
    expect(adapter.getRefreshedPath()).toBe('C:\\Windows\\System32');
  });

  it('HKLM + HKCU 都失败 → 回退 process.env.PATH', () => {
    const origPath = process.env.PATH;
    process.env.PATH = 'C:\\fallback\\bin';
    __setReadRegistryPathImplForTest(() => {
      throw new Error('reg.exe 不存在');
    });
    try {
      const adapter = new WindowsAdapter();
      expect(adapter.getRefreshedPath()).toBe('C:\\fallback\\bin');
    } finally {
      if (origPath === undefined) delete process.env.PATH;
      else process.env.PATH = origPath;
    }
  });

  it('两个 hive 都返回 null(parse 失败 / 字段不存在)→ 回退 process.env.PATH', () => {
    const origPath = process.env.PATH;
    process.env.PATH = 'C:\\original\\path';
    __setReadRegistryPathImplForTest(() => null);
    try {
      const adapter = new WindowsAdapter();
      expect(adapter.getRefreshedPath()).toBe('C:\\original\\path');
    } finally {
      if (origPath === undefined) delete process.env.PATH;
      else process.env.PATH = origPath;
    }
  });
});

describe('WindowsAdapter — resolveExecutable', () => {
  let tempDir: string | null = null;

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it('按 PATH + PATHEXT 解析 ssh → ssh.exe', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'ceteris-win-exe-'));
    const sshPath = join(tempDir, 'ssh.exe');
    writeFileSync(sshPath, '');

    const adapter = new WindowsAdapter();
    const resolved = adapter.resolveExecutable('ssh', {
      PATH: tempDir,
      PATHEXT: '.COM;.EXE;.BAT;.CMD',
      SystemRoot: 'C:\\DefinitelyMissingWindowsRoot',
    });
    expect(resolved).toBeTruthy();
    expect(resolved!.toLowerCase()).toBe(sshPath.toLowerCase());
  });

  it('找不到命令时返回 null,由调用方生成明确诊断', () => {
    const adapter = new WindowsAdapter();
    expect(
      adapter.resolveExecutable('definitely-not-a-real-command', {
        PATH: 'C:\\missing',
        PATHEXT: '.EXE',
        SystemRoot: 'C:\\Windows',
      }),
    ).toBeNull();
  });
});

describe('WindowsAdapter — normalizeSpawnEnv (BETA-ENV-1 兜底层)', () => {
  it('补齐 canonical SystemRoot + 展开 PATH 占位符', () => {
    const env: Record<string, string> = {
      SYSTEMROOT: 'C:\\Windows', // 注意只设大写
      PATH: '%SystemRoot%\\System32;C:\\bin',
    };
    new WindowsAdapter().normalizeSpawnEnv(env);
    expect(env.SystemRoot).toBe('C:\\Windows');
    expect(env.windir).toBe('C:\\Windows');
    expect(env.PATH).toBe('C:\\Windows\\System32;C:\\bin');
  });

  it('原地修改并返回同一引用,便于调用方链式', () => {
    const env: Record<string, string> = { PATH: '%SystemRoot%\\System32' };
    const got = new WindowsAdapter().normalizeSpawnEnv(env);
    expect(got).toBe(env);
  });
});

// 让 vi 引用不报未使用警告
void vi;

describe('WindowsAdapter.getSshControlPath', () => {
  it('返回 null:Windows 版 ssh.exe 收到 ControlMaster=auto 会直接退出', () => {
    expect(new WindowsAdapter().getSshControlPath()).toBeNull();
  });
});

describe('accentHex (ADR-030)', () => {
  it('把 Electron 的 RRGGBBAA 换成 #rrggbb,格式不对返回 null', () => {
    expect(['0078D4FF', '#1a2b3c', 'abc', '', undefined].map(accentHex)).toEqual([
      '#0078d4',
      '#1a2b3c',
      null,
      null,
      null,
    ]);
  });
});

describe('windowsRscriptPaths (ADR-040)', () => {
  it('lists every R version under each root, newest first, and skips missing roots', () => {
    const dirs = new Map<string, string[]>([
      [join('PF', 'R'), ['R-4.9.3', 'R-4.10.0', 'Rtools', 'R-4.5.2']],
      [join('Local', 'R'), ['R-4.10.1']],
    ]);
    const listDir = (dir: string): string[] => {
      const names = dirs.get(dir);
      if (!names) throw new Error('ENOENT');
      return names;
    };
    expect(windowsRscriptPaths(['PF', 'Missing', 'Local'], listDir)).toEqual([
      join('Local', 'R', 'R-4.10.1', 'bin', 'Rscript.exe'),
      join('PF', 'R', 'R-4.10.0', 'bin', 'Rscript.exe'),
      join('PF', 'R', 'R-4.9.3', 'bin', 'Rscript.exe'),
      join('PF', 'R', 'R-4.5.2', 'bin', 'Rscript.exe'),
    ]);
  });
});
