/**
 * @file src/main/agent-usage.ts
 * @purpose Usage of a Claude Code or Codex tab for the tab's model menu (ADR-038): model,
 *   effort, context, 5 hour and weekly limits, and the details (prompts, tool calls, todos).
 *   Also the Codex model list from ~/.codex/models_cache.json.
 *
 * @关键设计:
 * - Read only. Ceteris never writes into ~/.claude, ~/.codex or a folder's .omc.
 * - Which file belongs to which tab:
 *   - Claude Code: tabs started by Ceteris get `--session-id <uuid>` (session-manager), so the
 *     transcript is ~/.claude/projects/<cwd with every non letter or digit as "-">/<uuid>.jsonl.
 *     Tabs without an id (reopened with --continue, or claude typed into a shell) take the
 *     newest transcript of that folder written since the tab opened and not held by another tab.
 *   - Codex: no launch id flag, so ~/.codex/sessions/Y/M/D/rollout-*.jsonl files whose
 *     session_meta cwd is the tab's folder, written since the tab opened. A rollout started
 *     after the tab opened wins (earliest first, so two tabs opened together each get their
 *     own); otherwise the newest one (a resumed session keeps its old file).
 *   - Once found, a file stays with its tab. Other tabs skip it.
 * - Claude Code limits are not in the transcript. The OMC HUD caches Claude Code's statusline
 *   input at <cwd>/.omc/state/sessions/<id>/hud-stdin-cache.json, which has them, plus the
 *   context window size and cost. Without OMC, 5h and wk stay empty and context shows tokens.
 *   Limits are per account, so another session's cache in the same folder is used as well.
 * - Files are read incrementally: each poll reads only the bytes added since the last one.
 *
 * @对应文档章节: 软件定义书.md ADR-038
 *
 * @不要在这里做的事:
 * - No calls to any network API, and no reading of credentials.
 * - No guessing from the terminal screen; the screen belongs to agent-phase.
 */

