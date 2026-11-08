/**
 * @file src/shared/update-check.ts
 * @purpose Pure logic for the GitHub release update check: parse the release feed, compare
 *   versions, and pick the download that fits this computer.
 *
 * @关键设计:
 * - No Electron or Node imports, so every rule is testable with plain Vitest. The main
 *   process module (src/main/update-checker.ts) does the network call and timers.
 * - Asset choice follows the file names electron-builder.yml produces:
 *     Windows  Ceteris-Setup-<v>-x64.exe, Ceteris-Portable-<v>-x64.exe
 *     macOS    Ceteris-<v>-arm64.dmg, Ceteris-<v>-x64.dmg
 *     Linux    Ceteris-<v>-x86_64.AppImage, Ceteris-<v>-amd64.deb, Ceteris-<v>-x86_64.rpm
 *   Matching is by suffix and architecture tokens, not by exact name, so a renamed product
 *   or an extra build in the release does not break it.
 * - When no asset fits, the download link falls back to the release page. The user still
 *   gets one click to the right place instead of nothing.
 *
 * @对应文档章节: 软件定义书.md ADR-018
 *
 * @不要在这里做的事:
 * - 不要发网络请求、读环境变量或文件系统(那是 update-checker.ts 的职责)
 * - 不要在这里下载或安装:只给链接,由浏览器下载,用户自己安装
 */

/** One downloadable file on a GitHub release. */
export interface ReleaseAsset {
  name: string;
  /** browser_download_url: a direct link that starts the download. */
  url: string;
  size: number;
}

/** The parts of a GitHub release the update check uses. */
export interface ReleaseInfo {
  tag: string;
  /** The tag without its leading "v". */
  version: string;
  name: string;
  /** The release page on github.com. */
  htmlUrl: string;
  publishedAt: string | null;
  assets: ReleaseAsset[];
}

/** What kind of install this is. Decides which file a newer release should offer. */
export interface InstallTarget {
  platform: 'win32' | 'darwin' | 'linux' | 'other';
  arch: 'x64' | 'arm64' | 'other';
  /** Windows portable exe (electron-builder sets PORTABLE_EXECUTABLE_DIR). */
  portable: boolean;
  /** Linux package format in use: AppImage when launched as one, else the distro family. */
  linuxPackage: 'appimage' | 'deb' | 'rpm' | null;
}

/** A newer release and the link that downloads the right file for this computer. */
export interface AvailableUpdate {
  version: string;
  tag: string;
  name: string;
  htmlUrl: string;
  publishedAt: string | null;
  /** Direct file link when an asset matched, otherwise the release page. */
  downloadUrl: string;
  /** Null when no asset matched and downloadUrl is the release page. */
  assetName: string | null;
}

export type UpdateCheckState = 'idle' | 'checking' | 'up-to-date' | 'available' | 'error';

/** Shared by main, IPC and renderer. */
export interface UpdateStatus {
  state: UpdateCheckState;
  currentVersion: string;
  /** Set while state is 'available'. Kept through a later failed check. */
  update: AvailableUpdate | null;
  /** Epoch ms of the last finished check, null before the first. */
  checkedAt: number | null;
  /** Short reason when state is 'error' (offline, rate limited, bad response). */
  error: string | null;
  /** Whether periodic checks run in this build and with these settings. */
  autoCheck: boolean;
}

interface ParsedVersion {
  numbers: [number, number, number];
  prerelease: string | null;
}

/** Parses "v1.2.3", "1.2", "1.2.3-beta.1". Returns null for anything else. */
export function parseVersion(text: string): ParsedVersion | null {
  const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
    text.trim(),
  );
  if (!match) return null;
  return {
    numbers: [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)],
    prerelease: match[4] ?? null,
  };
}

/**
 * Compares two versions: negative when a is older, 0 when equal, positive when newer.
 * A prerelease is older than the release with the same numbers (1.0.0-beta < 1.0.0).
 * Prerelease labels compare as plain strings, which is enough for beta.1 < beta.2.
 * Throws when either side is not a version, so a malformed tag never looks newer.
 */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) {
    throw new Error(
      `[update-check] Cannot compare versions "${a}" and "${b}". ` +
        'Expected forms like 1.2.3 or v1.2.3-beta.1.',
    );
  }
  for (let i = 0; i < 3; i++) {
    const diff = left.numbers[i]! - right.numbers[i]!;
    if (diff !== 0) return diff;
  }
  if (left.prerelease === right.prerelease) return 0;
  if (left.prerelease === null) return 1;
  if (right.prerelease === null) return -1;
  return left.prerelease < right.prerelease ? -1 : 1;
}

