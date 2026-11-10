/**
 * @file agent-auto-update.ts
 * @purpose 后台检查 agent CLI 新版本,并按设置提示用户或在提示后自动升级。
 *
 * @关键设计:
 * - 检查时机:启动后 STARTUP_DELAY_MS 一次,之后每 CHECK_INTERVAL_MS 一次;设置页
 *   "立即检查"随时可触发。版本信息来自 AgentVersionChecker (与新建页状态点同源)。
 * - 自动升级关:每个新版本只发一条 'available' 通知,用户点"升级"才跑。
 * - 自动升级开:先发 'scheduled' 通知倒计时 AUTO_UPDATE_DELAY_MS,用户可"立即升级"
 *   或"跳过此版本";倒计时结束才真正升级。**永远先通知再升级**。
 * - 不打断正在用的 agent:该 agent 还有没退出的终端时只发 'waiting',等这些终端关掉
 *   (onSessionsChanged) 再重新倒计时。Windows 上运行中的 exe 被锁,硬升级只会失败。
 * - 没有窗口 (纯托盘) 时不升级:通知没人看得到,等下一个窗口打开 (poke) 再说。
 * - 多个 agent 排队一个个升级:npm / bun 的全局安装并发跑会互相抢锁。
 * - 升级本身由 deps.startUpgrade 在一个无主终端里跑 (见 ipc.ts),成功自动关闭,
 *   失败留着;这里只等退出码再发 'done' / 'failed'。
 * - 只在 stable 渠道自动跑 (由 deps.isAutoCheckEnabled 决定):stable 和 beta 常同时开着,
 *   两边一起升级同一个全局包会撞车。
 *
 * @不要在这里做的事:
 * - 不要直接 spawn 进程或碰 PTY (交给 deps.startUpgrade)
 * - 不要在这里推断安装方式 (那是 agent-versions.ts planUpgrade 的事)
 */

import type { AgentUpdateNotice, AgentVersionInfo } from '@shared/protocol';
import { logger } from './logger';

export const STARTUP_DELAY_MS = 30_000;
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** 自动升级前的通知倒计时 */
export const AUTO_UPDATE_DELAY_MS = 30_000;

export interface AgentAutoUpdateDeps {
  /** 拉全部 agent 状态 (force=true 跳过缓存) */
  list: (force: boolean) => Promise<AgentVersionInfo[]>;
  nameOf: (templateId: string) => string;
  /** 设置开着且是 stable 渠道 */
  isAutoCheckEnabled: () => boolean;
  isAutoUpdateEnabled: () => boolean;
  /** 该 agent 是否还有没退出的终端 */
  isAgentRunning: (templateId: string) => boolean;
  hasWindow: () => boolean;
  /**
   * 在无主终端里跑升级,resolve 为退出码 (超时视为失败,返回 null)。
   * sessionId / pathId 用于失败通知里的"打开终端"。
   */
  startUpgrade: (templateId: string) => Promise<{ exitCode: number | null; sessionId: string; pathId: string }>;
  notify: (notice: AgentUpdateNotice) => void;
}

interface Pending {
  from?: string;
  to: string;
  /** 倒计时中的定时器;null 表示在等 agent 关掉或等窗口 */
  timer: ReturnType<typeof setTimeout> | null;
  /** 已经发过 waiting 通知,别重复发 */
  waitingNotified: boolean;
}

