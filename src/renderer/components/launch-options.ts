/**
 * @file src/renderer/components/launch-options.ts
 * @purpose 新建页和快捷启动共用的规则:shell 图标、WSL 路径识别、shell 过滤。
 *   两处必须看到相同的选项,所以规则只放在这里。
 *
 * @对应文档章节: 软件定义书.md 5.1 (启动模板)
 */
import type { IconName } from './icons';

export interface DetectedShell {
  id: string;
  displayName: string;
  executablePath: string;
}

/**
 * shell id → 图标。WindowsAdapter.getShellCandidates 用的 id
 * (pwsh / powershell / cmd / git-bash) 都有对应映射;其他平台未来扩展时
 * 落到 templateShell 兜底。
 */
export function shellIcon(id: string): IconName {
  if (id === 'wsl' || id.startsWith('wsl:')) return 'shell';
  switch (id) {
    case 'pwsh':
      return 'shellPwsh';
    case 'powershell':
      return 'shellPowershell';
    case 'cmd':
      return 'shellCmd';
    case 'git-bash':
      return 'shellGitBash';
    default:
      return 'templateShell';
  }
}

export function getWslDistroName(path: string): string | null {
  const match = path.match(/^\\\\(?:wsl\$|wsl\.localhost)\\([^\\]+)(?:\\|$)/i);
  return match?.[1] ?? null;
}

export function filterShellsForWslPath(
  shells: DetectedShell[],
  distroName: string | null,
): DetectedShell[] {
  if (!distroName) return shells;
  const targetId = `wsl:${distroName}`.toLowerCase();
  const distroShells = shells.filter((s) => s.id.toLowerCase() === targetId);
  if (distroShells.length > 0) return distroShells;
  return shells.filter((s) => s.id.toLowerCase() === 'wsl');
}
