/**
 * @file src/shared/codex-mcp.ts
 * @purpose The `[mcp_servers.ceteris-tabs]` entry Ceteris writes into Codex's config.toml so
 *   Codex in a Ceteris tab gets the same ceteris-tabs tools as Claude Code (ADR-033).
 *
 * @关键设计:
 * - Codex has no plugin marketplace; MCP servers are tables in ~/.codex/config.toml. The server
 *   is the same no-dependency script the Claude Code plugin runs, started with Ceteris's own
 *   executable as Node (ELECTRON_RUN_AS_NODE=1), so no separate Node.js is needed.
 * - The tab's pipe name and token live in the tab's environment. Codex only hands an MCP
 *   server the variables named in `env_vars`, so the entry lists both; without that the server
 *   would see no Ceteris and offer no tools.
 * - Paths are written as TOML literal strings ('...'), the form Codex itself writes, so Windows
 *   backslashes need no escaping. A path containing a single quote cannot be written that way
 *   and is refused.
 * - Upsert, not append: Ceteris updates move the executable and the server script, so the entry
 *   is rewritten on every click. Any existing table for this server (and its sub-tables) is
 *   removed first; everything else in the file is kept byte for byte.
 *
 * @对应文档章节:软件定义书.md ADR-033;docs/ipc-protocol.md cmd:extensions:codex-mcp-*
 *
 * @不要在这里做的事:
 * - Do not parse TOML in full. Only table headers for this one server are recognised.
 * - Do not touch the file system here; ipc.ts reads and writes config.toml.
 */

/** The server name in config.toml; Codex shows tools as `ceteris-tabs/<tool>`. */
export const CODEX_MCP_SERVER_NAME = 'ceteris-tabs';

/** Env names Codex must forward from the tab to the server. Mirrors TAB_CONTROL_ENV. */
export const CODEX_MCP_FORWARDED_ENV = ['CETERIS_CONTROL_PIPE', 'CETERIS_CONTROL_TOKEN'] as const;

/** Reply of cmd:extensions:codex-mcp-status and cmd:extensions:codex-mcp-install. */
export interface CodexMcpStatus {
  /** ~/.codex/config.toml, or $CODEX_HOME/config.toml when that is set */
  configPath: string;
  /** The file has a table for this server */
  configured: boolean;
  /** The Codex home folder exists, so Codex has run on this machine (ADR-041) */
  codexInstalled: boolean;
  /** The entry Ceteris would write now (for display) */
  block: string;
}

export interface CodexMcpBlockInput {
  /** Executable that runs the server as Node: Ceteris's own, with ELECTRON_RUN_AS_NODE=1 */
  command: string;
  /** Absolute path of ceteris-tabs-mcp.mjs */
  serverPath: string;
}

/** A TOML literal string. Throws when the value cannot be one. */
function literal(value: string): string {
  if (value.includes("'") || /[\r\n]/.test(value)) {
    throw new Error(
      `[codex-mcp] cannot write "${value}" into config.toml: a path with a quote or a line break ` +
        'has no literal TOML form. Move Ceteris to a plain path, or add the entry by hand.',
    );
  }
  return `'${value}'`;
}

/** The TOML tables for the server, ending with one newline. */
export function codexMcpBlock(input: CodexMcpBlockInput): string {
  return [
    `[mcp_servers.${CODEX_MCP_SERVER_NAME}]`,
    `command = ${literal(input.command)}`,
    `args = [${literal(input.serverPath)}]`,
    `env_vars = [${CODEX_MCP_FORWARDED_ENV.map((n) => `"${n}"`).join(', ')}]`,
    '',
    `[mcp_servers.${CODEX_MCP_SERVER_NAME}.env]`,
    'ELECTRON_RUN_AS_NODE = "1"',
    '',
  ].join('\n');
}

/** Matches `[mcp_servers.ceteris-tabs]`, `[mcp_servers."ceteris-tabs".env]` and friends. */
const OWN_HEADER = new RegExp(
  `^\\s*\\[\\s*mcp_servers\\s*\\.\\s*"?${CODEX_MCP_SERVER_NAME}"?\\s*(\\.[^\\]]*)?\\]\\s*(#.*)?$`,
);
const ANY_HEADER = /^\s*\[/;

export function hasCodexMcpBlock(toml: string): boolean {
  return toml.split(/\r?\n/).some((line) => OWN_HEADER.test(line));
}

/**
 * Returns the file content with the server's tables replaced by `block`. Lines from one of the
 * server's headers up to the next table header are dropped; the block goes at the end.
 */
export function upsertCodexMcpBlock(toml: string, block: string): string {
  const kept: string[] = [];
  let dropping = false;
  for (const line of toml.split(/\r?\n/)) {
    if (OWN_HEADER.test(line)) {
      dropping = true;
      continue;
    }
    if (dropping && ANY_HEADER.test(line)) dropping = false;
    if (!dropping) kept.push(line);
  }
  let head = kept.join('\n').replace(/\s+$/, '');
  if (head) head += '\n\n';
  return `${head}${block}`;
}
