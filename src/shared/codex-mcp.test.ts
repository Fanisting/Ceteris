/**
 * @file codex-mcp.test.ts
 * @purpose The config.toml entry for Codex (ADR-033): what it contains, and that rewriting it
 *   touches nothing else in the file. One test per rule.
 */
import { describe, expect, it } from 'vitest';
import { codexMcpBlock, hasCodexMcpBlock, upsertCodexMcpBlock } from './codex-mcp';

const block = codexMcpBlock({
  command: 'C:\\Apps\\Ceteris\\Ceteris.exe',
  serverPath:
    'C:\\Apps\\Ceteris\\resources\\extensions\\ceteris-tabs\\server\\ceteris-tabs-mcp.mjs',
});

describe('codexMcpBlock', () => {
  it('runs the server with Ceteris as Node and forwards the pipe and token', () => {
    expect(block).toBe(
      [
        '[mcp_servers.ceteris-tabs]',
        "command = 'C:\\Apps\\Ceteris\\Ceteris.exe'",
        "args = ['C:\\Apps\\Ceteris\\resources\\extensions\\ceteris-tabs\\server\\ceteris-tabs-mcp.mjs']",
        'env_vars = ["CETERIS_CONTROL_PIPE", "CETERIS_CONTROL_TOKEN"]',
        '',
        '[mcp_servers.ceteris-tabs.env]',
        'ELECTRON_RUN_AS_NODE = "1"',
        '',
      ].join('\n'),
    );
  });

  it('refuses a path that has no literal TOML form', () => {
    expect(() => codexMcpBlock({ command: "C:\\O'Brien\\Ceteris.exe", serverPath: 'x' })).toThrow(
      /quote/,
    );
  });
});

describe('upsertCodexMcpBlock', () => {
  it('appends to an empty or missing file', () => {
    expect(upsertCodexMcpBlock('', block)).toBe(block);
    expect(hasCodexMcpBlock(upsertCodexMcpBlock('', block))).toBe(true);
  });

  it('keeps other servers and settings byte for byte', () => {
    const existing = 'model = "o3"\n\n[mcp_servers.other]\ncommand = "x"\n';
    expect(upsertCodexMcpBlock(existing, block)).toBe(`${existing.trimEnd()}\n\n${block}`);
  });

  it('replaces an older entry and its env table, wherever they sit', () => {
    const existing = [
      '[mcp_servers.ceteris-tabs]',
      "command = 'C:\\Old\\Ceteris.exe'",
      'args = []',
      '',
      '[mcp_servers.ceteris-tabs.env]',
      'ELECTRON_RUN_AS_NODE = "1"',
      '',
      '[mcp_servers.other]',
      'command = "x"',
      '',
      '[mcp_servers."ceteris-tabs".tools.open_file]',
      'approval_mode = "approve"',
      '',
    ].join('\n');
    const result = upsertCodexMcpBlock(existing, block);
    expect(result).toBe(`[mcp_servers.other]\ncommand = "x"\n\n${block}`);
    expect(result.match(/\[mcp_servers\.ceteris-tabs\]/g)).toHaveLength(1);
  });

  it('does not touch a server whose name merely starts the same', () => {
    const existing = '[mcp_servers.ceteris-tabs-old]\ncommand = "x"\n';
    expect(hasCodexMcpBlock(existing)).toBe(false);
    expect(upsertCodexMcpBlock(existing, block)).toBe(`${existing.trimEnd()}\n\n${block}`);
  });
});
