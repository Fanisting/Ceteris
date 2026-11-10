/**
 * @file agent-reload.ts
 * @purpose 一个 agent 有新版本时的"整体重载":关掉该 agent 的全部终端,跑升级,再把
 *   每个终端开回来并恢复上次对话;关闭时正在跑的终端自动收到 "continue"。
 *
 * @关键设计:
 * - 只动 templateId 等于该 agent 的本机终端。其他 agent、纯 shell、SSH 终端一律不碰:
 *   它们不占这个 agent 的可执行文件 (Windows 上运行中的 exe 被锁,升级会失败)。
 *   纯 shell 里手动敲出来的同一个 agent 只在 plan 里报个数,由 renderer 提醒用户。
 * - 顺序固定:先关 → 再升级 → 升级结束 (成功与否) 都把终端开回来。用户的终端永远回来,
 *   升级失败只在通知里说一声。升级完强制重查版本,通知带上实际装到的版本,这样
 *   "开回来的终端跑的是新版"有据可查。
 * - 恢复对话用各 agent 自己的命令行参数 (RESUME_ARGS),追加在模板 args 之后。
 *   开回来的终端如果在 EARLY_EXIT_MS 内就退出 (这版不认识参数),不带参数再开一次。
 * - 只有关闭时 agentPhase 为 working 的终端才发 "continue":等它重新到提示符
 *   (agentPhase 变 done) 再敲。blocked (在等用户批准) 的不发,用户本来就要做决定。
 *   READY_TIMEOUT_MS 内没到提示符就不发,终端照样留着。
 * - 同一个 agent 同时只允许一次重载;不同 agent 的重载互不等待 (升级命令本身由
 *   ipc.ts 的 startAgentUpgrade 串行)。
 * - 开回来的终端按原来的创建顺序开,显示在窗口里的那个 (owner) 仍显示在那个窗口;
 *   窗口已经关了就不指定 owner。
 *
 * @对应文档章节:软件定义书.md ADR-037
 *
 * @不要在这里做的事:
 * - 不要直接碰 SessionManager / PTY / 版本检查器:全部通过 deps 注入,单测用假的。
 * - 不要在这里决定问不问用户:对话框在 renderer (MainPane 的状态点和通知的按钮)。
 */

import type { EventEmitter } from 'node:events';
import type {
  AgentReloadPlan,
  AgentUpdateNotice,
  AgentVersionInfo,
  SessionExitedPayload,
  SessionStateChangedPayload,
} from '@shared/protocol';
import type { AgentPhase, SessionInfo } from '@shared/types';
import type { SessionRole } from '@shared/session-role';
import { detectAgent } from '@shared/next-prompt';
import { logger } from './logger';

/**
 * 每个内置 agent 恢复上次对话的参数,追加在模板 args 后面。
 * claude / codex / opencode / gemini 对照本机 2026-11-10 的 --help;
 * copilot / cursor / aider 来自各自文档,没在本机核对。不在表里的 agent 直接重开。
 */
export const RESUME_ARGS: Readonly<Record<string, readonly string[]>> = {
  'claude-code': ['--continue'],
  codex: ['resume', '--last'],
  opencode: ['--continue'],
  'gemini-cli': ['--resume', 'latest'],
  'github-copilot': ['--continue'],
  cursor: ['resume'],
  aider: ['--restore-chat-history'],
};

/** 发给刚才在跑的终端的提示 */
export const CONTINUE_PROMPT = 'continue';
/** 等开回来的 agent 到提示符的上限;Claude Code 恢复长对话要重画几秒 */
export const READY_TIMEOUT_MS = 90_000;
/** 开回来后这么快就退出,当作恢复参数不被接受,改为不带参数重开 */
export const EARLY_EXIT_MS = 8_000;
/** 敲完提示到按 Enter 的间隔,与 tab-control-server 的 SUBMIT_DELAY_MS 一致 */
export const SUBMIT_DELAY_MS = 150;
/**
 * 到提示符后还要安静这么久才敲 continue。刚 spawn 的终端处于启动宽限期,state 一直是 idle,
 * agentPhase 在第一次读屏时就报 done,但 Claude Code 还在画横幅、恢复对话;那时敲进去的字
 * 会丢 (2026-11-10 实测:spawn 后 0.4 秒发的 continue 没被收下)。
 */