import { open, readdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { AgentUsage, ModelAgent, ModelChoice, UsageWindow } from '@shared/agent-model';
import { CODEX_FALLBACK_EFFORTS } from '@shared/agent-model';
import { logger } from './logger';

/** Rollout files whose first bytes hold the session_meta cwd */
const META_PEEK_BYTES = 16 * 1024;
/** Clock slack between the tab opening and the agent writing its first line */
const SINCE_SLACK_MS = 3_000;
/** Codex day folders to look through, newest first */
const CODEX_DAY_DIRS = 3;
/** How many parent folders to search for an OMC .omc folder (OMC uses the git top level) */
const OMC_ANCESTOR_LEVELS = 12;

// ──────────────────────────────────────────────────────────────────
// Locating files
// ──────────────────────────────────────────────────────────────────

/** Claude Code's project folder for a cwd: every character but A-Z a-z 0-9 becomes "-". */
export function claudeProjectDir(claudeDir: string, cwd: string): string {
  return join(claudeDir, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
}

function sameDir(a: string, b: string): boolean {
  const norm = (p: string): string => p.replace(/[\\/]+$/, '').replace(/\//g, '\\');
  return process.platform === 'win32' || process.platform === 'darwin'
    ? norm(a).toLowerCase() === norm(b).toLowerCase()
    : norm(a) === norm(b);
}

async function mtimeOf(file: string): Promise<number | null> {
  try {
    return (await stat(file)).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * The transcript of a Claude Code tab, or null when the agent has not written one yet.
 * With a launch id only that file counts, so a fresh tab never shows another tab's numbers.
 */
export async function findClaudeTranscript(input: {
  claudeDir: string;
  cwd: string;
  launchId?: string;
  since: number;
  claimed: ReadonlySet<string>;
}): Promise<string | null> {
  const dir = claudeProjectDir(input.claudeDir, input.cwd);
  if (input.launchId) {
    const file = join(dir, `${input.launchId}.jsonl`);
    return (await mtimeOf(file)) !== null ? file : null;
  }
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return null;
  }
  let best: { file: string; mtime: number } | null = null;
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    const file = join(dir, name);
    if (input.claimed.has(file)) continue;
    const mtime = await mtimeOf(file);
    if (mtime === null || mtime < input.since - SINCE_SLACK_MS) continue;
    if (!best || mtime > best.mtime) best = { file, mtime };
  }
  return best?.file ?? null;
}

/** First bytes of a rollout file: the session_meta cwd and start time. */
async function peekCodexMeta(file: string): Promise<{ cwd: string; startedAt: number } | null> {
  let handle;
  try {
    handle = await open(file, 'r');
    const buf = Buffer.alloc(META_PEEK_BYTES);
    const { bytesRead } = await handle.read(buf, 0, META_PEEK_BYTES, 0);
    const head = buf.subarray(0, bytesRead).toString('utf8');
    if (!head.includes('"session_meta"')) return null;
    const cwdMatch = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(head);
    const tsMatch = /"payload":\{.*?"timestamp":"([^"]+)"/.exec(head);
    if (!cwdMatch) return null;
    const cwd = JSON.parse(`"${cwdMatch[1]}"`) as string;
    const startedAt = tsMatch ? Date.parse(tsMatch[1]!) : NaN;
    return { cwd, startedAt: Number.isFinite(startedAt) ? startedAt : 0 };
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** The newest few day folders under ~/.codex/sessions, newest first. */
async function codexDayDirs(codexDir: string): Promise<string[]> {
  const root = join(codexDir, 'sessions');
  const out: string[] = [];
  const sortedDesc = async (dir: string): Promise<string[]> => {
    try {
      return (await readdir(dir))
        .filter((n) => /^\d+$/.test(n))
        .sort()
        .reverse();
    } catch {
      return [];
    }
  };
  for (const y of await sortedDesc(root)) {
    for (const m of await sortedDesc(join(root, y))) {
      for (const d of await sortedDesc(join(root, y, m))) {
        out.push(join(root, y, m, d));
        if (out.length >= CODEX_DAY_DIRS) return out;
      }
    }
  }
  return out;
}

/** The rollout file of a Codex tab, or null. See the file header for the rules. */
export async function findCodexRollout(input: {
  codexDir: string;
  cwd: string;
  since: number;
  claimed: ReadonlySet<string>;
}): Promise<string | null> {
  const fresh: Array<{ file: string; startedAt: number }> = [];
  const resumed: Array<{ file: string; mtime: number }> = [];
  for (const dir of await codexDayDirs(input.codexDir)) {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.startsWith('rollout-') || !name.endsWith('.jsonl')) continue;
      const file = join(dir, name);
      if (input.claimed.has(file)) continue;
      const mtime = await mtimeOf(file);
      if (mtime === null || mtime < input.since - SINCE_SLACK_MS) continue;
      const meta = await peekCodexMeta(file);
      if (!meta || !sameDir(meta.cwd, input.cwd)) continue;
      if (meta.startedAt >= input.since - SINCE_SLACK_MS)
        fresh.push({ file, startedAt: meta.startedAt });
      else resumed.push({ file, mtime });
    }
  }
  fresh.sort((a, b) => a.startedAt - b.startedAt);
  if (fresh[0]) return fresh[0].file;
  resumed.sort((a, b) => b.mtime - a.mtime);
  return resumed[0]?.file ?? null;
}

// ──────────────────────────────────────────────────────────────────
// Reading files incrementally
// ──────────────────────────────────────────────────────────────────

export type Json = Record<string, unknown>;

function obj(v: unknown): Json | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null;
}
function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}
function timeOf(entry: Json): number | undefined {
  const t = typeof entry['timestamp'] === 'string' ? Date.parse(entry['timestamp']) : NaN;
  return Number.isFinite(t) ? t : undefined;
}

/** Running totals over a Claude Code transcript */
export class ClaudeTally {
  startedAt?: number | undefined;
  lastPromptAt?: number | undefined;
  prompts = 0;
  toolCalls = 0;
  agentCalls = 0;
  skillCalls = 0;
  lastSkill?: string | undefined;
  todos?: { done: number; total: number };
  modelId?: string | undefined;
  contextTokens?: number | undefined;

