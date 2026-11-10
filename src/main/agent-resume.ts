/**
 * @file src/main/agent-resume.ts
 * @purpose Finds the id that resumes an agent's conversation when the agent never told us
 *   (ADR-036). Claude Code and Codex each write one transcript file per conversation; the
 *   newest file for the tab's folder that was last written while the tab was alive is the
 *   tab's conversation.
 *
 * @关键设计:
 * - Claude Code: ~/.claude/projects/<slug of cwd>/<uuid>.jsonl, slug from claudeProjectSlug.
 *   The tab's current and original directories are both tried, since the user may cd before
 *   starting claude.
 * - Codex: ~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<uuid>.jsonl; the first line is a
 *   session_meta record whose payload has id and cwd. Only the day folders between the tab's
 *   creation and its last activity are read.
 * - A candidate must have been modified after the tab was created and no later than a minute
 *   after its last activity. Two tabs of the same agent in one folder are told apart by that
 *   window: the idle tab's file stopped changing when the tab did, the busy tab's did not.
 *   The newest candidate wins.
 * - The announced id (ceteris-tabs SessionStart hook) always beats this guess; the caller
 *   only comes here without one.
 *
 * @对应文档章节:软件定义书.md ADR-036
 *
 * @不要在这里做的事:
 * - Do not parse whole transcripts; the first line of a Codex file is enough and Claude Code
 *   file names already are the id.
 * - Do not resume anything here; this only finds the id.
 */
import { open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { claudeProjectSlug, UUID_PATTERN, type ResumableAgent } from '@shared/shelf';
import { logger } from './logger';

/** A file written this long after the last output still counts as the tab's own. */
export const RESUME_MATCH_SLACK_MS = 60_000;

/** How much of a Codex transcript's first line is read to find its cwd. */
const CODEX_HEAD_BYTES = 256 * 1024;

export interface ResumeLookup {
  agent: ResumableAgent;
  /** The user's home, where .claude and .codex live */
  homeDir: string;
  /** Directories the tab may have started the agent in, most likely first */
  cwds: string[];
  /** Unix ms the tab was created */
  since: number;
  /** Unix ms of the tab's last output, key press or exit */
  until: number;
}

interface Candidate {
  id: string;
  mtimeMs: number;
}

function inWindow(mtimeMs: number, lookup: ResumeLookup): boolean {
  return mtimeMs >= lookup.since && mtimeMs <= lookup.until + RESUME_MATCH_SLACK_MS;
}

function newest(candidates: Candidate[]): string | null {
  let best: Candidate | null = null;
  for (const c of candidates) {
    if (!best || c.mtimeMs > best.mtimeMs) best = c;
  }
  return best?.id ?? null;
}

/** Path comparison that ignores slash direction and, on Windows, case. */
export function sameDirectory(a: string, b: string): boolean {
  const norm = (p: string): string => {
    let s = p.replace(/[\\/]+/g, '/').replace(/\/+$/, '');
    if (process.platform === 'win32') s = s.toLowerCase();
    return s;
  };
  return norm(a) === norm(b);
}

/**
 * The resume id of the tab's conversation, or null when no transcript matches.
 * Never throws: a missing folder or an unreadable file just means no match.
 */
export async function findAgentSessionId(lookup: ResumeLookup): Promise<string | null> {
  try {
    return lookup.agent === 'claude-code'
      ? await findClaudeSession(lookup)
      : await findCodexSession(lookup);
  } catch (err) {
    logger.warn('AgentResume', `lookup failed agent=${lookup.agent}`, err);
    return null;
  }
}

async function findClaudeSession(lookup: ResumeLookup): Promise<string | null> {
  const candidates: Candidate[] = [];
  const seenSlugs = new Set<string>();
  for (const cwd of lookup.cwds) {
    const slug = claudeProjectSlug(cwd);
    if (seenSlugs.has(slug)) continue;
    seenSlugs.add(slug);
    const dir = join(lookup.homeDir, '.claude', 'projects', slug);
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const id = name.slice(0, -'.jsonl'.length);
      if (!UUID_PATTERN.test(id)) continue;
      let mtimeMs: number;
      try {
        const s = await stat(join(dir, name));
        if (!s.isFile()) continue;
        mtimeMs = s.mtimeMs;
      } catch {
        continue;
      }
      if (inWindow(mtimeMs, lookup)) candidates.push({ id, mtimeMs });
    }
  }
  return newest(candidates);
}