export const PROMPT_QUIET_MS = 1500;
/** plan 里判断纯 shell 是否在跑该 agent 时读的屏幕行数 */
const SCREEN_ROWS = 40;

export interface ReloadContext {
  /** 升级终端开在哪个本机路径 */
  pathId: string;
  /** 升级终端归哪个窗口;'' 表示无主 */
  ownerWindowId: string;
  cols: number;
  rows: number;
}

export interface ReloadCreateInput {
  pathId: string;
  templateId: string;
  ownerWindowId: string;
  cols: number;
  rows: number;
  extraArgs?: string[];
}

export interface AgentReloadDeps {
  sessions: () => SessionInfo[];
  /** 屏幕尾部纯文本,给 detectAgent 用 */
  screenOf: (sessionId: string, rows: number) => string;
  isLocal: (pathId: string) => boolean;
  hasWindow: (windowId: string) => boolean;
  close: (sessionId: string) => void;
  create: (input: ReloadCreateInput) => Promise<SessionInfo>;
  isManuallyRenamed: (sessionId: string) => boolean;
  rename: (sessionId: string, name: string) => void;
  setRole: (sessionId: string, role: SessionRole | null) => void;
  /** 往终端写文本;终端不在了返回 false */
  write: (sessionId: string, text: string) => boolean;
  /** 'sessionStateChanged' / 'sessionOutput' / 'sessionExited' / 'sessionDestroyed' 的来源 (SessionManager) */
  events: Pick<EventEmitter, 'on' | 'off'>;
  /** 在可见终端里跑升级,resolve 为退出码;超时或被用户关掉为 null */
  upgrade: (templateId: string, ctx: ReloadContext) => Promise<number | null>;
  /** 该 agent 的版本信息;force=true 跳过缓存 */
  version: (templateId: string, force: boolean) => Promise<AgentVersionInfo | null>;
  nameOf: (templateId: string) => string;
  notify: (notice: AgentUpdateNotice) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** 关闭前记下的一个终端,开回来时照着恢复 */
interface TabRecord {
  id: string;
  pathId: string;
  ownerWindowId: string;
  cols: number;
  rows: number;
  /** 用户手动改过的名字;null 表示没改过 */
  name: string | null;
  role: SessionRole | null;
  /** 关闭时正在跑 → 开回来后发 continue */
  continue: boolean;
}

export interface ReloadResult {
  /** 关掉的终端数 */
  tabs: number;
  /** 成功开回来的终端数 */
  reopened: number;
  /** 收到 continue 的终端数 */
  continued: number;
  /** 升级命令退出码为 0 且重查后不再是 outdated */
  updated: boolean;
}

type WaitOutcome =
  | { kind: 'phase'; phase: AgentPhase }
  | { kind: 'exited'; elapsedMs: number }
  | { kind: 'timeout' };

interface Settled {
  session: SessionInfo;
  alive: boolean;
  continued: boolean;
}

export class AgentReloader {
  /** 正在重载的 agent,同一个 agent 不许并发 */
  private readonly inFlight = new Map<string, Promise<ReloadResult>>();
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(private readonly deps: AgentReloadDeps) {
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = deps.now ?? Date.now;
  }

  /** 重载会动到什么,给 renderer 的对话框用。从不抛错。 */
  plan(templateId: string): AgentReloadPlan {
    const mine = this.tabsOf(templateId);
    const kind = detectAgent(templateId, '');
    let otherTabs = 0;
    if (kind) {
      for (const s of this.deps.sessions()) {
        if (s.templateId === templateId || s.state === 'exited' || !this.deps.isLocal(s.pathId)) {
          continue;
        }
        if (detectAgent(s.templateId, this.deps.screenOf(s.id, SCREEN_ROWS)) === kind) otherTabs++;
      }
    }
    return {
      tabs: mine.length,
      running: mine.filter((s) => s.agentPhase === 'working').length,
      blocked: mine.filter((s) => s.agentPhase === 'blocked').length,
      otherTabs,
      resumes: (RESUME_ARGS[templateId]?.length ?? 0) > 0,
      inProgress: this.inFlight.has(templateId),
    };
  }