  feed(entry: Json): void {
    if (entry['isSidechain'] === true) return;
    const at = timeOf(entry);
    if (at !== undefined && this.startedAt === undefined) this.startedAt = at;
    const message = obj(entry['message']);
    if (!message) return;
    if (entry['type'] === 'user' && entry['isMeta'] !== true && isTypedPrompt(message['content'])) {
      this.prompts++;
      if (at !== undefined) this.lastPromptAt = at;
    }
    if (entry['type'] !== 'assistant') return;
    const model = str(message['model']);
    if (model && model !== '<synthetic>') this.modelId = model;
    const usage = obj(message['usage']);
    if (usage) {
      const total =
        (num(usage['input_tokens']) ?? 0) +
        (num(usage['cache_creation_input_tokens']) ?? 0) +
        (num(usage['cache_read_input_tokens']) ?? 0);
      if (total > 0) this.contextTokens = total;
    }
    const content = Array.isArray(message['content']) ? message['content'] : [];
    for (const part of content) {
      const p = obj(part);
      if (!p || p['type'] !== 'tool_use') continue;
      const name = str(p['name']) ?? '';
      const input = obj(p['input']) ?? {};
      if (name === 'Task' || name === 'Agent') this.agentCalls++;
      else if (name === 'Skill') {
        this.skillCalls++;
        this.lastSkill = str(input['skill']) ?? str(input['command']) ?? this.lastSkill;
      } else this.toolCalls++;
      if (name === 'TodoWrite' && Array.isArray(input['todos'])) {
        const todos = input['todos'] as unknown[];
        this.todos = {
          done: todos.filter((t) => obj(t)?.['status'] === 'completed').length,
          total: todos.length,
        };
      }
    }
  }
}

/** A prompt the user typed, not a tool result, a slash command echo or an injected note. */
function isTypedPrompt(content: unknown): boolean {
  if (typeof content === 'string') return content.length > 0 && !content.startsWith('<');
  if (!Array.isArray(content)) return false;
  let text = false;
  for (const part of content) {
    const p = obj(part);
    if (!p) continue;
    if (p['type'] === 'tool_result') return false;
    if (p['type'] === 'text' && typeof p['text'] === 'string' && !p['text'].startsWith('<'))
      text = true;
    if (p['type'] === 'image') text = true;
  }
  return text;
}

/** Running totals over a Codex rollout */
export class CodexTally {
  startedAt?: number | undefined;
  lastPromptAt?: number | undefined;
  prompts = 0;
  toolCalls = 0;
  model?: string | undefined;
  effort?: string | undefined;
  contextTokens?: number | undefined;
  windowTokens?: number | undefined;
  fiveHour?: UsageWindow | undefined;
  weekly?: UsageWindow | undefined;

  feed(entry: Json): void {
    const at = timeOf(entry);
    const payload = obj(entry['payload']) ?? {};
    switch (entry['type']) {
      case 'session_meta': {
        const ts =
          typeof payload['timestamp'] === 'string' ? Date.parse(payload['timestamp']) : NaN;
        this.startedAt = Number.isFinite(ts) ? ts : at;
        return;
      }
      case 'turn_context':
        this.model = str(payload['model']) ?? this.model;
        this.effort = str(payload['effort']) ?? str(payload['reasoning_effort']) ?? this.effort;
        return;
      case 'response_item': {
        const t = str(payload['type']) ?? '';
        if (t.endsWith('_call')) this.toolCalls++;
        return;
      }
      case 'event_msg':
        if (payload['type'] === 'task_started') {
          this.prompts++;
          if (at !== undefined) this.lastPromptAt = at;
        } else if (payload['type'] === 'token_count') this.feedTokens(payload);
        return;
      default:
    }
  }

