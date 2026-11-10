/**
 * @file src/main/session-restore.ts
 * @purpose Reopens the tabs Ceteris had open when it last stopped (ADR-039). While the app
 *   runs, keeps restore.json in step with the live tabs; at launch, reads it and starts each
 *   tab again, Claude Code and Codex with the id that resumes their own conversation.
 *
 * @关键设计:
 * - restore.json is written continuously (debounced, plus a slow timer), not only at quit.
 *   Installing an update usually ends Ceteris without before-quit / will-quit (the installer
 *   kills the process), and a crash never runs them either. Whatever was saved last wins.
 * - At quit, `freeze()` takes a last snapshot and stops listening, because the shutdown that
 *   follows destroys every session and would otherwise empty the file.
 * - While a restore runs, nothing is saved: a crash halfway would otherwise lose the tabs
 *   not reopened yet. One save at the end records the reopened tabs.
 * - The rules (which tabs start, which flags, which tab the window shows) are in
 *   @shared/session-restore. This class does the I/O and the order.
 * - Resume ids: the id the agent announced (ceteris-tabs hook) is saved with the tab.
 *   Without one, the launch looks in the agent's transcript folder (agent-resume.ts) using
 *   the saved times. Two tabs never get the same id: a duplicate counts as not found.
 * - Every id is checked against the agent's files before it is passed. A refused id cannot be
 *   noticed afterwards: agents run in a shell that stays open (-NoExit), so a failed
 *   `claude --resume` leaves a bare prompt rather than an exited tab. A missing transcript
 *   means the tab starts fresh.
 *
 * @对应文档章节:软件定义书.md ADR-039, 8.3;ADR-036 (shelf, resume ids), ADR-037 (resume flags)
 *
 * @不要在这里做的事:
 * - Do not decide the rules here; they are pure functions in @shared/session-restore.
 * - Do not touch Electron or SessionManager directly; everything comes in through deps, so
 *   tests run under plain Vitest.
 * - Do not send input (like "continue") to reopened agents: the user chose to quit, and a
 *   reopened agent waits for them.
 *
 * @常见问题排查:
 * - Tabs did not come back: main.log "[SessionRestore]" lines. "disabled" means the setting is
 *   off; "skip" names the tab and why (template deleted, folder gone).
 * - A Claude tab came back as a new conversation: its saved resume was null and the lookup
 *   found nothing, usually because the ceteris-tabs plugin is not installed and two tabs of
 *   the same agent shared the folder.
 */
import type { EventEmitter } from 'node:events';
import { homedir } from 'node:os';
import {
  EMPTY_RESTORE_FILE,
  isRestorable,
  launchArgs,
  pickFocusTab,
  restoreKind,
  sanitizeRestoreFile,
  RESTORE_SAVE_DEBOUNCE_MS,
  RESTORE_SAVE_INTERVAL_MS,
  type RestoreFile,
  type RestoreTab,
} from '@shared/session-restore';
import { resumableAgentOf, type ResumableAgent, type ShelfEntry } from '@shared/shelf';
import { isAgentTemplate } from '@shared/agent-title';
import type { SessionRole } from '@shared/session-role';
import type { SessionInfo, Template } from '@shared/types';
import { agentSessionExists, findAgentSessionId } from './agent-resume';
import { logger } from './logger';
import type { JsonStore } from './persistence';

/** Size a reopened tab starts with; the window resizes it as soon as it shows the tab. */
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 30;

/** SessionManager events that change what restore.json should hold. */
const WATCHED_EVENTS = [
  'sessionCreated',
  'sessionDestroyed',
  'sessionExited',
  'sessionOwnerChanged',
  'sessionStateChanged',
] as const;

export interface RestoreCreateInput {
  pathId: string;
  templateId: string;
  ownerWindowId: string;
  cols: number;
  rows: number;
  extraArgs?: string[];
}

export interface SessionRestoreDeps {
  /** SessionManager events (see WATCHED_EVENTS) */
  events: Pick<EventEmitter, 'on' | 'off'>;
  listSessions(): SessionInfo[];
  lastActivityAt(sessionId: string): number;
  lastEnterAt(sessionId: string): number;
  agentSession(sessionId: string): { agent: ResumableAgent; sessionId: string } | null;
  isManuallyRenamed(sessionId: string): boolean;
  /** The template, or null when it no longer exists */
  template(templateId: string): Template | null;
  isSshPath(pathId: string): boolean;
  create(input: RestoreCreateInput): Promise<SessionInfo>;
  rename(sessionId: string, name: string): void;
  setRole(sessionId: string, role: SessionRole | null): void;
  setAgentSession(sessionId: string, agent: ResumableAgent, agentSessionId: string): void;
  /** Puts a tab in the shelf (ShelfManager.putBack); resolves once the shelf is loaded */
  shelve(tab: Omit<ShelfEntry, 'id' | 'shelvedAt' | 'reason'>): Promise<void>;
  /** settings.behavior.restoreTabsOnLaunch */
  enabled(): boolean;
  /** Per template id, the folder-wide resume flags (agent-reload.ts RESUME_ARGS) */
  folderResumeArgs: Readonly<Record<string, readonly string[]>>;
  findResumeId?: typeof findAgentSessionId;
  /** Default agentSessionExists; tests replace it */
  resumeIdExists?: typeof agentSessionExists;
  homeDir?: string;
  now?: () => number;
  /** Tests shorten this; the app uses RESTORE_SAVE_DEBOUNCE_MS. */
  saveDebounceMs?: number;
}