  /**
   * 开始重载。立即返回;进度走 notify ('reloading' → 'reloaded'),`done` 给单测等结果。
   * 同一个 agent 已在重载时 started=false,什么都不做。
   */
  reload(
    templateId: string,
    ctx: ReloadContext,
  ): { started: boolean; tabs: number; done: Promise<ReloadResult> } {
    const existing = this.inFlight.get(templateId);
    if (existing) return { started: false, tabs: 0, done: existing };
    const tabs = this.tabsOf(templateId)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((s) => this.record(s));
    const done = this.run(templateId, ctx, tabs).finally(() => this.inFlight.delete(templateId));
    this.inFlight.set(templateId, done);
    return { started: true, tabs: tabs.length, done };
  }

  private tabsOf(templateId: string): SessionInfo[] {
    return this.deps
      .sessions()
      .filter(
        (s) => s.templateId === templateId && s.state !== 'exited' && this.deps.isLocal(s.pathId),
      );
  }

  private record(s: SessionInfo): TabRecord {
    return {
      id: s.id,
      pathId: s.pathId,
      ownerWindowId: s.ownerWindowId ?? '',
      cols: s.cols,
      rows: s.rows,
      name: this.deps.isManuallyRenamed(s.id) ? s.displayName : null,
      role: s.role ?? null,
      continue: s.agentPhase === 'working',
    };
  }

  private async run(
    templateId: string,
    ctx: ReloadContext,
    tabs: TabRecord[],
  ): Promise<ReloadResult> {
    const name = this.deps.nameOf(templateId);
    const before = await this.deps.version(templateId, false).catch(() => null);
    const from = before?.installed;
    this.deps.notify(this.notice('reloading', templateId, name, { tabs: tabs.length, from }));
    logger.info('AgentReloader', `reload ${templateId}: closing ${tabs.length} tab(s)`);
    for (const t of tabs) this.deps.close(t.id);

    let exitCode: number | null = null;
    try {
      exitCode = await this.deps.upgrade(templateId, ctx);
    } catch (err) {
      logger.warn('AgentReloader', `upgrade of ${templateId} could not start`, err);
    }
    const after = await this.deps.version(templateId, true).catch(() => null);
    const updated = exitCode === 0 && after?.status !== 'outdated';
    logger.info(
      'AgentReloader',
      `reload ${templateId}: upgrade exit=${exitCode ?? 'none'} installed=${after?.installed ?? '?'} updated=${updated}`,
    );

    // 升级成功与否都开回来:用户的终端永远回来
    const resumeArgs = [...(RESUME_ARGS[templateId] ?? [])];
    const opened: Array<{ session: SessionInfo; tab: TabRecord }> = [];
    for (const tab of tabs) {
      const session = await this.open(templateId, tab, resumeArgs);
      if (session) opened.push({ session, tab });
    }
    const settled = await Promise.all(
      opened.map((o) => this.settle(templateId, o.session, o.tab, resumeArgs)),
    );
    const result: ReloadResult = {
      tabs: tabs.length,
      reopened: settled.filter((s) => s.alive).length,
      continued: settled.filter((s) => s.continued).length,
      updated,
    };
    // 通知上的"打开终端"指向第一个收到 continue 的终端,没有就指向第一个开回来的
    const showcase = settled.find((s) => s.continued) ?? settled.find((s) => s.alive);
    this.deps.notify(
      this.notice('reloaded', templateId, name, {
        tabs: result.reopened,
        failedTabs: tabs.length - result.reopened,
        continued: result.continued,
        updated,
        from,
        to: after?.installed,
        sessionId: showcase?.session.id,
        pathId: showcase?.session.pathId,
      }),
    );
    logger.info(
      'AgentReloader',
      `reload ${templateId}: ${result.reopened}/${tabs.length} tab(s) back, ${result.continued} continued`,
    );
    return result;
  }

