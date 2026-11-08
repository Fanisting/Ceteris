/**
 * @file src/main/platform/windows-askpass.test.ts
 * @purpose WindowsAdapter.prepareSshAskpass:按源码哈希编一次助手、csc.exe 缺失或编译失败时
 *   退回 null 并记日志、同一次运行里不反复编译。
 *
 * 关键设计:
 * - 不真的调 csc.exe (AGENTS.md 9.3):execFileSync 换成假的,按 -out: 参数写一个空 exe。
 * - SystemRoot 指向临时目录,里面放不放 csc.exe 决定"这台机器有没有 .NET Framework"。
 * - 编译失败的记忆是模块级变量,每个用例 resetModules 后重新 import,互不影响。
 *
 * @对应文档章节: 软件定义书.md 14.9、ADR-017
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as ChildProcess from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ASKPASS_HELPER_SOURCE, buildCscArgs } from './askpass-helper-source';

const { execFileSync, logger } = vi.hoisted(() => ({
  execFileSync: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof ChildProcess>()),
  execFileSync,
}));
vi.mock('../logger', () => ({ logger }));

const HASH = createHash('sha256').update(ASKPASS_HELPER_SOURCE).digest('hex').slice(0, 12);

let root: string;
let systemRoot: string;
let dataDir: string;

/** 在假的 SystemRoot 下放一个 csc.exe,内容无所谓,只看存在与否。 */
function installCsc(arch: 'Framework64' | 'Framework'): string {
  const dir = join(systemRoot, 'Microsoft.NET', arch, 'v4.0.30319');
  mkdirSync(dir, { recursive: true });
  const csc = join(dir, 'csc.exe');
  writeFileSync(csc, '');
  return csc;
}

/** 假编译器:像 csc 一样把产物写到 -out: 指定的位置。 */
function compileSucceeds(): void {
  execFileSync.mockImplementation((_file: string, args: string[]) => {
    const out = args.find((a) => a.startsWith('-out:'));
    if (out) writeFileSync(out.slice('-out:'.length), 'MZ');
    return Buffer.alloc(0);
  });
}

async function freshAdapter() {
  vi.resetModules();
  const { WindowsAdapter } = await import('./windows');
  return new WindowsAdapter();
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ceteris-askpass-test-'));
  systemRoot = join(root, 'Windows');
  dataDir = join(root, 'data');
  mkdirSync(systemRoot, { recursive: true });
  vi.stubEnv('SystemRoot', systemRoot);
  execFileSync.mockReset();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe('WindowsAdapter.prepareSshAskpass', () => {
  it('按源码哈希编一次,之后直接复用;不经 shell,也不往环境里放任何东西', async () => {
    const csc = installCsc('Framework64');
    compileSucceeds();
    const adapter = await freshAdapter();

    const exe = join(dataDir, 'askpass', `ceteris-askpass-${HASH}.exe`);
    const source = join(dataDir, 'askpass', `ceteris-askpass-${HASH}.cs`);
    expect(adapter.prepareSshAskpass(dataDir)).toEqual({ command: exe, env: {} });
    expect(adapter.prepareSshAskpass(dataDir)).toEqual({ command: exe, env: {} });

    expect(execFileSync).toHaveBeenCalledTimes(1);
    const [file, args, options] = execFileSync.mock.calls[0] as [
      string,
      string[],
      Record<string, unknown>,
    ];
    expect(file).toBe(csc);
    expect(args).toEqual(buildCscArgs(source, exe));
    // shell 会让 cmd.exe 解释命令行,正是这个助手要避开的东西
    expect(options['shell']).toBeUndefined();
    expect(readFileSync(source, 'utf8')).toBe(ASKPASS_HELPER_SOURCE);
  });

  it('没有 csc.exe 时返回 null 并记下原因,不抛错', async () => {
    const adapter = await freshAdapter();
    expect(adapter.prepareSshAskpass(dataDir)).toBeNull();
    expect(execFileSync).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      'Askpass',
      expect.stringContaining('csc.exe not found'),
    );
  });

  it.each([
    [
      'csc 报错',
      () =>
        execFileSync.mockImplementation(() => {
          throw new Error('error CS0006');
        }),
    ],
    ['csc 退出 0 却没有产物', () => execFileSync.mockReturnValue(Buffer.alloc(0))],
  ])('%s时返回 null,本次运行不再重编', async (_name, arrange) => {
    installCsc('Framework64');
    arrange();
    const adapter = await freshAdapter();
    expect(adapter.prepareSshAskpass(dataDir)).toBeNull();
    expect(logger.error).toHaveBeenCalledWith(
      'Askpass',
      expect.stringContaining('compile failed'),
      expect.any(Error),
    );
    // 每条 SFTP 连接都会问一次助手,失败的编译不能每次都重来
    expect(adapter.prepareSshAskpass(dataDir)).toBeNull();
    expect(execFileSync).toHaveBeenCalledTimes(1);
  });
});
