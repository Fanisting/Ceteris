/**
 * @file src/main/explorer-integration.ts
 * @purpose Explorer 右键集成的"系统状态"层。
 *
 * 区别于 settings.json:右键集成是否注册 = 操作系统状态(HKCU 注册表 / MSIX 包
 * 是否存在 / 证书是否信任),不是用户偏好。这个模块就是查 & 改这层状态的入口,
 * IPC handler 透传调它,SettingsView 现场查不缓存。
 *
 * 涉及两条独立的菜单:
 * - 经典菜单:HKCU\Software\Classes\Directory(\Background)\shell\Ceteris,通过
 *   reg.exe 写;Win10 / Win11 共用。
 * - Win11 新菜单(modern):MSIX 包 Ceteris.ContextMenu 注册 IExplorerCommand,
 *   通过 powershell Add-AppxPackage 装,需要先把自签证书导入 TrustedPeople。
 *
 * 三类构建产物的策略(build-type.ts 探测):
 * - dev:全部 unsupported,不允许写系统状态(exe 路径是临时的,改了会脏)
 * - portable (beta 文件夹版):经典菜单可用,每次启动刷新路径。Win11 新菜单不可用:它是
 *   MSIX 包,靠安装目录定位 exe。没有卸载程序,关闭要在设置里手动做。
 * - 单文件便携版 (有 PORTABLE_EXECUTABLE_DIR):不可用。右键会再次启动这个 exe,而第二次
 *   启动会删掉运行中程序的文件,实测 18 个文件剩 9 个。
 * - installed:正常工作
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { release } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type {
  ExplorerIntegrationCertInfo,
  ExplorerIntegrationPackageInfo,
  ExplorerIntegrationStatus,
  GetPsCommandsResponse,
} from '@shared/protocol';
import { getBuildType, type BuildType } from './build-type';
import { logger } from './logger';
import { WindowsAdapter } from './platform/windows';

const execFileAsync = promisify(execFile);

/** MSIX 包名(AppxManifest.xml 里的 Identity Name) */
const MSIX_PACKAGE_NAME = 'Ceteris.ContextMenu';
/** 期望的证书 Subject(导入到 Cert:\CurrentUser\TrustedPeople) */
const CERT_SUBJECT = 'CN=Ceteris Dev';
/** Win11 新菜单(IExplorerCommand) 要求的最低 Windows build */
const WIN11_MIN_BUILD = 22000;

/**
 * 解析 os.release(),返回 Windows build 号(如 22621),解析失败返回 null。
 * 非 Windows 返回 null。
 */
export function getWindowsBuildNumber(): number | null {
  if (process.platform !== 'win32') return null;
  const r = release(); // "10.0.22621" 形式
  const parts = r.split('.');
  if (parts.length < 3) return null;
  const n = Number.parseInt(parts[2] ?? '0', 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * 跑一段 powershell -NoProfile -Command。
 * stdout / stderr / exitCode 全部返回,调用方决定如何解读。
 */
async function runPowerShell(
  script: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
    );
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      code?: number;
    };
    return {
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? (e.message || ''),
      code: typeof e.code === 'number' ? e.code : 1,
    };
  }
}

/**
 * 查 Get-AppxPackage Ceteris.ContextMenu 的结果(JSON)。
 * 不存在 / 出错返回 null。
 */
async function queryMsixPackage(): Promise<ExplorerIntegrationPackageInfo | null> {
  const { stdout, code } = await runPowerShell(
    `$p = Get-AppxPackage -Name '${MSIX_PACKAGE_NAME}' -ErrorAction SilentlyContinue; ` +
      `if ($null -eq $p) { '' } else { ` +
      `  @{ name=$p.Name; version=$p.Version; installLocation=$p.InstallLocation } | ConvertTo-Json -Compress ` +
      `}`,
  );
  if (code !== 0 || !stdout.trim()) return null;
  try {
    const obj = JSON.parse(stdout) as ExplorerIntegrationPackageInfo;
    if (!obj.name) return null;
    return obj;
  } catch {
    return null;
  }
}

/**
 * 查 Cert:\CurrentUser\TrustedPeople 里 Ceteris Dev 证书。返回最新一张(NotAfter 最远)。
 * 不存在返回 null。
 */
async function queryCert(): Promise<ExplorerIntegrationCertInfo | null> {
  // 同时也查 LocalMachine\TrustedPeople(安装期可能写到 machine store)
  const { stdout, code } = await runPowerShell(
    `$all = @(); ` +
      `$all += Get-ChildItem Cert:\\CurrentUser\\TrustedPeople -ErrorAction SilentlyContinue | Where-Object Subject -eq '${CERT_SUBJECT}'; ` +
      `$all += Get-ChildItem Cert:\\LocalMachine\\TrustedPeople -ErrorAction SilentlyContinue | Where-Object Subject -eq '${CERT_SUBJECT}'; ` +
      `if ($all.Count -eq 0) { '' } else { ` +
      `  $latest = $all | Sort-Object NotAfter -Descending | Select-Object -First 1; ` +
      `  @{ thumbprint=$latest.Thumbprint; notAfter=$latest.NotAfter.ToString('o'); subject=$latest.Subject; trusted=$true } | ConvertTo-Json -Compress ` +
      `}`,
  );
  if (code !== 0 || !stdout.trim()) return null;
  try {
    return JSON.parse(stdout) as ExplorerIntegrationCertInfo;
  } catch {
    return null;
  }
}

