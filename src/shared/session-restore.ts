/**
 * @file src/shared/session-restore.ts
 * @purpose Rules for reopening the tabs Ceteris had open when it last stopped (ADR-039).
 *   Main keeps restore.json up to date while the app runs; the next launch reads it and
 *   reopens each tab, agents with the id that resumes their own conversation.
 *
 * @关键设计:
 * - Pure functions only, so every rule is unit tested here. The file, timers and spawning
 *   live in src/main/session-restore.ts.
 * - Only two kinds of tab start again on their own: a plain shell (template command empty)
 *   and a built-in agent (claude, codex, opencode, ...). A custom template may run anything,
 *   an SSH tab may ask for a password, and the Admin Shell asks for elevation; those wait in
 *   the shelf (ADR-036) for one click instead of running unasked at launch.
 * - Claude Code and Codex resume only by exact id (`--resume <id>`, `resume <id>`) whose
 *   transcript main has checked; without one they start fresh. Never "the latest in this
 *   folder": several tabs often share a folder, and with no conversation there the flag fails.
 *   A failed flag does not end the tab, because agents run in a shell that stays open
 *   (-NoExit), so the tab would sit at a bare prompt.
 * - Other built-in agents have no id to check; they get the folder-wide flags (ADR-037) only
 *   when the tab was the one tab of that agent in that folder.
 * - The tab a window was showing comes back in the first window. With several shown tabs,
 *   the one the user pressed Enter in last wins.
 *
 * @对应文档章节:软件定义书.md ADR-039 (relaxes ADR-004), ADR-036, ADR-037
 *
 * @不要在这里做的事:
 * - No file system, timers or Electron here.
 * - Do not decide here whether the feature is on; main reads behavior.restoreTabsOnLaunch.
 */
import { isAgentTemplate } from './agent-title';
import { resumeArgs, type ResumableAgent } from './shelf';
import { SESSION_ROLES, type SessionRole } from './session-role';
import type { SessionInfo, Template } from './types';

/** One tab as it was when Ceteris last saved. Plain JSON, it lives in restore.json. */
export interface RestoreTab {
  pathId: string;
  templateId: string;
  displayName: string;
  /** The user renamed it, or an agent tab whose title is worth keeping */
  keepName: boolean;
  role: SessionRole | null;
  /** Working directory at save time; with originalCwd, where to look for transcripts */
  cwd: string;
  originalCwd: string;
  /** Unix ms */
  createdAt: number;
  /** Unix ms of the last output, key press or exit */
  lastActivityAt: number;
  /** Unix ms of the last Enter, 0 if never; picks the tab the first window shows */
  lastEnterAt: number;
  /** A window was showing this tab */
  shown: boolean;
  /** The id the agent announced (ceteris-tabs hook); null means look it up at launch */
  resume: { agent: ResumableAgent; sessionId: string } | null;
}

export interface RestoreFile {
  version: 1;
  /** Unix ms of the last save */
  savedAt: number;
  tabs: RestoreTab[];
}

/** A launch never reopens more than this many tabs; the oldest past the cap are dropped. */
export const RESTORE_MAX_TABS = 60;

/** How long after the last change main waits before writing restore.json. */
export const RESTORE_SAVE_DEBOUNCE_MS = 1_000;

/** Main also saves this often, to pick up agent ids and activity times that emit no event. */
export const RESTORE_SAVE_INTERVAL_MS = 60_000;

/** Built-in templates that resume by id only (see launchArgs). */
const ID_RESUMED_TEMPLATES: readonly string[] = ['claude-code', 'codex'];

export const EMPTY_RESTORE_FILE: RestoreFile = { version: 1, savedAt: 0, tabs: [] };

/**
 * What a launch does with a saved tab.
 * - 'launch': start it again now
 * - 'shelf': put it in the shelf, the user starts it with a click
 * - 'skip': its template is gone, nothing to start
 */
export type RestoreKind = 'launch' | 'shelf' | 'skip';

/**
 * @param template the tab's template now, or null when it was deleted
 * @param isSshPath the tab's folder is on an SSH host
 */
export function restoreKind(
  template: Pick<Template, 'id' | 'command' | 'isBuiltin'> | null,
  isSshPath: boolean,
): RestoreKind {
  if (!template) return 'skip';
  if (isSshPath) return 'shelf';
  if (template.command.trim() === '') return 'launch';
  if (template.isBuiltin && isAgentTemplate(template.id)) return 'launch';
  return 'shelf';
}

