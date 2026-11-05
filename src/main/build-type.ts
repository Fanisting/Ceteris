/**
 * @file src/main/build-type.ts
 * @purpose 探测当前进程是什么形态的构建产物 —— dev / portable / installed。
 *
 * 这个区分对 Explorer 右键集成、自动更新等"写系统持久化状态"的功能至关重要:
 * 只有 installed 形态的 exe 才有稳定 InstallLocation;dev 和 portable 写 HKCU
 * 里的 command 字段会指向临时 / 易变路径,后续会失效或残留。
 *
 * 检测依据:
 *   - dev:      !app.isPackaged                 (Electron 给的标志,asar 内为 true)
 *   - portable: app.isPackaged && PORTABLE_EXECUTABLE_DIR  (electron-builder portable
 *                target 启动时会注入这个 env 变量,值是用户启动 .exe 时所在目录)
 *   - installed: 其他(app.isPackaged 且无 PORTABLE_EXECUTABLE_DIR)
 *
 * 注意 PORTABLE_EXECUTABLE_DIR 仅由 electron-builder 的 portable wrapper 注入,
 * 第三方打包 / 用户自己重命名 exe 不会触发,这是设计上可接受的(用户行为 ≠ 我们的产品形态)。
 */
import { app } from 'electron';

export type BuildType = 'dev' | 'portable' | 'installed';

/** Must match executableName in electron-builder.beta.yml (compared in lower case). */
const BETA_EXECUTABLE = 'marinabeta.exe';

let cached: BuildType | null = null;

/**
 * True for packages built from electron-builder.beta.yml.
 *
 * Detection uses the exe name, not an env var: the portable wrapper is not always
 * in the launch path (running win-unpacked directly skips it), and env vars leak
 * into child shells. A beta must never be mistaken for the installed Marina.
 */
export function isBetaBuild(): boolean {
  if (!app.isPackaged) return false;
  return process.execPath.split(/[\\/]/).pop()?.toLowerCase() === BETA_EXECUTABLE;
}

/** User-facing app name, so the tray can tell a beta from the installed Marina. */
export function getAppLabel(): string {
  return isBetaBuild() ? 'Marina Beta' : 'Marina';
}

export function getBuildType(): BuildType {
  if (cached) return cached;
  if (!app.isPackaged) {
    cached = 'dev';
  } else if (isBetaBuild() || process.env['PORTABLE_EXECUTABLE_DIR']) {
    cached = 'portable';
  } else {
    cached = 'installed';
  }
  return cached;
}

/** 仅供测试用,重置缓存。 */
export function __resetBuildTypeCacheForTest(): void {
  cached = null;
}
