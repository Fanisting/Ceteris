/**
 * @file src/shared/agent-model.ts
 * @purpose Model and effort for Claude Code and Codex tabs (ADR-038): the choices, the
 *   folder defaults kept in settings, the launch and relaunch flags, and the usage snapshot
 *   the tab menu shows.
 *
 * @关键设计:
 * - Only two agents take part: 'claude-code' and 'codex'. Every other template is left alone.
 * - '' for model or effort means "the agent's own default" (~/.claude/settings.json,
 *   ~/.codex/config.toml). Nothing is passed for it.
 * - Model and effort values go onto a command line and into the terminal, so they must
 *   match SAFE_VALUE. Anything else is rejected, never quoted.
 * - Folder defaults are a list, not a map: settings deep-merge cannot delete a map key, and
 *   a list replaces wholesale. One entry per (pathId, agent); an entry with both fields ''
 *   is dropped.
 * - A running tab switches by relaunching in place: `/exit`, then the same command with
 *   session flags and the resume id (relaunchArgs). The agents' own `/model` is not used:
 *   Claude Code's saves the choice as the user's global default (Codex's was not tested).
 *
 * @对应文档章节: 软件定义书.md ADR-038; ipc-protocol.md 5.13
 *
 * @不要在这里做的事:
 * - No file reading: usage comes from src/main/agent-usage.ts.
 * - No PTY writes: the main process types the commands (ipc.ts).
 */

export type ModelAgent = 'claude-code' | 'codex';

export const MODEL_AGENTS: readonly ModelAgent[] = ['claude-code', 'codex'];

/** The agent a template launches, or null when it is not one of the two. */
export function modelAgentOf(templateId: string | null | undefined): ModelAgent | null {
  return templateId === 'claude-code' || templateId === 'codex' ? templateId : null;
}

export interface ModelChoice {
  /** What goes on the command line */
  id: string;
  /** What the menu shows */
  label: string;
  /** Efforts this model takes; empty means the agent's general list */
  efforts: string[];
}

/** Claude Code takes these aliases for the latest model of each family (`claude --help`). */
export const CLAUDE_MODELS: readonly ModelChoice[] = [
  { id: 'fable', label: 'Fable', efforts: [] },
  { id: 'opus', label: 'Opus', efforts: [] },
  { id: 'sonnet', label: 'Sonnet', efforts: [] },
  { id: 'haiku', label: 'Haiku', efforts: [] },
];

/** `claude --effort` levels, low to high */
export const CLAUDE_EFFORTS: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/** Codex levels when models_cache.json cannot be read */
export const CODEX_FALLBACK_EFFORTS: readonly string[] = ['low', 'medium', 'high', 'xhigh'];

/** Letters, digits and . _ - [ ] only: no spaces, quotes or shell characters. */
const SAFE_VALUE = /^[A-Za-z0-9._[\]-]{1,64}$/;

export function isSafeModelValue(value: string): boolean {
  return SAFE_VALUE.test(value);
}

export interface ModelEffort {
  /** '' = the agent's own default */
  model: string;
  /** '' = the agent's own default */
  effort: string;
}

export interface FolderAgentDefault extends ModelEffort {
  pathId: string;
  agent: ModelAgent;
}