/**
 * Arguments appended to the template's own when the tab starts again.
 *
 * @param tab the saved tab, with `resume` already filled in when an id was found
 * @param tabs every saved tab, to tell whether this one was alone in its folder
 * @param folderResumeArgs per template id, the flags that resume the latest conversation in
 *   the folder (agent-reload.ts RESUME_ARGS)
 */
export function launchArgs(
  tab: RestoreTab,
  tabs: readonly RestoreTab[],
  folderResumeArgs: Readonly<Record<string, readonly string[]>>,
): string[] {
  if (tab.resume) return resumeArgs(tab.resume.agent, tab.resume.sessionId);
  // No checked id: a folder-wide flag could fail (bare shell prompt) or take another tab's chat.
  if (ID_RESUMED_TEMPLATES.includes(tab.templateId)) return [];
  const fallback = folderResumeArgs[tab.templateId];
  if (!fallback) return [];
  const sameFolder = tabs.filter(
    (t) => t.templateId === tab.templateId && t.pathId === tab.pathId,
  ).length;
  return sameFolder === 1 ? [...fallback] : [];
}

/** Index of the tab the first window should show, or -1 when no window showed one. */
export function pickFocusTab(tabs: readonly RestoreTab[]): number {
  let best = -1;
  for (let i = 0; i < tabs.length; i++) {
    const t = tabs[i]!;
    if (!t.shown) continue;
    if (best < 0) {
      best = i;
      continue;
    }
    const b = tabs[best]!;
    const tKey = Math.max(t.lastEnterAt, t.lastActivityAt);
    const bKey = Math.max(b.lastEnterAt, b.lastActivityAt);
    if (t.lastEnterAt > b.lastEnterAt || (t.lastEnterAt === b.lastEnterAt && tKey > bKey)) {
      best = i;
    }
  }
  return best;
}

/** Whether a live session belongs in restore.json: not exited and not already gone. */
export function isRestorable(session: Pick<SessionInfo, 'state'>): boolean {
  return session.state !== 'exited';
}

/**
 * Accepts restore.json from disk. Tabs missing required fields are dropped one by one, so a
 * single bad entry never loses the rest. Keeps the newest RESTORE_MAX_TABS by creation time.
 */
export function sanitizeRestoreFile(raw: unknown): RestoreFile {
  if (!raw || typeof raw !== 'object') return { ...EMPTY_RESTORE_FILE, tabs: [] };
  const r = raw as { savedAt?: unknown; tabs?: unknown };
  const out: RestoreFile = {
    version: 1,
    savedAt: typeof r.savedAt === 'number' ? r.savedAt : 0,
    tabs: [],
  };
  if (!Array.isArray(r.tabs)) return out;
  for (const t of r.tabs) {
    if (!t || typeof t !== 'object') continue;
    const x = t as Record<string, unknown>;
    if (
      typeof x.pathId !== 'string' ||
      x.pathId === '' ||
      typeof x.templateId !== 'string' ||
      x.templateId === '' ||
      typeof x.createdAt !== 'number'
    ) {
      continue;
    }
    const rr = x.resume as Record<string, unknown> | null | undefined;
    const resume =
      rr &&
      typeof rr === 'object' &&
      (rr.agent === 'claude-code' || rr.agent === 'codex') &&
      typeof rr.sessionId === 'string' &&
      rr.sessionId !== ''
        ? { agent: rr.agent as ResumableAgent, sessionId: rr.sessionId }
        : null;
    const role =
      typeof x.role === 'string' && (SESSION_ROLES as readonly string[]).includes(x.role)
        ? (x.role as SessionRole)
        : null;
    const num = (v: unknown, d: number): number =>
      typeof v === 'number' && Number.isFinite(v) ? v : d;
    out.tabs.push({
      pathId: x.pathId,
      templateId: x.templateId,
      displayName: typeof x.displayName === 'string' ? x.displayName : '',
      keepName: x.keepName === true,
      role,
      cwd: typeof x.cwd === 'string' ? x.cwd : '',
      originalCwd: typeof x.originalCwd === 'string' ? x.originalCwd : '',
      createdAt: x.createdAt,
      lastActivityAt: num(x.lastActivityAt, x.createdAt),
      lastEnterAt: num(x.lastEnterAt, 0),
      shown: x.shown === true,
      resume,
    });
  }
  out.tabs.sort((a, b) => a.createdAt - b.createdAt);
  if (out.tabs.length > RESTORE_MAX_TABS) out.tabs = out.tabs.slice(-RESTORE_MAX_TABS);
  return out;
}