  /** 开回来一个终端并恢复名字和角色;开不了 (文件夹没了等) 返回 null */
  private async open(
    templateId: string,
    tab: TabRecord,
    extraArgs: string[],
  ): Promise<SessionInfo | null> {
    const owner =
      tab.ownerWindowId && this.deps.hasWindow(tab.ownerWindowId) ? tab.ownerWindowId : '';
    try {
      const session = await this.deps.create({
        pathId: tab.pathId,
        templateId,
        ownerWindowId: owner,
        cols: tab.cols,
        rows: tab.rows,
        ...(extraArgs.length > 0 ? { extraArgs } : {}),
      });
      if (tab.name) this.deps.rename(session.id, tab.name);
      if (tab.role) this.deps.setRole(session.id, tab.role);
      return session;
    } catch (err) {
      logger.warn('AgentReloader', `could not reopen ${templateId} in ${tab.pathId}`, err);
      return null;
    }
  }

  /**
   * 开回来之后:太快退出就不带恢复参数重开;关闭时在跑的等到提示符安静下来再发 continue。
   */
  private async settle(
    templateId: string,
    session: SessionInfo,
    tab: TabRecord,
    resumeArgs: string[],
  ): Promise<Settled> {
    let current = session;
    let outcome = tab.continue
      ? await this.waitForPrompt(templateId, current.id)
      : await this.waitFor(current.id, [], EARLY_EXIT_MS);
    if (outcome.kind === 'exited' && outcome.elapsedMs < EARLY_EXIT_MS && resumeArgs.length > 0) {
      logger.warn(
        'AgentReloader',
        `${templateId} exited ${outcome.elapsedMs}ms after "${resumeArgs.join(' ')}"; reopening without it`,
      );
      const again = await this.open(templateId, tab, []);
      if (!again) return { session: current, alive: false, continued: false };
      current = again;
      if (!tab.continue) return { session: current, alive: true, continued: false };
      outcome = await this.waitForPrompt(templateId, current.id);
    }
    if (outcome.kind === 'exited') return { session: current, alive: false, continued: false };
    if (!tab.continue) return { session: current, alive: true, continued: false };
    if (outcome.kind !== 'phase' || outcome.phase !== 'done') {
      logger.info(
        'AgentReloader',
        `${templateId} sid=${current.id} not at its prompt (${outcome.kind}); continue not sent`,
      );
      return { session: current, alive: true, continued: false };
    }
    if (!this.deps.write(current.id, CONTINUE_PROMPT)) {
      return { session: current, alive: false, continued: false };
    }
    await this.sleep(SUBMIT_DELAY_MS);
    const sent = this.deps.write(current.id, '\r');
    logger.info('AgentReloader', `${templateId} sid=${current.id} told to continue: ${sent}`);
    return { session: current, alive: sent, continued: sent };
  }

  /**
   * 等 agent 真的能收输入:agentPhase 为 done,之后 PROMPT_QUIET_MS 内没有任何输出或状态
   * 变化,而且 (Claude Code / Codex) 屏幕上有它的输入框标记。刚 spawn 时 phase 就是 done
   * 但横幅还在画,所以只看 phase 不够。总共最多等 READY_TIMEOUT_MS。
   */
  private async waitForPrompt(templateId: string, sessionId: string): Promise<WaitOutcome> {
    const startedAt = this.now();
    const deadline = startedAt + READY_TIMEOUT_MS;
    // 模板本身就是 claude-code / codex 时 detectAgent 不看屏幕;用 'shell' 问一遍才真的看标记
    const knowsPrompt = detectAgent(templateId, '') !== null;
    for (;;) {
      const remaining = deadline - this.now();
      if (remaining <= 0) return { kind: 'timeout' };
      const outcome = await this.waitFor(sessionId, ['done', 'blocked'], remaining);
      if (outcome.kind === 'exited') {
        return { kind: 'exited', elapsedMs: this.now() - startedAt };
      }
      if (outcome.kind !== 'phase' || outcome.phase !== 'done') return outcome;
      const quiet = await this.waitQuiet(sessionId, Math.min(PROMPT_QUIET_MS, remaining));
      if (quiet === 'exited') return { kind: 'exited', elapsedMs: this.now() - startedAt };
      if (quiet === 'output') continue;
      if (
        knowsPrompt &&
        detectAgent('shell', this.deps.screenOf(sessionId, SCREEN_ROWS)) === null
      ) {
        // 安静了但输入框还没画出来 (比如在问 trust folder 之外的启动问题):再等一轮输出
        const again = await this.waitQuiet(sessionId, Math.min(PROMPT_QUIET_MS, remaining));
        if (again === 'exited') return { kind: 'exited', elapsedMs: this.now() - startedAt };
        continue;
      }
      return outcome;
    }
  }

