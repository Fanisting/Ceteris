/**
 * @file src/main/platform/macos.ts
 * @purpose macOS 平台适配器。
 *
 * @关键设计:
 * - Shell handling matches Linux, so it delegates to LinuxAdapter instead of copying it.
 * - lifecycleModel = 'dock-resident': the app stays in the Dock when its windows close.
 * - An app opened from Finder gets launchd's bare PATH, without Homebrew or anything a shell
 *   profile adds, so `claude` would not be found. getRefreshedPath asks the login shell.
 * - zsh is the default shell here, and it only reads a file named .zshrc from ZDOTDIR, so
 *   the hook is copied to that name in a private folder.
 * - No /proc on macOS, so getProcessCwd uses lsof.
 * - A Mac app with no menu loses Cmd+C, Cmd+V and Cmd+Q, so unlike the other platforms it
 *   has a small one holding only the standard roles.
 * - Finder integration is not built. Those calls do nothing rather than fail.
 *
 * @对应文档章节: 软件定义书.md 12.2
 *
 * @常见问题排查:
 * - 终端里找不到 claude → 看 getRefreshedPath 是否超时,回退的是 launchd 的 PATH
 * - tab 不跟随 cd → zsh hook 没加载,检查 ZDOTDIR 指向的目录里有没有 .zshrc
 */
import { execFile, execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import type { MenuItemConstructorOptions } from 'electron';
import { logger } from '../logger';
import type { DefaultBookmarkSeed, PlatformAdapter, ShellInfo } from './index';
import { LinuxAdapter } from './linux';

const execFileAsync = promisify(execFile);

const LOGIN_PATH_MARKER = '__CETERIS_PATH__';
const LOGIN_PATH_TIMEOUT_MS = 3000;
/** Asking a login shell starts the user's whole profile, so one answer is reused for a while. */
const LOGIN_PATH_TTL_MS = 60_000;

/** The PATH printed after the marker. Shell profiles may print anything before it. */
export function parseLoginPath(output: string): string | null {
  const start = output.lastIndexOf(LOGIN_PATH_MARKER);
  if (start < 0) return null;
  const path = output.slice(start + LOGIN_PATH_MARKER.length).split('\n')[0]?.trim();
  return path || null;
}

/** The folder in `lsof -Fn` output, whose lines each start with a field letter. */
export function parseLsofCwd(output: string): string | null {
  const line = output.split('\n').find((l) => l.startsWith('n/'));
  return line ? line.slice(1) : null;
}

export class MacOSAdapter implements PlatformAdapter {
  /** 软件定义书 12.2 (v1.6) — macOS 留在 Dock,Electron darwin 默认即此行为 */
  readonly lifecycleModel = 'dock-resident' as const;
  readonly defaultWindowStyle = 'macos' as const;

  private readonly posix = new LinuxAdapter();
  private zshDir: string | null = null;
  private loginPath: { value: string; at: number } | null = null;

  /** The user's login shell comes first, because it is what they expect to get. */
  async detectShells(): Promise<ShellInfo[]> {
    const shells = await this.posix.detectShells();
    const login = basename(process.env['SHELL'] ?? '/bin/zsh');
    return [...shells].sort((a, b) => Number(b.id === login) - Number(a.id === login));
  }

  resolveExecutable(commandName: string, env: Record<string, string>): string | null {
    return this.posix.resolveExecutable(commandName, env);
  }

  buildShellLaunchParams(
    shell: ShellInfo,
    hookFilePath: string,
    commandToRun?: { command: string; args: string[] },
  ): { args: string[]; env: Record<string, string> } {
    if (shell.id !== 'zsh') {
      return this.posix.buildShellLaunchParams(shell, hookFilePath, commandToRun);
    }
    this.zshDir ??= mkdtempSync(join(tmpdir(), 'ceteris-zsh-'));
    const zshrc = join(this.zshDir, '.zshrc');
    copyFileSync(hookFilePath, zshrc);
    const params = this.posix.buildShellLaunchParams(shell, zshrc, commandToRun);
    const userDir = process.env['ZDOTDIR'];
    return {
      args: params.args,
      env: { ...params.env, ...(userDir ? { CETERIS_USER_ZDOTDIR: userDir } : {}) },
    };
  }

  async registerFileManagerIntegration(): Promise<void> {
    logger.info('macos-adapter', 'Finder integration is not built');
  }

  async unregisterFileManagerIntegration(): Promise<void> {
    logger.info('macos-adapter', 'Finder integration is not built');
  }

  async getProcessCwd(pid: number): Promise<string | null> {
    if (!Number.isInteger(pid) || pid <= 0) return null;
    try {
      const { stdout } = await execFileAsync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']);
      return parseLsofCwd(stdout);
    } catch (err) {
      // lsof exits non-zero once the process has gone, which is an ordinary answer here.
      logger.debug('macos-adapter', `getProcessCwd(${pid}) failed`, err);
      return null;
    }
  }

  async setAutoStart(enabled: boolean): Promise<void> {
    const { app } = await import('electron');
    app.setLoginItemSettings({ openAtLogin: enabled });
  }

  async isAutoStartEnabled(): Promise<boolean> {
    const { app } = await import('electron');
    return app.getLoginItemSettings().openAtLogin;
  }

  /** Falls back to the inherited PATH, because a broken profile must not stop a terminal. */
  getRefreshedPath(): string {
    const now = Date.now();
    if (this.loginPath && now - this.loginPath.at < LOGIN_PATH_TTL_MS) return this.loginPath.value;
    const fallback = process.env.PATH ?? '';
    try {
      const output = execFileSync(
        process.env['SHELL'] ?? '/bin/zsh',
        ['-ilc', `printf '${LOGIN_PATH_MARKER}%s\\n' "$PATH"`],
        { encoding: 'utf8', timeout: LOGIN_PATH_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'] },
      );
      const value = parseLoginPath(output) ?? fallback;
      this.loginPath = { value, at: now };
      return value;
    } catch (err) {
      logger.warn('macos-adapter', 'could not read PATH from the login shell', err);
      this.loginPath = { value: fallback, at: now };
      return fallback;
    }
  }

  normalizeSpawnEnv(env: Record<string, string>): Record<string, string> {
    // BETA-ENV-1:macOS 上 env 由 launchd / login shell 提供,
    // %SystemRoot% 这种 Win32 占位符不存在,接口纯走 no-op。
    return env;
  }

  getDefaultBookmarkSeeds(): DefaultBookmarkSeed[] {
    const home = homedir();
    return [
      { label: '桌面', path: join(home, 'Desktop') },
      { label: '主目录', path: home },
    ];
  }

  getSshControlPath(): string {
    return '~/.ssh/cm-%r@%h:%p';
  }

  applicationMenuTemplate(): MenuItemConstructorOptions[] {
    return [{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }];
  }
}