  private feedTokens(payload: Json): void {
    const info = obj(payload['info']);
    const last = obj(info?.['last_token_usage']);
    const total = num(last?.['total_tokens']);
    if (total !== undefined) this.contextTokens = total;
    this.windowTokens = num(info?.['model_context_window']) ?? this.windowTokens;
    const limits = obj(payload['rate_limits']);
    if (!limits) return;
    for (const key of ['primary', 'secondary']) {
      const w = obj(limits[key]);
      const used = num(w?.['used_percent']);
      if (!w || used === undefined) continue;
      const resets = num(w['resets_at']);
      const win: UsageWindow = {
        usedPercent: used,
        ...(resets ? { resetsAt: resets * 1000 } : {}),
      };
      const minutes = num(w['window_minutes']) ?? (key === 'primary' ? 300 : 10080);
      if (minutes <= 24 * 60) this.fiveHour = win;
      else this.weekly = win;
    }
  }
}

export interface Cursor<T> {
  offset: number;
  /** A line cut off at the end of the last read */
  partial: string;
  /** Keeps a UTF-8 character split between two reads whole */
  decoder: StringDecoder;
  tally: T;
}

/** Bytes read per step, so a transcript of hundreds of MB never becomes one string */
const READ_CHUNK_BYTES = 4 * 1024 * 1024;

/**
 * Feeds the bytes added since the last read into the tally, in chunks. A file that shrank
 * (rewritten) starts over. Lines that are not JSON are skipped.
 */
export async function advance<T extends { feed(entry: Json): void }>(
  file: string,
  cursors: Map<string, Cursor<T>>,
  make: () => T,
  chunkBytes = READ_CHUNK_BYTES,
): Promise<T> {
  const size = (await stat(file)).size;
  let cursor = cursors.get(file);
  if (!cursor || size < cursor.offset) {
    cursor = { offset: 0, partial: '', decoder: new StringDecoder('utf8'), tally: make() };
    cursors.set(file, cursor);
  }
  if (size === cursor.offset) return cursor.tally;
  const handle = await open(file, 'r');
  try {
    const buf = Buffer.alloc(Math.min(chunkBytes, size - cursor.offset));
    while (cursor.offset < size) {
      const want = Math.min(buf.length, size - cursor.offset);
      const { bytesRead } = await handle.read(buf, 0, want, cursor.offset);
      if (bytesRead === 0) break;
      cursor.offset += bytesRead;
      const lines = (cursor.partial + cursor.decoder.write(buf.subarray(0, bytesRead))).split('\n');
      cursor.partial = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const entry = obj(JSON.parse(line));
          if (entry) cursor.tally.feed(entry);
        } catch {
          // half written or foreign line: skip
        }
      }
    }
  } finally {
    await handle.close();
  }
  return cursor.tally;
}

// ──────────────────────────────────────────────────────────────────
// OMC statusline cache (Claude Code limits)
// ──────────────────────────────────────────────────────────────────

export interface ClaudeStatusline {
  modelName?: string;
  effort?: string;
  contextPercent?: number;
  windowTokens?: number;
  fiveHour?: UsageWindow;
  weekly?: UsageWindow;
  costUsd?: number;
  /** mtime of the cache file */
  at: number;
}

function parseStatusline(json: Json, at: number): ClaudeStatusline {
  const model = obj(json['model']);
  const effort = obj(json['effort']);
  const cw = obj(json['context_window']);
  const rl = obj(json['rate_limits']);
  const cost = obj(json['cost']);
  const win = (v: unknown): UsageWindow | undefined => {
    const w = obj(v);
    const used = num(w?.['used_percentage']);
    if (used === undefined) return undefined;
    const resets = num(w?.['resets_at']);
    return { usedPercent: used, ...(resets ? { resetsAt: resets * 1000 } : {}) };
  };
  const out: ClaudeStatusline = { at };
  const name = str(model?.['display_name']) ?? str(model?.['id']);
  if (name) out.modelName = name;
  const level = str(effort?.['level']);
  if (level) out.effort = level;
  const pct = num(cw?.['used_percentage']);
  if (pct !== undefined) out.contextPercent = pct;
  const size = num(cw?.['context_window_size']);
  if (size) out.windowTokens = size;
  const five = win(rl?.['five_hour']);
  if (five) out.fiveHour = five;
  const week = win(rl?.['seven_day']);
  if (week) out.weekly = week;
  const usd = num(cost?.['total_cost_usd']);
  if (usd !== undefined) out.costUsd = usd;
  return out;
}

