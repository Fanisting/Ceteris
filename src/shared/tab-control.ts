/**
 * @file src/shared/tab-control.ts
 * @purpose The wire format between Ceteris and the ceteris-tabs Claude Code plugin, which lets
 *   Claude Code in a coordinator tab list, open, close, type into and read the other tabs of its
 *   folder (ADR-024). Also the install command for that plugin.
 *
 * @关键设计:
 * - One request per connection on a named pipe (a unix socket elsewhere): a JSON line in, a JSON
 *   line out. The plugin's MCP server keeps its own copy of this format in plain JavaScript,
 *   because it runs outside the app bundle; tab-control-mcp.test.ts checks the two agree.
 * - Every tab gets CETERIS_CONTROL_PIPE and its own CETERIS_CONTROL_TOKEN at spawn. The token
 *   names the tab; it grants nothing by itself. Main checks on every request that the tab is a
 *   coordinator now, so marking or unmarking a tab takes effect without restarting it.
 * - CETERIS_CONTROL_NODE is the app's own executable. The plugin runs its server with it and
 *   ELECTRON_RUN_AS_NODE=1, so users need no separate Node.js.
 *
 * @对应文档章节:软件定义书.md ADR-024;docs/ipc-protocol.md "Tab control pipe"
 *
 * @不要在这里做的事:
 * - Do not decide who may do what here; that is tab-control-server.ts.
 */
import { latexMathMarketplaceCommand } from './claude-math-images';
import type { FileViewKind } from './file-tree';
import type { AgentPhase, SessionState } from './types';

/** Env names set in every tab. Listed so a Ceteris started from a tab does not inherit them. */
export const TAB_CONTROL_ENV = {
  pipe: 'CETERIS_CONTROL_PIPE',
  token: 'CETERIS_CONTROL_TOKEN',
  node: 'CETERIS_CONTROL_NODE',
} as const;

export const TAB_CONTROL_ENV_NAMES: readonly string[] = Object.values(TAB_CONTROL_ENV);

/** Bumped when a field changes meaning. The server refuses other versions. */
export const TAB_CONTROL_VERSION = 1;

/** A request line is small; anything bigger is refused before parsing. */
export const TAB_CONTROL_MAX_REQUEST_BYTES = 256 * 1024;

/** Most screen rows one read returns. The headless mirror keeps 5000 rows of scrollback. */
export const TAB_CONTROL_MAX_READ_LINES = 2000;

/** Longest text one input request may type. */
export const TAB_CONTROL_MAX_INPUT_CHARS = 64 * 1024;

export type TabControlOp =
  | 'list'
  | 'get'
  | 'templates'
  | 'create'
  | 'close'
  | 'input'
  | 'read'
  | 'rename'
  | 'open-file'
  | 'agent-session';

export const TAB_CONTROL_OPS: readonly TabControlOp[] = [
  'list',
  'get',
  'templates',
  'create',
  'close',
  'input',
  'read',
  'rename',
  'open-file',
  'agent-session',
];

/** Ops any live tab may call, coordinator or not and extension on or off. */
export const TAB_CONTROL_ANY_TAB_OPS: readonly TabControlOp[] = ['open-file', 'agent-session'];

/** Named keys an input request may press, and the bytes each one sends. */
export const TAB_CONTROL_KEYS: Readonly<Record<string, string>> = {
  enter: '\r',
  escape: '\x1b',
  tab: '\t',
  'shift-tab': '\x1b[Z',
  backspace: '\x7f',
  space: ' ',
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',
  'ctrl-c': '\x03',
  'ctrl-d': '\x04',
  'ctrl-l': '\x0c',
};

export interface TabControlRequest {
  v: number;
  token: string;
  op: TabControlOp;
  args: Record<string, unknown>;
}

export type TabControlErrorCode =
  | 'bad-request'
  | 'disabled'
  | 'unknown-token'
  | 'not-coordinator'
  | 'not-found'
  | 'ambiguous'
  | 'self'
  | 'failed';

export type TabControlReply =
  | { ok: true; result: unknown }
  | { ok: false; code: TabControlErrorCode; message: string };