/**
 * 计算 Win11 modern 菜单是否受当前构建/系统支持。
 * 返回 [supported, reason]:supported=false 时 reason 给可读说明,true 时 reason=null。
 */
function checkModernSupport(buildType: BuildType): [boolean, string | null] {
  if (buildType !== 'installed') {
    return [
      false,
      buildType === 'dev'
        ? '调试模式下不可用 —— 当前 exe 路径不稳定,会污染注册表'
        : '便携版不可用:Win11 新菜单是 MSIX 包,靠安装目录定位程序。请用下面的经典右键菜单。',
    ];
  }
  if (process.platform !== 'win32') {
    return [false, '仅 Windows 支持'];
  }
  if (!getMsixAssetPath('CeterisContextMenu.msix')) {
    return [false, '这个版本没有打包 Win11 新菜单,请用下面的经典右键菜单。'];
  }
  const b = getWindowsBuildNumber();
  if (b === null) return [false, '无法识别 Windows 版本'];
  if (b < WIN11_MIN_BUILD) {
    return [
      false,
      `当前 Windows build ${b},Win11 新菜单需要 ≥ ${WIN11_MIN_BUILD}(Win11 22H2+)`,
    ];
  }
  return [true, null];
}

function checkClassicSupport(buildType: BuildType): [boolean, string | null] {
  if (buildType === 'dev') {
    return [false, '调试模式下不可用 —— 当前 exe 路径不稳定,会污染注册表'];
  }
  if (process.env['PORTABLE_EXECUTABLE_DIR']) {
    return [false, '单文件便携版不可用:再次启动它会破坏正在运行的程序。请使用安装版或测试版。'];
  }
  if (process.platform !== 'win32') {
    return [false, '仅 Windows 支持'];
  }
  return [true, null];
}

/**
 * 取出 install/uninstall 脚本的绝对路径。
 *
 * - installed:打包时通过 extraResources 把脚本放进 `<resources>/context-menu/`
 * - 其他形态:返回 null(本来就不允许执行)
 */
function getMsixScriptPath(name: 'install.ps1' | 'uninstall.ps1'): string | null {
  if (getBuildType() !== 'installed') return null;
  const p = join(process.resourcesPath, 'context-menu', name);
  return existsSync(p) ? p : null;
}

function getMsixAssetPath(name: 'CeterisContextMenu.msix' | 'ceteris-cert.cer'): string | null {
  if (getBuildType() !== 'installed') return null;
  const p = join(process.resourcesPath, 'context-menu', name);
  return existsSync(p) ? p : null;
}

/**
 * 综合查询当前系统集成状态。不读 settings.json,全部现场查。
 */
export async function getExplorerIntegrationStatus(): Promise<ExplorerIntegrationStatus> {
  const buildType = getBuildType();
  const windowsBuild =
    process.platform === 'win32' ? release() : '';
  const [classicSupported, classicReason] = checkClassicSupport(buildType);
  const [modernSupported, modernReason] = checkModernSupport(buildType);

  let classic: ExplorerIntegrationStatus['classic'] = 'unsupported';
  if (classicSupported) {
    try {
      const adapter = new WindowsAdapter();
      const enabled = await adapter.isFileManagerIntegrationEnabled();
      classic = enabled ? 'enabled' : 'disabled';
    } catch (err) {
      logger.warn('explorer-integration', 'classic status query failed', err);
      classic = 'disabled';
    }
  }

  let modern: ExplorerIntegrationStatus['modern'] = 'unsupported';
  let pkg: ExplorerIntegrationPackageInfo | null = null;
  let cert: ExplorerIntegrationCertInfo | null = null;
  if (modernSupported) {
    pkg = await queryMsixPackage();
    cert = await queryCert();
    modern = pkg ? 'enabled' : 'disabled';
  }

  return {
    buildType,
    windowsBuild,
    win11ModernSupported: modernSupported,
    classic,
    modern,
    cert,
    package: pkg,
    classicUnsupportedReason: classicReason,
    modernUnsupportedReason: modernReason,
  };
}

/**
 * 经典菜单开/关。dev 形态不允许写。返回操作后实际状态。
 */