/**
 * Folders OMC may keep state in, nearest first: OMC uses the git top level, else the cwd.
 * `ceiling` stops the walk at that folder (tests keep it inside their temp folder).
 */
function omcSessionDirs(cwd: string, ceiling?: string): string[] {
  const out: string[] = [];
  let dir = cwd;
  for (let i = 0; i < OMC_ANCESTOR_LEVELS; i++) {
    out.push(join(dir, '.omc', 'state', 'sessions'));
    const parent = dirname(dir);
    if (parent === dir || (ceiling !== undefined && sameDir(dir, ceiling))) break;
    dir = parent;
  }
  return out;
}

/**
 * The cached statusline input of one Claude Code session, plus the freshest limits of any
 * session cached next to it (limits are per account). OMC writes at the git top level, so
 * the tab's folder and its parents are searched; the first folder holding this session wins.
 */
export async function readOmcStatusline(
  cwd: string,
  sessionId: string,
  ceiling?: string,
): Promise<{ own: ClaudeStatusline | null; limits: ClaudeStatusline | null }> {
  const readOne = async (dir: string, id: string): Promise<ClaudeStatusline | null> => {
    const file = join(dir, id, 'hud-stdin-cache.json');
    try {
      const [text, s] = await Promise.all([readFile(file, 'utf8'), stat(file)]);
      const json = obj(JSON.parse(text));
      return json ? parseStatusline(json, s.mtimeMs) : null;
    } catch {
      return null;
    }
  };
  let own: ClaudeStatusline | null = null;
  let home: string | null = null;
  for (const dir of omcSessionDirs(cwd, ceiling)) {
    own = await readOne(dir, sessionId);
    if (own) {
      home = dir;
      break;
    }
  }
  if (own?.fiveHour || own?.weekly) return { own, limits: own };
  // Borrow limits from the session folder that holds this tab, else the nearest one there is.
  // A folder can hold many sessions, so one scan serves every tab for BORROWED_LIMITS_TTL_MS.
  let limits: ClaudeStatusline | null = null;
  for (const dir of home ? [home] : omcSessionDirs(cwd, ceiling)) {
    const cached = borrowedLimits.get(dir);
    if (cached && Date.now() - cached.scannedAt < BORROWED_LIMITS_TTL_MS) {
      limits = cached.limits;
    } else {
      let ids: string[];
      try {
        ids = await readdir(dir);
      } catch {
        continue;
      }
      for (const id of ids) {
        const other = await readOne(dir, id);
        if (other && (other.fiveHour || other.weekly) && (!limits || other.at > limits.at)) {
          limits = other;
        }
      }
      borrowedLimits.set(dir, { scannedAt: Date.now(), limits });
    }
    if (limits) break;
  }
  return { own, limits };
}

/** Freshest limits per OMC sessions folder, rescanned at most once a minute */
const borrowedLimits = new Map<string, { scannedAt: number; limits: ClaudeStatusline | null }>();
const BORROWED_LIMITS_TTL_MS = 60_000;

// ──────────────────────────────────────────────────────────────────
// Building the snapshot
// ──────────────────────────────────────────────────────────────────

/** "claude-opus-5-5" → "Opus 5.5"; anything else stays as it is. */
export function claudeModelName(id: string): string {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(id);
  if (!m) return id;
  const family = m[1]!.charAt(0).toUpperCase() + m[1]!.slice(1);
  return `${family} ${m[2]}${m[3] && m[3].length <= 2 ? `.${m[3]}` : ''}`;
}