/**
 * Reads the JSON of GET /repos/{owner}/{repo}/releases/latest. Returns null for drafts,
 * prereleases, and anything that is not a usable release, so callers treat all three as
 * "nothing new" rather than crashing on a surprise from the API.
 */
export function parseRelease(json: unknown): ReleaseInfo | null {
  if (!json || typeof json !== 'object') return null;
  const r = json as Record<string, unknown>;
  if (r['draft'] === true || r['prerelease'] === true) return null;
  const tag = r['tag_name'];
  const htmlUrl = r['html_url'];
  if (typeof tag !== 'string' || typeof htmlUrl !== 'string') return null;
  if (!parseVersion(tag)) return null;
  const assets: ReleaseAsset[] = [];
  if (Array.isArray(r['assets'])) {
    for (const raw of r['assets']) {
      if (!raw || typeof raw !== 'object') continue;
      const a = raw as Record<string, unknown>;
      const name = a['name'];
      const url = a['browser_download_url'];
      if (typeof name !== 'string' || typeof url !== 'string') continue;
      if (!/^https:\/\//i.test(url)) continue;
      assets.push({ name, url, size: typeof a['size'] === 'number' ? a['size'] : 0 });
    }
  }
  return {
    tag,
    version: tag.replace(/^v/, ''),
    name: typeof r['name'] === 'string' && r['name'] ? r['name'] : tag,
    htmlUrl,
    publishedAt: typeof r['published_at'] === 'string' ? r['published_at'] : null,
    assets,
  };
}

/** Architecture spellings each package format uses for the same CPU. */
const ARCH_TOKENS: Record<InstallTarget['arch'], string[]> = {
  x64: ['x64', 'x86_64', 'amd64'],
  arm64: ['arm64', 'aarch64'],
  other: [],
};

function hasArch(name: string, arch: InstallTarget['arch']): boolean {
  const lower = name.toLowerCase();
  return ARCH_TOKENS[arch].some((token) => lower.includes(token));
}

function findBy(
  assets: ReleaseAsset[],
  extension: string,
  arch: InstallTarget['arch'],
  extra?: (lower: string) => boolean,
): ReleaseAsset | null {
  return (
    assets.find((asset) => {
      const lower = asset.name.toLowerCase();
      if (!lower.endsWith(extension)) return false;
      if (extra && !extra(lower)) return false;
      return hasArch(lower, arch);
    }) ?? null
  );
}

/**
 * Picks the file for this install:
 * - Windows: the Setup exe, or the Portable exe when running portable.
 * - macOS: the dmg for this CPU (arm64 or x64).
 * - Linux: the format in use (AppImage, deb, rpm), then AppImage as the fallback,
 *   since it runs on any distribution.
 * Returns null when nothing fits; the caller then links the release page.
 */
export function selectAsset(assets: ReleaseAsset[], target: InstallTarget): ReleaseAsset | null {
  if (target.arch === 'other') return null;
  switch (target.platform) {
    case 'win32':
      return findBy(assets, '.exe', target.arch, (lower) =>
        target.portable ? lower.includes('portable') : !lower.includes('portable'),
      );
    case 'darwin':
      return findBy(assets, '.dmg', target.arch);
    case 'linux': {
      const preferred =
        target.linuxPackage === 'deb'
          ? findBy(assets, '.deb', target.arch)
          : target.linuxPackage === 'rpm'
            ? findBy(assets, '.rpm', target.arch)
            : null;
      return preferred ?? findBy(assets, '.appimage', target.arch);
    }
    default:
      return null;
  }
}

/**
 * Decides whether the release is newer than the running app, and if so builds the
 * download link for this computer. Returns null when the app is current or newer.
 */
export function evaluateRelease(
  currentVersion: string,
  release: ReleaseInfo,
  target: InstallTarget,
): AvailableUpdate | null {
  if (compareVersions(release.version, currentVersion) <= 0) return null;
  const asset = selectAsset(release.assets, target);
  return {
    version: release.version,
    tag: release.tag,
    name: release.name,
    htmlUrl: release.htmlUrl,
    publishedAt: release.publishedAt,
    downloadUrl: asset?.url ?? release.htmlUrl,
    assetName: asset?.name ?? null,
  };
}