export async function setClassicIntegration(
  enabled: boolean,
  appExePath: string,
): Promise<{ ok: boolean; message: string }> {
  const buildType = getBuildType();
  const [supported, reason] = checkClassicSupport(buildType);
  if (!supported) return { ok: false, message: reason ?? '不支持' };

  const adapter = new WindowsAdapter();
  try {
    if (enabled) {
      await adapter.registerFileManagerIntegration(appExePath);
    } else {
      await adapter.unregisterFileManagerIntegration();
    }
    return { ok: true, message: '' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(
      'explorer-integration',
      `setClassicIntegration(${enabled}) failed`,
      err,
    );
    return { ok: false, message: msg };
  }
}

/**
 * Win11 新菜单安装/卸载。调 powershell 脚本(extraResources)。
 */
export async function setModernIntegration(
  enabled: boolean,
): Promise<{ ok: boolean; message: string }> {
  const buildType = getBuildType();
  const [supported, reason] = checkModernSupport(buildType);
  if (!supported) return { ok: false, message: reason ?? '不支持' };

  const scriptName = enabled ? 'install.ps1' : 'uninstall.ps1';
  const scriptPath = getMsixScriptPath(scriptName);
  if (!scriptPath) {
    return {
      ok: false,
      message: `安装资源 ${scriptName} 缺失;请确认 Ceteris 是从 NSIS 安装包安装(便携版不含)。`,
    };
  }

  const msixPath = enabled ? getMsixAssetPath('CeterisContextMenu.msix') : null;
  const certPath = enabled ? getMsixAssetPath('ceteris-cert.cer') : null;
  if (enabled && (!msixPath || !certPath)) {
    return {
      ok: false,
      message: '安装包 / 证书资源缺失,无法安装 Win11 新菜单',
    };
  }

  const args = enabled
    ? [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        scriptPath,
        '-MsixPath',
        msixPath!,
        '-CertPath',
        certPath!,
      ]
    : [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        scriptPath,
      ];

  try {
    const { stdout, stderr } = await execFileAsync('powershell.exe', args, {
      windowsHide: false, // 安装/证书导入会弹 UAC,不能 hide
      maxBuffer: 4 * 1024 * 1024,
    });
    logger.info(
      'explorer-integration',
      `${enabled ? 'install' : 'uninstall'} modern menu stdout`,
      { stdout: stdout.trim(), stderr: stderr.trim() },
    );
    return { ok: true, message: stdout.trim() || stderr.trim() };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    const msg = e.stderr?.trim() || e.stdout?.trim() || e.message || String(err);
    logger.warn(
      'explorer-integration',
      `setModernIntegration(${enabled}) failed`,
      err,
    );
    return { ok: false, message: msg };
  }
}

/**
 * 生成「复制 PS 命令」按钮的命令文本。专业用户可以拿到自己的管理员 shell 跑。
 * 返回的字符串面向人,带必要注释。
 */
export function getPsCommands(appExePath: string): GetPsCommandsResponse {
  const msixPath = getMsixAssetPath('CeterisContextMenu.msix') ?? '<CeterisContextMenu.msix 路径>';
  const certPath = getMsixAssetPath('ceteris-cert.cer') ?? '<ceteris-cert.cer 路径>';

  const installModern = [
    '# 1. 导入自签证书到 Cert:\\CurrentUser\\TrustedPeople(无需管理员)',
    `Import-Certificate -FilePath '${certPath}' -CertStoreLocation Cert:\\CurrentUser\\TrustedPeople`,
    '',
    '# 2. 注册 Ceteris 右键扩展 MSIX 包',
    `Add-AppxPackage -Path '${msixPath}'`,
  ].join('\n');

  const uninstallModern = [
    '# 卸载 Ceteris 右键扩展(证书保留,下次重装免 UAC)',
    `Get-AppxPackage -Name '${MSIX_PACKAGE_NAME}' -ErrorAction SilentlyContinue | Remove-AppxPackage`,
  ].join('\n');

  const installClassic = [
    '# 写 HKCU 经典右键菜单(文件夹本身 + 空白处),无需管理员',
    `reg add 'HKCU\\Software\\Classes\\Directory\\shell\\Ceteris' /ve /d '在 Ceteris 终端中打开' /f`,
    `reg add 'HKCU\\Software\\Classes\\Directory\\shell\\Ceteris\\command' /ve /d '"${appExePath}" --open-here "%1"' /f`,
    `reg add 'HKCU\\Software\\Classes\\Directory\\Background\\shell\\Ceteris' /ve /d '在 Ceteris 终端中打开' /f`,
    `reg add 'HKCU\\Software\\Classes\\Directory\\Background\\shell\\Ceteris\\command' /ve /d '"${appExePath}" --open-here "%V"' /f`,
  ].join('\n');

  const uninstallClassic = [
    '# 删除 HKCU 经典右键菜单注册项',
    `reg delete 'HKCU\\Software\\Classes\\Directory\\shell\\Ceteris' /f`,
    `reg delete 'HKCU\\Software\\Classes\\Directory\\Background\\shell\\Ceteris' /f`,
  ].join('\n');

  return { installModern, uninstallModern, installClassic, uninstallClassic };
}