export function isValidFolderAgentDefaults(value: unknown): value is FolderAgentDefault[] {
  if (!Array.isArray(value) || value.length > 500) return false;
  const seen = new Set<string>();
  for (const raw of value as Array<Partial<FolderAgentDefault> | null>) {
    if (!raw || typeof raw.pathId !== 'string' || raw.pathId.length === 0) return false;
    if (raw.agent !== 'claude-code' && raw.agent !== 'codex') return false;
    for (const v of [raw.model, raw.effort]) {
      if (typeof v !== 'string' || (v !== '' && !isSafeModelValue(v))) return false;
    }
    const key = `${raw.agent}\u0000${raw.pathId}`;
    if (seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}

/** The folder's default for one agent; both fields '' when none is set. */
export function folderDefaultFor(
  list: readonly FolderAgentDefault[] | undefined,
  pathId: string,
  agent: ModelAgent,
): ModelEffort {
  const hit = list?.find((d) => d.pathId === pathId && d.agent === agent);
  return { model: hit?.model ?? '', effort: hit?.effort ?? '' };
}

/**
 * The list with one folder's default for one agent replaced. Both '' removes the entry.
 * The order of other entries is kept, so a settings diff shows only the changed one.
 */
export function withFolderDefault(
  list: readonly FolderAgentDefault[] | undefined,
  pathId: string,
  agent: ModelAgent,
  value: ModelEffort,
): FolderAgentDefault[] {
  const rest = (list ?? []).filter((d) => !(d.pathId === pathId && d.agent === agent));
  if (value.model === '' && value.effort === '') return rest;
  const index = (list ?? []).findIndex((d) => d.pathId === pathId && d.agent === agent);
  const entry: FolderAgentDefault = { pathId, agent, model: value.model, effort: value.effort };
  if (index < 0) return [...rest, entry];
  return [...rest.slice(0, index), entry, ...rest.slice(index)];
}

/**
 * Flags that start the agent with this model and effort. Unsafe values are skipped, so a
 * hand-edited settings file can never put arbitrary text on a command line.
 */
export function launchArgs(agent: ModelAgent, value: ModelEffort): string[] {
  const model = value.model && isSafeModelValue(value.model) ? value.model : '';
  const effort = value.effort && isSafeModelValue(value.effort) ? value.effort : '';
  const args: string[] = [];
  if (agent === 'claude-code') {
    if (model) args.push('--model', model);
    if (effort) args.push('--effort', effort);
  } else {
    if (model) args.push('-m', model);
    // No quotes around the value: Codex reads a value that is not TOML as a plain string,
    // and the same text then survives being typed into pwsh, cmd or bash unchanged.
    if (effort) args.push('-c', `model_reasoning_effort=${effort}`);
  }
  return args;
}

/**
 * Arguments, after the template's own, that start the agent again with `pick` and continue
 * conversation `resumeId`. Without a resumeId (nothing written yet) Claude Code gets a fresh
 * `--session-id` and Codex starts a new session.
 *
 * Session flags only: unlike the agents' own `/model`, nothing here changes the user's global
 * default (seen 2026-11-10: Claude Code 2.1.322 `/model sonnet` answered "saved as your
 * default for new sessions").
 *
 * @throws Error when resumeId has characters an id never has
 */
export function relaunchArgs(
  agent: ModelAgent,
  pick: ModelEffort,
  resumeId: string | null,
  newId: string,
): { args: string[]; launchId?: string } {
  if (resumeId !== null && !isSafeModelValue(resumeId)) {
    throw new Error(
      `relaunchArgs: session id "${resumeId}" is not a plain id. The transcript name may be ` +
        'unusual; the tab is left as it is.',
    );
  }
  const flags = launchArgs(agent, pick);
  if (agent === 'claude-code') {
    return resumeId
      ? { args: ['--resume', resumeId, ...flags], launchId: resumeId }
      : { args: ['--session-id', newId, ...flags], launchId: newId };
  }
  return { args: resumeId ? ['resume', resumeId, ...flags] : flags };
}

/**
 * One command line for typing into the tab's shell (pwsh, cmd, bash, zsh or fish).
 *
 * No quoting at all: every word must be plain ASCII letters, digits and . _ = -, which every
 * one of those shells reads literally. Quoting rules differ too much between them (pwsh splits
 * on "," and splats "@", zsh globs "[", bash eats "\" and "!"), so anything else is refused
 * and the tab keeps running as it is.
 *
 * @throws Error for a word that is not plain
 */
export function shellCommandLine(command: string, args: readonly string[]): string {
  const words = [command, ...args];
  for (const w of words) {
    if (!/^[A-Za-z0-9._=-]+$/.test(w)) {
      throw new Error(
        `shellCommandLine: ${JSON.stringify(w)} is not a plain word, so it cannot be typed into ` +
          'every shell the same way. Use a template whose command and arguments are plain ' +
          'words, or restart the tab by hand.',
      );
    }
  }
  return words.join(' ');
}

/** Rows at the end of the screen searched for the agent's input line */
export const INPUT_LINE_ROWS = 20;

/**
 * Whether the agent's input box reads exactly `text`, from the end of its screen.
 *
 * The input row starts at column 0 with the agent's prompt glyph and a space: Claude Code `❯`
 * plus a no-break space (U+00A0), Codex `› ` (checked 2026-11-10 on the headless screen,
 * Claude Code 2.1.322 and Codex 0.167). Only the first row of the input
 * carries the glyph, so a draft that was not cleared shows up as `❯ <draft>…` there and never
 * reads exactly `text`. Rows that look alike but are not the input do not match either:
 * Claude Code's suggestion list is indented (`  ❯ /exit   Exit the CLI`) and Codex's popup
 * adds a description (`› /exit  exit Codex`).
 *
 * Why this check exists: Ctrl-U deletes only one wrapped row in Claude Code, so a long pasted
 * link survived it and "/exit" plus Enter sent `<link>/exit` to the agent as a prompt
 * (2026-11-10). Enter is pressed only after this check passes.
 */
export function inputLineReads(screen: string, text: string): boolean {
  const rows = screen.split('\n').slice(-INPUT_LINE_ROWS);
  // Claude Code draws a no-break space after its glyph, Codex a plain one
  return rows.some((row) => /^[❯›][ \u00a0]/.test(row) && row.slice(2).trimEnd() === text);
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/**
 * The conversation id the agent printed when it exited, taken from the end of the screen:
 * Claude Code prints "claude ... --resume <id>", Codex prints "codex resume <id>" (both
 * checked 2026-11-10). The last one wins, so an older line further up never does. This is the
 * id after /clear or an in-agent /resume, which no file name tells reliably.
 */
export function exitResumeId(agent: ModelAgent, screen: string): string | null {
  const pattern =
    agent === 'claude-code'
      ? new RegExp(`--resume\\s+(${UUID})`, 'gi')
      : new RegExp(`codex\\s+resume\\s+(${UUID})`, 'gi');
  let last: string | null = null;
  for (const m of screen.matchAll(pattern)) last = m[1]!.toLowerCase();
  return last;
}

/**
 * The valid entries of a folderDefaults value read from disk: wrong shapes, unsafe values and
 * repeats are dropped, so one bad hand edit cannot make every later settings save fail.
 */
export function sanitizeFolderDefaults(value: unknown): FolderAgentDefault[] {
  if (!Array.isArray(value)) return [];
  const out: FolderAgentDefault[] = [];
  for (const raw of value as unknown[]) {
    if (out.length >= 500) break;
    const candidate = [...out, raw];
    if (isValidFolderAgentDefaults(candidate)) {
      const e = raw as FolderAgentDefault;
      out.push({ pathId: e.pathId, agent: e.agent, model: e.model, effort: e.effort });
    }
  }
  return out;
}

/** Label for a model id: the alias name for Claude, the slug itself for Codex. */
export function modelLabel(agent: ModelAgent, model: string): string {
  if (agent === 'claude-code') {
    const hit = CLAUDE_MODELS.find((m) => m.id === model.toLowerCase());
    if (hit) return hit.label;
  }
  return model;
}

// ──────────────────────────────────────────────────────────────────
// Usage snapshot (what the tab menu shows)
// ──────────────────────────────────────────────────────────────────

export interface UsageWindow {
  /** 0 to 100 */
  usedPercent: number;
  /** Unix ms, when known */
  resetsAt?: number;
}

export interface AgentUsage {
  agent: ModelAgent;
  /** The model the agent last reported, e.g. "Opus 5.5" or "gpt-6.1-sol" */
  model?: string;
  /** The effort the agent last reported */
  effort?: string;
  /** usedPercent is absent when the window size is unknown; the menu then shows tokens only */
  context?: { usedPercent?: number; usedTokens?: number; windowTokens?: number };
  fiveHour?: UsageWindow;
  weekly?: UsageWindow;
  /** Folded under Details */
  details: {
    /** Unix ms of the first entry */
    startedAt?: number;
    /** Unix ms of the last prompt the user sent */
    lastPromptAt?: number;
    prompts?: number;
    toolCalls?: number;
    agentCalls?: number;
    skillCalls?: number;
    lastSkill?: string;
    todos?: { done: number; total: number };
    costUsd?: number;
    /** Where the numbers came from, shown small at the bottom */
    source: string;
  };
}

/** One colour step per effort level, lowest to highest. Unknown levels get 'mid'. */
export function effortLevel(effort: string): 'low' | 'mid' | 'high' | 'top' {
  switch (effort) {
    case 'minimal':
    case 'low':
      return 'low';
    case 'medium':
      return 'mid';
    case 'high':
      return 'high';
    case 'xhigh':
    case 'max':
    case 'ultra':
      return 'top';
    default:
      return 'mid';
  }
}
