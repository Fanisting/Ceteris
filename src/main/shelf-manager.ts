/**
 * @file src/main/shelf-manager.ts
 * @purpose The tab shelf (ADR-036). Holds the shelved tabs, persists them in shelf.json,
 *   puts idle tabs away on a timer, and gives them back when a window asks.
 *
 * @关键设计:
 * - Shelving is: build the entry (name, folder, template, resume id), save it, announce it,
 *   then destroy the session. The announcement goes out while the session still exists, so a
 *   window can animate the tab into the box before evt:session:destroyed removes it.
 * - The resume id comes from the agent itself when the ceteris-tabs hook announced it
 *   (SessionManager.getAgentSession); otherwise agent-resume.ts looks for the newest
 *   transcript the tab could have written. No id means the tab comes back as a fresh agent.
 * - The sweep runs every SHELF_SWEEP_MS and reads the setting each time, so changing it in
 *   Settings takes effect at the next tick without restarting anything. Which sessions qualify
 *   is decided by shelf.ts (shelveBlocker), the only place with that rule.
 * - Restoring builds the CreateSessionInput; the IPC layer runs it, because SSH folders need
 *   the profile and password handling that lives there. The entry is removed only after the
 *   new session exists, so a failed launch keeps the tab in the shelf.
 * - Entries are capped (SHELF_MAX_ENTRIES); the oldest fall off. Everything persists through
 *   restarts, since the whole point is that the user forgets about the tab for days.
 *
 * @对应文档章节:软件定义书.md ADR-036, 8.3;docs/ipc-protocol.md 5.2 (cmd:shelf:*)
 *
 * @不要在这里做的事:
 * - Do not decide the shelving rule here (shelf.ts) or spawn anything (ipc.ts, SessionManager).
 * - Do not touch the headless screen or scrollback: a shelved tab keeps no screen, only the id.
 *
 * @常见问题排查:
 * - A tab never gets shelved: main.log "[Shelf] skip" lines name the blocker (role, on-screen,
 *   busy, recent). The tab a window shows is never shelved.
 * - Restored without its conversation: the entry's resume is null. The agent did not announce
 *   (plugin not installed or old) and no transcript matched the folder and time window.
 */
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import type { ShelfChangedPayload } from '@shared/protocol';
import {
  pickShelvable,
  pushEntry,
  resumableAgentOf,
  resumeArgs,
  sanitizeShelfFile,
  shelveBlocker,
  SHELF_SWEEP_MS,
  type ResumableAgent,
  type ShelfEntry,
  type ShelfFile,
} from '@shared/shelf';
import type { SessionInfo, Template } from '@shared/types';
import { findAgentSessionId } from './agent-resume';
import { logger } from './logger';
import type { JsonStore } from './persistence';

/** What the shelf needs from the rest of main. SessionManager and friends, or a fake. */
export interface ShelfHost {
  /** Live sessions as the windows see them */
  listSessions(): SessionInfo[];
  getSession(sessionId: string): SessionInfo | null;
  /** SessionManager.getLastActivityAt */
  lastActivityAt(sessionId: string): number;
  /** SessionManager.getAgentSession: the id the agent announced, or null */
  agentSession(sessionId: string): { agent: ResumableAgent; sessionId: string } | null;
  /** SessionManager.shelveSession: destroys with reason 'shelved' */
  destroy(sessionId: string): void;
  /** TemplatesManager.resolve */
  template(templateId: string): Template;
  /** settings.behavior.shelveIdleAfterHours */
  idleHours(): number;
  /** Looks up a resume id in the agent's files. Default findAgentSessionId; tests replace it. */
  findResumeId?: typeof findAgentSessionId;
  /** The user's home, for the transcript folders. Default os.homedir(). */
  homeDir?: string;
  now?: () => number;
}

export class ShelfError extends Error {
  constructor(
    readonly code: 'EntryNotFound' | 'SessionNotFound' | 'SessionBusy',
    message: string,
  ) {
    super(message);
    this.name = 'ShelfError';
  }
}

