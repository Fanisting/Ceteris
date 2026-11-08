/**
 * @file src/main/update-checker.ts
 * @purpose Checks GitHub Releases for a newer Ceteris and keeps the result as an
 *   UpdateStatus that windows and the tray show.
 *
 * @关键设计:
 * - Only tells the user and hands over a direct download link for their OS and CPU. It
 *   does not download or install anything: an installer swap would close every running
 *   terminal, and that should stay the user's choice.
 * - Periodic checks: first one STARTUP_DELAY_MS after launch, then every CHECK_INTERVAL_MS.
 *   They run only when settings.behavior.autoCheckUpdates is on AND this is the stable
 *   channel. Beta and dev builds are local test builds; telling them to download the
 *   stable installer would be noise. "Check now" works in every channel.
 * - Failures (offline, GitHub rate limit at 60 requests per hour per IP, a malformed
 *   response) are logged as warn and stored as state 'error'. They never throw out of
 *   the timer and never pop anything up. A previously found update stays visible.
 * - Network and Electron live outside this class (fetchLatest, onStatus), so it runs under
 *   plain Vitest. index.ts wires net.fetch, the settings and the IPC broadcast.
 *
 * @对应文档章节: 软件定义书.md ADR-018;ipc-protocol.md cmd:update:*、evt:update:status-changed
 *
 * @不要在这里做的事:
 * - 不要下载或运行安装包
 * - 不要弹对话框:状态只通过事件交给 renderer 和托盘,由它们安静地显示
 * - 版本比较和选文件的规则放在 src/shared/update-check.ts,这里只调度
 */
import {
  evaluateRelease,
  parseRelease,
  type InstallTarget,
  type UpdateStatus,
} from '@shared/update-check';
import { logger } from './logger';

/** Repository whose latest release is the update feed. */
export const UPDATE_REPO = 'Fanisting/ceteris';
export const LATEST_RELEASE_URL = `https://api.github.com/repos/${UPDATE_REPO}/releases/latest`;

/** Wait after launch so the check never competes with startup work. */
export const STARTUP_DELAY_MS = 15_000;
/** Six hours: well inside GitHub's anonymous limit, fresh enough for a desktop app. */
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** What fetchLatest reports: the HTTP status and the parsed body (null when not JSON). */
export interface FetchResult {
  status: number;
  json: unknown;
}

export interface UpdateCheckerDeps {
  currentVersion: string;
  target: InstallTarget;
  /** GET LATEST_RELEASE_URL. May throw on network failure. */
  fetchLatest: () => Promise<FetchResult>;
  /** Whether periodic checks should run right now (setting on and stable channel). */
  isAutoCheckEnabled: () => boolean;
  /** Called after every state change. */
  onStatus: (status: UpdateStatus) => void;
  now?: () => number;
}

/**
 * Detects how this copy was installed, for picking the right download.
 *
 * @param env process.env (PORTABLE_EXECUTABLE_DIR marks the Windows portable exe,
 *   APPIMAGE marks a running AppImage)
 * @param exists fs.existsSync, injected for tests. Used on Linux to tell the Debian
 *   family (/etc/debian_version) from the Red Hat family (/etc/redhat-release).
 */
export function detectInstallTarget(
  platform: NodeJS.Platform,
  arch: string,
  env: Record<string, string | undefined>,
  exists: (path: string) => boolean,
): InstallTarget {
  const normalizedPlatform =
    platform === 'win32' || platform === 'darwin' || platform === 'linux' ? platform : 'other';
  let linuxPackage: InstallTarget['linuxPackage'] = null;
  if (normalizedPlatform === 'linux') {
    if (env['APPIMAGE']) linuxPackage = 'appimage';
    else if (exists('/etc/debian_version')) linuxPackage = 'deb';
    else if (exists('/etc/redhat-release') || exists('/etc/fedora-release')) linuxPackage = 'rpm';
    else linuxPackage = 'appimage';
  }
  return {
    platform: normalizedPlatform,
    arch: arch === 'x64' || arch === 'arm64' ? arch : 'other',
    portable: normalizedPlatform === 'win32' && Boolean(env['PORTABLE_EXECUTABLE_DIR']),
    linuxPackage,
  };
}

export class UpdateChecker {
  private status: UpdateStatus;
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private intervalTimer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<UpdateStatus> | null = null;

  constructor(private readonly deps: UpdateCheckerDeps) {
    this.status = {
      state: 'idle',
      currentVersion: deps.currentVersion,
      update: null,
      checkedAt: null,
      error: null,
      autoCheck: deps.isAutoCheckEnabled(),
    };
  }