export interface RestoreResult {
  /** Tabs started again */
  reopened: number;
  /** Of those, how many were given resume flags */
  resumed: number;
  /** Tabs put in the shelf */
  shelved: number;
  /** Tabs dropped: template gone or the launch failed */
  skipped: number;
}

export class SessionRestorer {
  private saveTimer: NodeJS.Timeout | null = null;
  private intervalTimer: NodeJS.Timeout | null = null;
  private listening = false;
  private frozen = false;
  private restoring = false;
  private restored = false;
  private readonly onEvent = (): void => this.scheduleSave();

  constructor(
    private readonly store: JsonStore<RestoreFile>,
    private readonly deps: SessionRestoreDeps,
  ) {}

  /** Starts following the live tabs. Call after restore(), or restore() calls it. */
  start(): void {
    if (this.listening || this.frozen) return;
    this.listening = true;
    for (const ev of WATCHED_EVENTS) this.deps.events.on(ev, this.onEvent);
    this.intervalTimer = setInterval(() => this.saveNow(), RESTORE_SAVE_INTERVAL_MS);
    this.intervalTimer.unref?.();
  }

  /**
   * Last snapshot before quitting, then stops following. Call before SessionManager.shutdown,
   * then flush() to wait for the write.
   */
  freeze(): void {
    if (this.frozen) return;
    if (!this.restoring) this.saveNow();
    this.frozen = true;
    this.stopListening();
  }

  async flush(): Promise<void> {
    await this.store.flush();
  }

  /**
   * Reopens the saved tabs. Runs once per process; a second call returns zeros.
   *
   * @param focusWindowId window that gets the tab a window was showing; null when no window
   *   should take one (tray-only start, or a cold start that opens a folder of its own)
   * @returns counts for the log. Never throws: a tab that fails is logged and skipped.
   */
  async restore(focusWindowId: string | null): Promise<RestoreResult> {
    const result: RestoreResult = { reopened: 0, resumed: 0, shelved: 0, skipped: 0 };
    if (this.restored) return result;
    this.restored = true;
    let file: RestoreFile;
    try {
      const { value, source } = await this.store.load({ ...EMPTY_RESTORE_FILE, tabs: [] });
      file = sanitizeRestoreFile(value);
      logger.info('SessionRestore', `loaded ${file.tabs.length} tab(s) from ${source}`);
    } catch (err) {
      logger.warn('SessionRestore', 'restore.json could not be read; starting empty', err);
      file = { ...EMPTY_RESTORE_FILE, tabs: [] };
    }
    if (!this.deps.enabled()) {
      logger.info('SessionRestore', 'disabled in settings; not reopening tabs');
      this.start();
      this.saveNow();
      return result;
    }
    this.restoring = true;
    try {
      const tabs = await this.fillResumeIds(file.tabs);
      const focus = pickFocusTab(tabs);
      for (let i = 0; i < tabs.length; i++) {
        const tab = tabs[i]!;
        const template = this.deps.template(tab.templateId);
        const kind = restoreKind(template, this.deps.isSshPath(tab.pathId));
        if (kind === 'skip') {
          logger.info(
            'SessionRestore',
            `skip "${tab.displayName}": template ${tab.templateId} gone`,
          );
          result.skipped++;
          continue;
        }
        if (kind === 'shelf') {
          await this.toShelf(tab);
          result.shelved++;
          continue;
        }
        const owner = i === focus && focusWindowId ? focusWindowId : '';
        const args = launchArgs(tab, tabs, this.deps.folderResumeArgs);
        const session = await this.launch(tab, owner, args);
        if (!session) {
          result.skipped++;
          continue;
        }
        this.applyTabState(session.id, tab, args);
        result.reopened++;
        if (args.length > 0) result.resumed++;
      }
    } finally {
      this.restoring = false;
    }
    logger.info(
      'SessionRestore',
      `reopened ${result.reopened} (${result.resumed} resumed), shelved ${result.shelved}, ` +
        `skipped ${result.skipped}`,
    );
    if (!this.frozen) {
      this.start();
      this.saveNow();
    }
    return result;
  }

  /** The snapshot restore.json would hold right now. Public for tests. */
  snapshot(): RestoreFile {
    const tabs: RestoreTab[] = [];
    for (const s of this.deps.listSessions()) {
      if (!isRestorable(s)) continue;
      const manual = this.deps.isManuallyRenamed(s.id);
      tabs.push({
        pathId: s.pathId,
        templateId: s.templateId,
        displayName: s.displayName,
        keepName: manual || isAgentTemplate(s.templateId),
        role: s.role ?? null,
        cwd: s.currentCwd || s.originalCwd,
        originalCwd: s.originalCwd,
        createdAt: s.createdAt,
        lastActivityAt: this.deps.lastActivityAt(s.id) || s.createdAt,
        lastEnterAt: this.deps.lastEnterAt(s.id),
        shown: s.ownerWindowId !== null,
        resume: this.deps.agentSession(s.id),
      });
    }
    tabs.sort((a, b) => a.createdAt - b.createdAt);
    return { version: 1, savedAt: this.now(), tabs };
  }