export class AgentAutoUpdater {
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private intervalTimer: ReturnType<typeof setInterval> | null = null;
  /** 'available' 通知已发过的版本,每个版本只提醒一次 */
  private readonly announced = new Map<string, string>();
  /** 用户选了"跳过此版本"的版本 */
  private readonly skipped = new Map<string, string>();
  private readonly pending = new Map<string, Pending>();
  /** 正在排队或正在跑的升级,防止同一个 agent 重复入队 */
  private readonly running = new Set<string>();
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly deps: AgentAutoUpdateDeps) {}

  /** 按设置起停定时检查。可以反复调。 */
  refreshSchedule(): void {
    if (!this.deps.isAutoCheckEnabled()) {
      this.stop();
      return;
    }
    if (this.startupTimer || this.intervalTimer) return;
    logger.info('AgentAutoUpdater', `periodic agent checks on: first in ${STARTUP_DELAY_MS / 1000}s`);
    this.startupTimer = setTimeout(() => {
      this.startupTimer = null;
      void this.checkNow();
      this.intervalTimer = setInterval(() => void this.checkNow(), CHECK_INTERVAL_MS);
      this.intervalTimer.unref?.();
    }, STARTUP_DELAY_MS);
    this.startupTimer.unref?.();
  }

  /** 停定时检查,并取消所有还没开始的自动升级 */
  stop(): void {
    if (this.startupTimer) clearTimeout(this.startupTimer);
    if (this.intervalTimer) clearInterval(this.intervalTimer);
    this.startupTimer = null;
    this.intervalTimer = null;
    for (const p of this.pending.values()) if (p.timer) clearTimeout(p.timer);
    this.pending.clear();
  }

  /** 检查一次。从不抛错。 */
  async checkNow(): Promise<void> {
    let agents: AgentVersionInfo[];
    try {
      agents = await this.deps.list(true);
    } catch (err) {
      logger.warn('AgentAutoUpdater', 'agent version check failed', err);
      return;
    }
    const auto = this.deps.isAutoUpdateEnabled();
    for (const a of agents) {
      if (a.status !== 'outdated' || !a.latest || !a.upgradeCommand) continue;
      if (this.skipped.get(a.templateId) === a.latest) continue;
      if (this.running.has(a.templateId)) continue;
      if (auto) {
        const p = this.pending.get(a.templateId);
        if (p && p.to === a.latest) continue;
        if (p?.timer) clearTimeout(p.timer);
        this.pending.set(a.templateId, {
          ...(a.installed ? { from: a.installed } : {}),
          to: a.latest,
          timer: null,
          waitingNotified: false,
        });
        this.tryStart(a.templateId);
      } else if (this.announced.get(a.templateId) !== a.latest) {
        this.announced.set(a.templateId, a.latest);
        this.deps.notify(this.notice('available', a.templateId, a.installed, a.latest));
      }
    }
  }

  /** 终端开关后调:等着的升级看看能不能开始了 */
  onSessionsChanged(): void {
    for (const id of this.pending.keys()) this.tryStart(id);
  }

  /** 有新窗口时调:没窗口时搁置的升级重新尝试 */
  poke(): void {
    this.onSessionsChanged();
  }

  /**
   * 整体重载 (agent-reload.ts) 接手这个 agent 的升级:撤掉等着的自动升级,但不算
   * 跳过版本。重载关掉终端时,onSessionsChanged 才不会抢着开始自己的倒计时。
   */
  cancelPending(templateId: string): void {
    const p = this.pending.get(templateId);
    if (!p) return;
    if (p.timer) clearTimeout(p.timer);
    this.pending.delete(templateId);
    logger.info('AgentAutoUpdater', `pending update of ${templateId} handed to reload`);
  }

  /** 这个 agent 的升级正在排队或在跑 (后台自动升级);整体重载要等它完 */
  isBusy(templateId: string): boolean {
    return this.running.has(templateId);
  }

  /** 通知上的按钮 */
  act(templateId: string, action: 'now' | 'skip' | 'update', latest?: string): void {
    const p = this.pending.get(templateId);
    if (action === 'skip') {
      if (p?.timer) clearTimeout(p.timer);
      this.pending.delete(templateId);
      const version = p?.to ?? latest ?? this.announced.get(templateId);
      if (version) this.skipped.set(templateId, version);
      logger.info('AgentAutoUpdater', `skip ${templateId} ${version ?? '?'}`);
      return;
    }
    if (p?.timer) clearTimeout(p.timer);
    this.pending.delete(templateId);
    this.enqueue(templateId, p?.from, p?.to ?? this.announced.get(templateId));
  }

  /** 条件满足就开始倒计时,不满足就挂着 */
  private tryStart(templateId: string): void {
    const p = this.pending.get(templateId);
    if (!p || p.timer) return;
    if (!this.deps.hasWindow()) return; // 没人看得到通知,先不升级
    if (this.deps.isAgentRunning(templateId)) {
      if (!p.waitingNotified) {
        p.waitingNotified = true;
        this.deps.notify(this.notice('waiting', templateId, p.from, p.to));
      }
      return;
    }
    const notice = this.notice('scheduled', templateId, p.from, p.to);
    notice.delayMs = AUTO_UPDATE_DELAY_MS;
    this.deps.notify(notice);
    p.timer = setTimeout(() => {
      this.pending.delete(templateId);
      // 倒计时期间用户可能又打开了这个 agent
      if (this.deps.isAgentRunning(templateId)) {
        this.pending.set(templateId, { ...p, timer: null, waitingNotified: false });
        this.tryStart(templateId);
        return;
      }
      this.enqueue(templateId, p.from, p.to);
    }, AUTO_UPDATE_DELAY_MS);
  }

  private enqueue(templateId: string, from: string | undefined, to: string | undefined): void {
    if (this.running.has(templateId)) return;
    this.running.add(templateId);
    this.queue = this.queue.then(async () => {
      try {
        logger.info('AgentAutoUpdater', `updating ${templateId} ${from ?? '?'} -> ${to ?? '?'}`);
        const r = await this.deps.startUpgrade(templateId);
        const ok = r.exitCode === 0;
        const n = this.notice(ok ? 'done' : 'failed', templateId, from, to);
        if (!ok) {
          if (r.exitCode !== null) n.exitCode = r.exitCode;
          n.sessionId = r.sessionId;
          n.pathId = r.pathId;
        }
        this.deps.notify(n);
      } catch (err) {
        logger.warn('AgentAutoUpdater', `update of ${templateId} could not start`, err);
        this.deps.notify(this.notice('failed', templateId, from, to));
      } finally {
        this.running.delete(templateId);
      }
    });
  }

  private notice(
    kind: AgentUpdateNotice['kind'],
    templateId: string,
    from: string | undefined,
    to: string | undefined,
  ): AgentUpdateNotice {
    const n: AgentUpdateNotice = { kind, templateId, name: this.deps.nameOf(templateId) };
    if (from) n.from = from;
    if (to) n.to = to;
    return n;
  }
}