/** One tab as the coordinator sees it. */
export interface TabSummary {
  id: string;
  name: string;
  templateId: string;
  state: SessionState;
  /** working / blocked / done for Claude Code and Codex, null for a plain shell */
  agentPhase: AgentPhase | null;
  coordinator: boolean;
  /** The tab that asked */
  self: boolean;
  cwd: string;
  exitCode?: number;
}

/** Reply of `open-file`: the file now shown beside a tab. */
export interface TabControlOpenFileResult {
  tab: TabSummary;
  /** Absolute path as resolved against the tab's current directory */
  path: string;
  name: string;
  kind: FileViewKind;
}

/**
 * Parses one request line. Returns null for anything malformed, so the server answers
 * bad-request without throwing.
 */
export function decodeTabControlRequest(line: string): TabControlRequest | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.v !== 'number' || typeof r.token !== 'string' || typeof r.op !== 'string') {
    return null;
  }
  if (!(TAB_CONTROL_OPS as readonly string[]).includes(r.op)) return null;
  const args = r.args === undefined ? {} : r.args;
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
  return {
    v: r.v,
    token: r.token,
    op: r.op as TabControlOp,
    args: args as Record<string, unknown>,
  };
}

export function encodeTabControlReply(reply: TabControlReply): string {
  return `${JSON.stringify(reply)}\n`;
}

/** The marketplace that ships with Ceteris (extensions/.claude-plugin/marketplace.json). */
export const TAB_CONTROL_INSTALL_COMMAND = 'claude plugin install ceteris-tabs@ceteris';

/**
 * Claude Code keeps its own copy of an installed plugin, so a Ceteris update that ships a newer
 * plugin changes nothing until the user runs this (ADR-033: open_file arrived in 0.2.0).
 */
export const TAB_CONTROL_UPDATE_COMMAND = 'claude plugin update ceteris-tabs@ceteris';

/** Both install commands, one per line, for display. */
export function tabControlInstallLines(dir: string): string {
  return `${latexMathMarketplaceCommand(dir, 'cmd')}\n${TAB_CONTROL_INSTALL_COMMAND}`;
}

/** Both install commands as one line for the given shell, without a trailing newline. */
export function tabControlInstallLine(shellId: string, dir: string): string {
  const separator = shellId === 'cmd' ? ' && ' : '; ';
  return `${latexMathMarketplaceCommand(dir, shellId)}${separator}${TAB_CONTROL_INSTALL_COMMAND}`;
}

/** The plugin's id in Claude Code's plugin registry: `<plugin>@<marketplace>`. */
export const TAB_CONTROL_PLUGIN_ID = 'ceteris-tabs@ceteris';

/**
 * Whether Claude Code's plugin registry (`~/.claude/plugins/installed_plugins.json`) lists a
 * plugin. Version 2 of that file maps each id to an array of installs, one per scope; version 1
 * mapped it to a single object. Anything unreadable counts as not installed, so the coordinator
 * guide keeps showing the install step instead of claiming a plugin that is not there.
 */
export function isClaudePluginInstalled(registry: unknown, pluginId: string): boolean {
  if (typeof registry !== 'object' || registry === null) return false;
  const plugins = (registry as { plugins?: unknown }).plugins;
  if (typeof plugins !== 'object' || plugins === null) return false;
  const entry = (plugins as Record<string, unknown>)[pluginId];
  if (Array.isArray(entry)) return entry.length > 0;
  return typeof entry === 'object' && entry !== null;
}

/** Reply of `cmd:extensions:tab-control-status`, read by the coordinator guide. */
export interface TabControlStatus {
  /** Claude Code lists ceteris-tabs@ceteris as installed in at least one scope. */
  pluginInstalled: boolean;
  /** Claude Code's config folder exists, so Claude Code has run on this machine (ADR-041). */
  claudeInstalled: boolean;
}

/**
 * Window event the tab menu fires when the user ticks Coordinator, so the coordinator guide
 * (CoordinatorTour.tsx) can open or move on without the menu knowing about it.
 */
export const COORDINATOR_GUIDE_EVENT = 'ceteris:coordinator-ticked';