export function claudeUsage(
  tally: ClaudeTally,
  status: { own: ClaudeStatusline | null; limits: ClaudeStatusline | null },
): AgentUsage {
  const own = status.own;
  const windowTokens = own?.windowTokens;
  const usedTokens = tally.contextTokens;
  const usedPercent =
    own?.contextPercent ??
    (usedTokens !== undefined && windowTokens
      ? Math.round((usedTokens / windowTokens) * 100)
      : undefined);
  const usage: AgentUsage = {
    agent: 'claude-code',
    details: {
      prompts: tally.prompts,
      toolCalls: tally.toolCalls,
      agentCalls: tally.agentCalls,
      skillCalls: tally.skillCalls,
      source: own ? 'transcript + OMC statusline cache' : 'transcript',
    },
  };
  const model = own?.modelName ?? (tally.modelId ? claudeModelName(tally.modelId) : undefined);
  if (model) usage.model = model;
  if (own?.effort) usage.effort = own.effort;
  if (usedTokens !== undefined || usedPercent !== undefined) {
    usage.context = {
      ...(usedPercent !== undefined ? { usedPercent } : {}),
      ...(usedTokens !== undefined ? { usedTokens } : {}),
      ...(windowTokens ? { windowTokens } : {}),
    };
  }
  if (status.limits?.fiveHour) usage.fiveHour = status.limits.fiveHour;
  if (status.limits?.weekly) usage.weekly = status.limits.weekly;
  const d = usage.details;
  if (tally.startedAt !== undefined) d.startedAt = tally.startedAt;
  if (tally.lastPromptAt !== undefined) d.lastPromptAt = tally.lastPromptAt;
  if (tally.lastSkill) d.lastSkill = tally.lastSkill;
  if (tally.todos) d.todos = tally.todos;
  if (own?.costUsd !== undefined) d.costUsd = own.costUsd;
  return usage;
}

export function codexUsage(tally: CodexTally): AgentUsage {
  const usage: AgentUsage = {
    agent: 'codex',
    details: { prompts: tally.prompts, toolCalls: tally.toolCalls, source: 'Codex rollout' },
  };
  if (tally.model) usage.model = tally.model;
  if (tally.effort) usage.effort = tally.effort;
  if (tally.contextTokens !== undefined) {
    usage.context = {
      usedTokens: tally.contextTokens,
      ...(tally.windowTokens
        ? {
            windowTokens: tally.windowTokens,
            usedPercent: Math.round((tally.contextTokens / tally.windowTokens) * 100),
          }
        : {}),
    };
  }
  if (tally.fiveHour) usage.fiveHour = tally.fiveHour;
  if (tally.weekly) usage.weekly = tally.weekly;
  if (tally.startedAt !== undefined) usage.details.startedAt = tally.startedAt;
  if (tally.lastPromptAt !== undefined) usage.details.lastPromptAt = tally.lastPromptAt;
  return usage;
}

/** Codex models from models_cache.json, hidden ones left out. Fallback: an empty list. */
export async function readCodexModels(codexDir: string): Promise<ModelChoice[]> {
  try {
    const json = obj(JSON.parse(await readFile(join(codexDir, 'models_cache.json'), 'utf8')));
    const models = Array.isArray(json?.['models']) ? (json['models'] as unknown[]) : [];
    const out: ModelChoice[] = [];
    for (const raw of models) {
      const m = obj(raw);
      const slug = str(m?.['slug']);
      if (!m || !slug || m['visibility'] === 'hide') continue;
      const levels = Array.isArray(m['supported_reasoning_levels'])
        ? (m['supported_reasoning_levels'] as unknown[])
            .map((l) => str(obj(l)?.['effort']) ?? str(l))
            .filter((l): l is string => !!l)
        : [];
      out.push({
        id: slug,
        label: str(m['display_name']) ?? slug,
        efforts: levels.length ? levels : [...CODEX_FALLBACK_EFFORTS],
      });
    }
    return out;
  } catch (err) {
    logger.debug('agent-usage', `no Codex model list in ${codexDir}: ${String(err)}`);
    return [];
  }
}

// ──────────────────────────────────────────────────────────────────
// Per tab
// ──────────────────────────────────────────────────────────────────

