/**
 * @file src/shared/shelf.ts
 * @purpose The tab shelf (ADR-036): rules shared by main and the windows for putting idle tabs
 *   away. A shelved tab's process is gone, but its name, folder, template and, for Claude Code
 *   and Codex, the id that resumes its conversation are kept in the shelf. The box at the left
 *   end of the tab row lists them; a click opens the tab again.
 *
 * @关键设计:
 * - Pure functions only, so the rules are unit tested here and both processes agree on them.
 * - "Idle for N hours" means no PTY output, no key press and no exit for N hours. Working
 *   agents, tabs with a role and the tab a window is showing are never shelved: those are
 *   either doing something or in front of the user.
 * - Resuming is a command line, never a saved screen: `claude --resume <id>` and
 *   `codex resume <id>` rebuild the conversation from the agent's own files.
 *
 * @对应文档章节:软件定义书.md ADR-036, 8.3
 *
 * @不要在这里做的事:
 * - No file system or timers here; agent-resume.ts reads the agents' files, shelf-manager.ts
 *   runs the sweep.
 */
import type { SessionInfo, Template } from './types';

/** Agents whose conversation a shelved tab can pick up again. */
export type ResumableAgent = 'claude-code' | 'codex';

/** One tab in the shelf. Persisted in shelf.json, so every field is plain JSON. */
export interface ShelfEntry {
  /** UUID of the shelf entry, not the old session id */
  id: string;
  /** Session id the tab had. Only for logs and tests. */
  sessionId: string;
  pathId: string;
  templateId: string;
  displayName: string;
  /** Working directory the tab had when shelved; the restored tab starts in its folder */
  cwd: string;
  /** Unix ms */
  createdAt: number;
  /** Unix ms of the last output, key press or exit before shelving */
  lastActivityAt: number;
  /** Unix ms */
  shelvedAt: number;
  /** 'auto' after the idle timeout, 'manual' from the tab menu */
  reason: 'auto' | 'manual';
  /** Set when the agent's conversation can be resumed */
  resume: { agent: ResumableAgent; sessionId: string } | null;
}

export interface ShelfFile {
  version: 1;
  entries: ShelfEntry[];
}

/** The shelf never grows past this; the oldest entries fall off the end. */
export const SHELF_MAX_ENTRIES = 100;

/** Choices for Settings, Behavior, Shelve idle tabs, in hours. 0 is off. */
export const SHELVE_AFTER_HOURS_CHOICES: readonly number[] = [0, 1, 3, 5, 24, 72, 120];

/** Largest value settings accept, so a hand-edited file cannot overflow a timer. */
export const SHELVE_AFTER_HOURS_MAX = 24 * 30;

/** How often main looks for tabs to shelve. */
export const SHELF_SWEEP_MS = 60_000;

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Why a session may not be shelved right now, or null when it may.
 *
 * @param session the session as the windows see it
 * @param lastActivityAt Unix ms of its last output, key press or exit (SessionManager)
 * @param now Unix ms
 * @param afterMs idle time required; 0 or less means the feature is off
 */
export function shelveBlocker(
  session: SessionInfo,
  lastActivityAt: number,
  now: number,
  afterMs: number,
): 'off' | 'role' | 'on-screen' | 'busy' | 'recent' | null {
  if (afterMs <= 0) return 'off';
  if (session.coordinator || session.role) return 'role';
  if (session.ownerWindowId !== null) return 'on-screen';
  if (session.state === 'active' || session.agentPhase === 'working') return 'busy';
  if (now - lastActivityAt < afterMs) return 'recent';
  return null;
}

/** The sessions the sweep would shelve now, in creation order. */
export function pickShelvable(
  sessions: readonly SessionInfo[],
  lastActivityAt: (sessionId: string) => number,
  now: number,
  afterMs: number,
): SessionInfo[] {
  return sessions
    .filter((s) => shelveBlocker(s, lastActivityAt(s.id), now, afterMs) === null)
    .sort((a, b) => a.createdAt - b.createdAt);
}

/** The program name without directory or .exe / .cmd, for matching a template's command. */
function programName(command: string): string {
  const base = command.trim().replace(/^.*[\\/]/, '');
  return base.replace(/\.(exe|cmd|bat|ps1)$/i, '').toLowerCase();
}

/**
 * Which agent a template starts, when it is one whose conversation can be resumed.
 * The built-in ids count, and so does any template whose command is the agent's program.
 */
export function resumableAgentOf(
  template: Pick<Template, 'id' | 'command'>,
): ResumableAgent | null {
  if (template.id === 'claude-code') return 'claude-code';
  if (template.id === 'codex') return 'codex';
  const name = programName(template.command);
  if (name === 'claude') return 'claude-code';
  if (name === 'codex') return 'codex';
  return null;
}

/** Arguments appended to the template's own when the tab comes back with its conversation. */
export function resumeArgs(agent: ResumableAgent, agentSessionId: string): string[] {
  switch (agent) {
    case 'claude-code':
      return ['--resume', agentSessionId];
    case 'codex':
      return ['resume', agentSessionId];
  }
}

/**
 * The folder under ~/.claude/projects that holds a working directory's transcripts: every
 * character outside A-Z, a-z and 0-9 becomes a dash. Matches Claude Code's own encoding,
 * for example `C:\Users\me\work` becomes `C--Users-me-work`.
 */
export function claudeProjectSlug(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

/** Adds an entry at the front and trims the oldest past the cap. Returns a new array. */
export function pushEntry(entries: readonly ShelfEntry[], entry: ShelfEntry): ShelfEntry[] {
  return [entry, ...entries].slice(0, SHELF_MAX_ENTRIES);
}

/**
 * Accepts a shelf file from disk. Entries missing required fields are dropped rather than
 * failing the whole file, so one bad line never hides the rest.
 */
export function sanitizeShelfFile(raw: unknown): ShelfFile {
  const out: ShelfFile = { version: 1, entries: [] };
  if (!raw || typeof raw !== 'object') return out;
  const entries = (raw as { entries?: unknown }).entries;
  if (!Array.isArray(entries)) return out;
  for (const e of entries) {
    if (!e || typeof e !== 'object') continue;
    const r = e as Record<string, unknown>;
    if (
      typeof r.id !== 'string' ||
      typeof r.pathId !== 'string' ||
      typeof r.templateId !== 'string' ||
      typeof r.displayName !== 'string' ||
      typeof r.cwd !== 'string' ||
      typeof r.shelvedAt !== 'number'
    ) {
      continue;
    }
    const resumeRaw = r.resume as Record<string, unknown> | null | undefined;
    const resume =
      resumeRaw &&
      typeof resumeRaw === 'object' &&
      (resumeRaw.agent === 'claude-code' || resumeRaw.agent === 'codex') &&
      typeof resumeRaw.sessionId === 'string'
        ? { agent: resumeRaw.agent as ResumableAgent, sessionId: resumeRaw.sessionId }
        : null;
    out.entries.push({
      id: r.id,
      sessionId: typeof r.sessionId === 'string' ? r.sessionId : '',
      pathId: r.pathId,
      templateId: r.templateId,
      displayName: r.displayName,
      cwd: r.cwd,
      createdAt: typeof r.createdAt === 'number' ? r.createdAt : r.shelvedAt,
      lastActivityAt: typeof r.lastActivityAt === 'number' ? r.lastActivityAt : r.shelvedAt,
      shelvedAt: r.shelvedAt,
      reason: r.reason === 'manual' ? 'manual' : 'auto',
      resume,
    });
    if (out.entries.length >= SHELF_MAX_ENTRIES) break;
  }
  return out;
}