  getStatus(): UpdateStatus {
    return this.status;
  }

  /** Starts or stops the periodic checks to match isAutoCheckEnabled(). Safe to call often. */
  refreshSchedule(): void {
    const enabled = this.deps.isAutoCheckEnabled();
    if (enabled !== this.status.autoCheck) this.setStatus({ autoCheck: enabled });
    if (!enabled) {
      this.stop();
      return;
    }
    if (this.startupTimer || this.intervalTimer) return;
    logger.info(
      'UpdateChecker',
      `periodic checks on: first in ${STARTUP_DELAY_MS / 1000}s, then every ${CHECK_INTERVAL_MS / 3_600_000}h`,
    );
    this.startupTimer = setTimeout(() => {
      this.startupTimer = null;
      void this.checkNow('startup');
      this.intervalTimer = setInterval(() => void this.checkNow('interval'), CHECK_INTERVAL_MS);
      this.intervalTimer.unref?.();
    }, STARTUP_DELAY_MS);
    this.startupTimer.unref?.();
  }

  stop(): void {
    if (this.startupTimer) clearTimeout(this.startupTimer);
    if (this.intervalTimer) clearInterval(this.intervalTimer);
    this.startupTimer = null;
    this.intervalTimer = null;
  }

  /**
   * Checks once. Concurrent calls share one request. Never throws: failures end up in
   * status.error and the log.
   */
  checkNow(reason: 'startup' | 'interval' | 'manual'): Promise<UpdateStatus> {
    if (this.inFlight) return this.inFlight;
    this.setStatus({ state: 'checking', error: null });
    this.inFlight = this.runCheck(reason).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async runCheck(reason: string): Promise<UpdateStatus> {
    const now = this.deps.now ?? Date.now;
    let result: FetchResult;
    try {
      result = await this.deps.fetchLatest();
    } catch (err) {
      return this.fail(
        reason,
        'network',
        `request failed (${err instanceof Error ? err.message : String(err)}). ` +
          'Possible causes: offline, proxy or firewall blocking api.github.com.',
        now(),
      );
    }

    if (result.status === 403 || result.status === 429) {
      return this.fail(
        reason,
        'rate-limited',
        `GitHub answered ${result.status}. The anonymous API allows 60 requests per hour per ` +
          'IP; other apps on this network may have used them. The next periodic check retries.',
        now(),
      );
    }
    if (result.status === 404) {
      // No published release yet is not an error for the user: nothing to update to.
      logger.info('UpdateChecker', `check (${reason}): ${UPDATE_REPO} has no published release`);
      return this.setStatus({ state: 'up-to-date', update: null, checkedAt: now() });
    }
    if (result.status < 200 || result.status >= 300) {
      return this.fail(reason, 'http', `GitHub answered HTTP ${result.status}.`, now());
    }

    const release = parseRelease(result.json);
    if (!release) {
      return this.fail(
        reason,
        'bad-response',
        'the latest release is a draft, a prerelease, or its tag is not a version like v1.2.3.',
        now(),
      );
    }

    let update;
    try {
      update = evaluateRelease(this.deps.currentVersion, release, this.deps.target);
    } catch (err) {
      return this.fail(reason, 'bad-version', String(err), now());
    }
    if (!update) {
      logger.info(
        'UpdateChecker',
        `check (${reason}): up to date, running ${this.deps.currentVersion}, latest ${release.version}`,
      );
      return this.setStatus({ state: 'up-to-date', update: null, checkedAt: now() });
    }
    logger.info(
      'UpdateChecker',
      `check (${reason}): ${update.version} available, download ${update.assetName ?? 'release page'}`,
    );
    return this.setStatus({ state: 'available', update, checkedAt: now() });
  }

  private fail(reason: string, code: string, detail: string, at: number): UpdateStatus {
    logger.warn('UpdateChecker', `check (${reason}) failed [${code}]: ${detail}`);
    // Keep an update found earlier: a later offline check does not make it go away.
    return this.setStatus({
      state: this.status.update ? 'available' : 'error',
      error: code,
      checkedAt: at,
    });
  }

  private setStatus(partial: Partial<UpdateStatus>): UpdateStatus {
    this.status = { ...this.status, ...partial };
    try {
      this.deps.onStatus(this.status);
    } catch (err) {
      logger.warn('UpdateChecker', 'onStatus listener threw', err);
    }
    return this.status;
  }
}