  private scheduleSave(): void {
    if (this.frozen || this.restoring) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saveNow();
    }, this.deps.saveDebounceMs ?? RESTORE_SAVE_DEBOUNCE_MS);
    this.saveTimer.unref?.();
  }

  private saveNow(): void {
    if (this.frozen || this.restoring) return;
    try {
      this.store.set(this.snapshot());
    } catch (err) {
      logger.warn('SessionRestore', 'snapshot failed', err);
    }
  }

  private stopListening(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    if (this.intervalTimer) clearInterval(this.intervalTimer);
    this.saveTimer = null;
    this.intervalTimer = null;
    if (!this.listening) return;
    this.listening = false;
    for (const ev of WATCHED_EVENTS) this.deps.events.off(ev, this.onEvent);
  }

  /**
   * Settles each tab's resume id. An announced id is kept only while its transcript exists;
   * a missing one is looked up in the agent's transcript folder. An id already taken by an
   * earlier tab is dropped, so two tabs never open the same conversation.
   */
  private async fillResumeIds(tabs: RestoreTab[]): Promise<RestoreTab[]> {
    const find = this.deps.findResumeId ?? findAgentSessionId;
    const exists = this.deps.resumeIdExists ?? agentSessionExists;
    const homeDir = this.deps.homeDir ?? homedir();
    const taken = new Set<string>();
    const out: RestoreTab[] = [];
    for (const tab of tabs) {
      const template = this.deps.template(tab.templateId);
      const agent = template ? resumableAgentOf(template) : null;
      if (!agent || this.deps.isSshPath(tab.pathId)) {
        out.push({ ...tab, resume: null });
        continue;
      }
      const cwds = [tab.originalCwd, tab.cwd, tab.pathId].filter(
        (c, i, all) => c && all.indexOf(c) === i,
      );
      let id: string | null = null;
      if (tab.resume && tab.resume.agent === agent) {
        const ok = await exists({ agent, homeDir, cwds, sessionId: tab.resume.sessionId });
        if (ok) id = tab.resume.sessionId;
        else {
          logger.info(
            'SessionRestore',
            `"${tab.displayName}": no transcript for ${tab.resume.sessionId}; starting fresh`,
          );
        }
      } else {
        id = await find({ agent, homeDir, cwds, since: tab.createdAt, until: tab.lastActivityAt });
      }
      if (id && taken.has(id)) {
        logger.info('SessionRestore', `"${tab.displayName}": id ${id} already used by another tab`);
        id = null;
      }
      if (id) taken.add(id);
      out.push({ ...tab, resume: id ? { agent, sessionId: id } : null });
    }
    return out;
  }

  private async toShelf(tab: RestoreTab): Promise<void> {
    try {
      await this.deps.shelve({
        sessionId: '',
        pathId: tab.pathId,
        templateId: tab.templateId,
        displayName: tab.displayName || tab.templateId,
        cwd: tab.cwd,
        createdAt: tab.createdAt,
        lastActivityAt: tab.lastActivityAt,
        resume: tab.resume,
      });
    } catch (err) {
      logger.warn('SessionRestore', `could not shelve "${tab.displayName}"`, err);
    }
  }

  /** Starts one tab. Returns null (and logs) when it could not start. */
  private async launch(
    tab: RestoreTab,
    owner: string,
    args: string[],
  ): Promise<SessionInfo | null> {
    try {
      return await this.deps.create({
        pathId: tab.pathId,
        templateId: tab.templateId,
        ownerWindowId: owner,
        cols: DEFAULT_COLS,
        rows: DEFAULT_ROWS,
        ...(args.length > 0 ? { extraArgs: args } : {}),
      });
    } catch (err) {
      logger.warn(
        'SessionRestore',
        `skip "${tab.displayName}": could not start ${tab.templateId} in ${tab.pathId}`,
        err,
      );
      return null;
    }
  }

  /** Name, role and agent id the tab had. The agent id only when it was resumed by id. */
  private applyTabState(sessionId: string, tab: RestoreTab, args: string[]): void {
    if (tab.resume && args.length > 0) {
      this.deps.setAgentSession(sessionId, tab.resume.agent, tab.resume.sessionId);
    }
    // Role first: setRole renames the tab to the role's name, and a name the user gave it
    // afterwards must win.
    if (tab.role) this.deps.setRole(sessionId, tab.role);
    if (tab.keepName && tab.displayName) {
      try {
        this.deps.rename(sessionId, tab.displayName);
      } catch (err) {
        logger.warn('SessionRestore', `rename failed sid=${sessionId}`, err);
      }
    }
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }
}