  /** 这段时间内终端有没有输出或状态变化。 */
  private waitQuiet(sessionId: string, ms: number): Promise<'quiet' | 'output' | 'exited'> {
    return new Promise((resolve) => {
      const onOutput = (p: { sessionId: string }): void => {
        if (p.sessionId === sessionId) finish('output');
      };
      const onExit = (p: { sessionId: string }): void => {
        if (p.sessionId === sessionId) finish('exited');
      };
      const timer = setTimeout(() => finish('quiet'), ms);
      timer.unref?.();
      const finish = (r: 'quiet' | 'output' | 'exited'): void => {
        clearTimeout(timer);
        this.deps.events.off('sessionOutput', onOutput);
        this.deps.events.off('sessionStateChanged', onOutput);
        this.deps.events.off('sessionExited', onExit);
        this.deps.events.off('sessionDestroyed', onExit);
        resolve(r);
      };
      this.deps.events.on('sessionOutput', onOutput);
      this.deps.events.on('sessionStateChanged', onOutput);
      this.deps.events.on('sessionExited', onExit);
      this.deps.events.on('sessionDestroyed', onExit);
    });
  }

  /**
   * 等终端进入 phases 之一、退出,或超时。phases 为空时只等退出 / 超时
   * (用来发现"恢复参数不被接受"的早退)。
   */
  private waitFor(
    sessionId: string,
    phases: AgentPhase[],
    timeoutMs: number,
  ): Promise<WaitOutcome> {
    const start = this.now();
    const current = this.deps.sessions().find((s) => s.id === sessionId);
    if (!current || current.state === 'exited') {
      return Promise.resolve({ kind: 'exited', elapsedMs: 0 });
    }
    if (current.agentPhase && phases.includes(current.agentPhase)) {
      return Promise.resolve({ kind: 'phase', phase: current.agentPhase });
    }
    return new Promise<WaitOutcome>((resolve) => {
      const onState = (p: SessionStateChangedPayload): void => {
        if (p.sessionId !== sessionId) return;
        const phase = p.full.agentPhase;
        if (phase && phases.includes(phase)) finish({ kind: 'phase', phase });
      };
      const onExit = (p: SessionExitedPayload | { sessionId: string }): void => {
        if (p.sessionId === sessionId) finish({ kind: 'exited', elapsedMs: this.now() - start });
      };
      const timer = setTimeout(() => finish({ kind: 'timeout' }), timeoutMs);
      timer.unref?.();
      const finish = (outcome: WaitOutcome): void => {
        clearTimeout(timer);
        this.deps.events.off('sessionStateChanged', onState);
        this.deps.events.off('sessionExited', onExit);
        this.deps.events.off('sessionDestroyed', onExit);
        resolve(outcome);
      };
      this.deps.events.on('sessionStateChanged', onState);
      this.deps.events.on('sessionExited', onExit);
      this.deps.events.on('sessionDestroyed', onExit);
    });
  }

  /** 组一条通知;extra 里 undefined 的字段不写进去 (协议类型不允许显式 undefined) */
  private notice(
    kind: AgentUpdateNotice['kind'],
    templateId: string,
    name: string,
    extra: { [K in keyof AgentUpdateNotice]?: AgentUpdateNotice[K] | undefined },
  ): AgentUpdateNotice {
    const n: AgentUpdateNotice = { kind, templateId, name };
    for (const [k, v] of Object.entries(extra)) {
      if (v !== undefined) (n as unknown as Record<string, unknown>)[k] = v;
    }
    return n;
  }
}