/** YYYY/MM/DD folders, local time, from the day of `since` to the day of `until`. */
export function codexDayFolders(since: number, until: number): string[] {
  const out: string[] = [];
  const day = new Date(since);
  day.setHours(0, 0, 0, 0);
  const end = new Date(until + RESUME_MATCH_SLACK_MS);
  end.setHours(0, 0, 0, 0);
  // Cap the walk at a year; a tab older than that is not worth a long scan.
  for (let i = 0; i < 366 && day.getTime() <= end.getTime(); i++) {
    const y = day.getFullYear();
    const m = String(day.getMonth() + 1).padStart(2, '0');
    const d = String(day.getDate()).padStart(2, '0');
    out.push(join(String(y), m, d));
    day.setDate(day.getDate() + 1);
  }
  return out;
}

/** Reads id and cwd from the first line of a Codex rollout file, or null. */
export async function readCodexMeta(path: string): Promise<{ id: string; cwd: string } | null> {
  let text: string;
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(CODEX_HEAD_BYTES);
    const { bytesRead } = await fh.read(buf, 0, CODEX_HEAD_BYTES, 0);
    text = buf.subarray(0, bytesRead).toString('utf8');
  } finally {
    await fh.close();
  }
  const nl = text.indexOf('\n');
  const line = nl >= 0 ? text.slice(0, nl) : text;
  try {
    const parsed = JSON.parse(line) as {
      type?: unknown;
      payload?: { id?: unknown; session_id?: unknown; cwd?: unknown };
    };
    if (parsed.type !== 'session_meta' || !parsed.payload) return null;
    const id = parsed.payload.id ?? parsed.payload.session_id;
    const cwd = parsed.payload.cwd;
    return typeof id === 'string' && typeof cwd === 'string' ? { id, cwd } : null;
  } catch {
    // The first line did not fit in the head read (a very long base_instructions field).
    // The id and cwd come early in the record, so pull them out of the text directly.
    const id = /"id":"([0-9a-f-]{36})"/i.exec(line)?.[1];
    const cwdMatch = /"cwd":("(?:[^"\\]|\\.)*")/.exec(line)?.[1];
    if (!id || !cwdMatch) return null;
    try {
      return { id, cwd: JSON.parse(cwdMatch) as string };
    } catch {
      return null;
    }
  }
}

async function findCodexSession(lookup: ResumeLookup): Promise<string | null> {
  const root = join(lookup.homeDir, '.codex', 'sessions');
  const candidates: Candidate[] = [];
  for (const folder of codexDayFolders(lookup.since, lookup.until)) {
    const dir = join(root, folder);
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.startsWith('rollout-') || !name.endsWith('.jsonl')) continue;
      const path = join(dir, name);
      let mtimeMs: number;
      try {
        const s = await stat(path);
        if (!s.isFile()) continue;
        mtimeMs = s.mtimeMs;
      } catch {
        continue;
      }
      if (!inWindow(mtimeMs, lookup)) continue;
      let meta: { id: string; cwd: string } | null;
      try {
        meta = await readCodexMeta(path);
      } catch {
        continue;
      }
      if (!meta || !UUID_PATTERN.test(meta.id)) continue;
      if (!lookup.cwds.some((cwd) => sameDirectory(cwd, meta!.cwd))) continue;
      candidates.push({ id: meta.id, mtimeMs });
    }
  }
  return newest(candidates);
}