export interface UsageTab {
  sessionId: string;
  agent: ModelAgent;
  cwd: string;
  createdAt: number;
  /** Claude Code `--session-id` given at launch */
  launchId?: string;
  /**
   * Launch ids of the other open Claude Code tabs. Their transcripts are never taken by a tab
   * without an id, even before those tabs have looked for them.
   */
  otherLaunchIds?: readonly string[];
}

/**
 * Remembers which file belongs to which tab and keeps one read cursor per file.
 * forget() when a tab closes, so its file becomes free for the others.
 */
export class AgentUsageReader {
  private readonly files = new Map<string, string>();
  private readonly claude = new Map<string, Cursor<ClaudeTally>>();
  private readonly codex = new Map<string, Cursor<CodexTally>>();

  /** omcCeiling: stop the .omc search at this folder (tests); default walks to the drive root */
  constructor(
    private readonly dirs: { claudeDir: string; codexDir: string; omcCeiling?: string },
  ) {}

  /** The tab's usage, or null when its agent has written nothing yet. Never throws. */
  async usage(tab: UsageTab): Promise<AgentUsage | null> {
    try {
      const file = await this.fileOf(tab);
      if (!file) {
        // Claude Code writes no transcript before the first message, but OMC already caches
        // its statusline (model, effort, window, often the limits): show that much
        if (tab.agent !== 'claude-code' || !tab.launchId) return null;
        const status = await readOmcStatusline(tab.cwd, tab.launchId, this.dirs.omcCeiling);
        return status.own || status.limits ? claudeUsage(new ClaudeTally(), status) : null;
      }
      if (tab.agent === 'codex') {
        return codexUsage(await advance(file, this.codex, () => new CodexTally()));
      }
      const tally = await advance(file, this.claude, () => new ClaudeTally());
      const status = await readOmcStatusline(
        tab.cwd,
        basename(file, '.jsonl'),
        this.dirs.omcCeiling,
      );
      return claudeUsage(tally, status);
    } catch (err) {
      logger.warn(
        'agent-usage',
        `usage of ${tab.agent} tab ${tab.sessionId} in ${tab.cwd} failed: ` +
          `${err instanceof Error ? err.message : String(err)}. The file may have been moved, ` +
          'or the agent changed its format; the menu shows no numbers.',
      );
      return null;
    }
  }

  /**
   * The id that resumes this tab's conversation (`claude --resume <id>`, `codex resume <id>`),
   * or null when the agent has written nothing yet. Claude Code names its transcript after
   * the id; Codex puts the id at the end of the rollout file name.
   */
  async conversationId(tab: UsageTab): Promise<string | null> {
    const file = await this.fileOf(tab);
    if (!file) return null;
    if (tab.agent === 'claude-code') return basename(file, '.jsonl');
    return (
      /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(file)?.[1] ??
      null
    );
  }

  forget(sessionId: string): void {
    const file = this.files.get(sessionId);
    this.files.delete(sessionId);
    if (file) {
      this.claude.delete(file);
      this.codex.delete(file);
    }
  }

  private async fileOf(tab: UsageTab): Promise<string | null> {
    const known = this.files.get(tab.sessionId);
    if (known) return known;
    const claimed = new Set(
      [...this.files.entries()].filter(([id]) => id !== tab.sessionId).map(([, f]) => f),
    );
    const projectDir = claudeProjectDir(this.dirs.claudeDir, tab.cwd);
    for (const id of tab.otherLaunchIds ?? []) claimed.add(join(projectDir, `${id}.jsonl`));
    const file =
      tab.agent === 'codex'
        ? await findCodexRollout({
            codexDir: this.dirs.codexDir,
            cwd: tab.cwd,
            since: tab.createdAt,
            claimed,
          })
        : await findClaudeTranscript({
            claudeDir: this.dirs.claudeDir,
            cwd: tab.cwd,
            since: tab.createdAt,
            claimed,
            ...(tab.launchId ? { launchId: tab.launchId } : {}),
          });
    if (file) {
      this.files.set(tab.sessionId, file);
      logger.debug('agent-usage', `tab ${tab.sessionId} (${tab.agent}) reads ${file}`);
    }
    return file;
  }
}