/** What a restore launches. The IPC layer turns it into a CreateSessionInput. */
export interface RestorePlan {
  entry: ShelfEntry;
  pathId: string;
  templateId: string;
  /** Appended to the template's args; empty when the tab comes back fresh */
  extraArgs: string[];
}

export class ShelfManager extends EventEmitter {
  private entries: ShelfEntry[] = [];
  private sweepTimer: NodeJS.Timeout | null = null;
  /** Sessions being shelved right now, so a sweep and a menu click never double up. */
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly store: JsonStore<ShelfFile>,
    private readonly host: ShelfHost,
  ) {
    super();
  }

  /** Loads shelf.json. A damaged file just means an empty shelf. */
  async initialize(): Promise<void> {
    const { value, source } = await this.store.load({ version: 1, entries: [] });
    this.entries = sanitizeShelfFile(value).entries;
    logger.info('Shelf', `loaded ${this.entries.length} entries from ${source}`);
  }

  /** Newest first. A copy: callers cannot edit the shelf by accident. */
  list(): ShelfEntry[] {
    return this.entries.map((e) => ({ ...e }));
  }

  get(entryId: string): ShelfEntry | null {
    return this.entries.find((e) => e.id === entryId) ?? null;
  }

  /** Starts the periodic sweep. Safe to call once; a second call is ignored. */
  startSweep(intervalMs: number = SHELF_SWEEP_MS): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => void this.sweep(), intervalMs);
    // Let the app exit without waiting for the timer (Electron keeps the loop alive anyway).
    this.sweepTimer.unref?.();
  }

  stopSweep(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }

  /**
   * Shelves every session that has been idle long enough. Returns the entries made, so tests
   * and logs can see what happened. Runs one session at a time: each shelve awaits a file
   * lookup, and the list of sessions may change meanwhile.
   */
  async sweep(): Promise<ShelfEntry[]> {
    const afterMs = this.host.idleHours() * 3_600_000;
    if (afterMs <= 0) return [];
    const now = this.now();
    const due = pickShelvable(
      this.host.listSessions(),
      (id) => this.host.lastActivityAt(id),
      now,
      afterMs,
    );
    const made: ShelfEntry[] = [];
    for (const s of due) {
      // Re-check: an earlier shelve in this sweep took time, and the user may have come back.
      const blocker = shelveBlocker(
        this.host.getSession(s.id) ?? s,
        this.host.lastActivityAt(s.id),
        this.now(),
        afterMs,
      );
      if (blocker !== null || !this.host.getSession(s.id)) {
        logger.debug('Shelf', `skip sid=${s.id} blocker=${blocker ?? 'gone'}`);
        continue;
      }
      try {
        const entry = await this.shelve(s.id, 'auto');
        if (entry) made.push(entry);
      } catch (err) {
        logger.warn('Shelf', `auto shelve failed sid=${s.id}`, err);
      }
    }
    return made;
  }

  /**
   * Puts one session in the shelf. 'manual' ignores the idle timer and the on-screen rule
   * (the user just clicked it), but a working agent is still refused.
   *
   * @returns the entry, or null when the session was already being shelved
   * @throws ShelfError SessionNotFound / SessionBusy
   */
  async shelve(sessionId: string, reason: 'auto' | 'manual'): Promise<ShelfEntry | null> {
    if (this.inFlight.has(sessionId)) return null;
    const session = this.host.getSession(sessionId);
    if (!session) {
      throw new ShelfError(
        'SessionNotFound',
        `shelve: no session "${sessionId}". It may have been closed already, or belongs to ` +
          `another Ceteris (stable vs beta). Reopen the tab menu and try again.`,
      );
    }
    if (session.agentPhase === 'working') {
      throw new ShelfError(
        'SessionBusy',
        `shelve: session "${sessionId}" (${session.displayName}) has an agent working. ` +
          `Wait for it to finish or stop it first.`,
      );
    }
    this.inFlight.add(sessionId);
    try {
      const resume = await this.resumeFor(session);
      const entry: ShelfEntry = {
        id: randomUUID(),
        sessionId: session.id,
        pathId: session.pathId,
        templateId: session.templateId,
        displayName: session.displayName,
        cwd: session.currentCwd || session.originalCwd,
        createdAt: session.createdAt,
        lastActivityAt: this.host.lastActivityAt(session.id),
        shelvedAt: this.now(),
        reason,
        resume,
      };
      // The session may have gone while the file lookup ran.
      if (!this.host.getSession(sessionId)) return null;
      this.entries = pushEntry(this.entries, entry);
      this.persist();
      logger.info(
        'Shelf',
        `shelved sid=${session.id} "${session.displayName}" reason=${reason} resume=${
          resume ? `${resume.agent}:${resume.sessionId}` : 'none'
        }`,
      );
      this.emitChanged(session.id);
      this.host.destroy(session.id);
      return entry;
    } finally {
      this.inFlight.delete(sessionId);
    }
  }

  /**
   * What to launch for an entry. Does not remove it: call `forget` once the session exists.
   * @throws ShelfError EntryNotFound
   */
  planRestore(entryId: string): RestorePlan {
    const entry = this.get(entryId);
    if (!entry) {
      throw new ShelfError(
        'EntryNotFound',
        `restore: no shelf entry "${entryId}". It was cleared, restored from another window, ` +
          `or the shelf file was edited. Close and reopen the box.`,
      );
    }
    let extraArgs: string[] = [];
    if (entry.resume) {
      // The template may have been edited since; only pass resume flags to the same agent.
      const agent = resumableAgentOf(this.safeTemplate(entry.templateId));
      if (agent === entry.resume.agent) extraArgs = resumeArgs(agent, entry.resume.sessionId);
    }
    return { entry, pathId: entry.pathId, templateId: entry.templateId, extraArgs };
  }

  /** Drops one entry. Unknown ids are a no-op, so two windows can both clear the same row. */
  forget(entryId: string): void {
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e.id !== entryId);
    if (this.entries.length === before) return;
    this.persist();
    this.emitChanged();
  }

  clear(): void {
    if (this.entries.length === 0) return;
    this.entries = [];
    this.persist();
    this.emitChanged();
  }

  /** Waits for the file to be written. For shutdown and tests. */
  async flush(): Promise<void> {
    await this.store.flush();
  }

  private async resumeFor(
    session: SessionInfo,
  ): Promise<{ agent: ResumableAgent; sessionId: string } | null> {
    const announced = this.host.agentSession(session.id);
    if (announced) return announced;
    const agent = resumableAgentOf(this.safeTemplate(session.templateId));
    if (!agent) return null;
    const cwds = [session.currentCwd, session.originalCwd].filter(
      (c, i, all) => c && all.indexOf(c) === i,
    );
    const find = this.host.findResumeId ?? findAgentSessionId;
    const id = await find({
      agent,
      homeDir: this.host.homeDir ?? homedir(),
      cwds,
      since: session.createdAt,
      until: this.host.lastActivityAt(session.id) || this.now(),
    });
    return id ? { agent, sessionId: id } : null;
  }

  private safeTemplate(templateId: string): Pick<Template, 'id' | 'command'> {
    try {
      return this.host.template(templateId);
    } catch {
      return { id: templateId, command: '' };
    }
  }

  private persist(): void {
    this.store.set({ version: 1, entries: this.entries });
  }

  private emitChanged(shelvedSessionId?: string): void {
    const payload: ShelfChangedPayload = {
      entries: this.list(),
      ...(shelvedSessionId ? { shelvedSessionId } : {}),
    };
    this.emit('changed', payload);
  }

  private now(): number {
    return this.host.now ? this.host.now() : Date.now();
  }
}
