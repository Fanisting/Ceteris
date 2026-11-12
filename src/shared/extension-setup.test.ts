/**
 * @file extension-setup.test.ts
 * @purpose The one-time setup list (ADR-041): which items produce which command line and which
 *   settings. One test per rule.
 */
import { describe, expect, it } from 'vitest';
import {
  extensionSetupCommand,
  extensionSetupNeedsTerminal,
  extensionSetupSettings,
  type ExtensionSetupItemId,
} from './extension-setup';

const DIR = 'C:\\Apps\\Ceteris\\resources\\extensions';
const sel = (...ids: ExtensionSetupItemId[]): Set<ExtensionSetupItemId> => new Set(ids);

describe('extensionSetupCommand', () => {
  it('adds the marketplace once and installs both Claude Code plugins', () => {
    const line = extensionSetupCommand('pwsh', DIR, sel('claude-tabs', 'claude-math'));
    expect(line).toBe(
      `claude plugin marketplace add '${DIR}'; claude plugin install ceteris-tabs@ceteris; claude plugin install latex-math@ceteris`,
    );
  });

  it('chains with && on cmd and puts the Codex instruction after a single &', () => {
    const line = extensionSetupCommand('cmd', DIR, sel('claude-tabs', 'codex-math'));
    expect(line).toMatch(
      /^claude plugin marketplace add "C:\\Apps\\Ceteris\\resources\\extensions" && claude plugin install ceteris-tabs@ceteris & mkdir /,
    );
    // The Codex part is not grouped in parentheses and not gated on the Claude commands.
    expect(line).not.toMatch(/&& mkdir|\(mkdir/);
  });

  it('gives only the Codex instruction when nothing for Claude Code is selected', () => {
    const line = extensionSetupCommand('git-bash', DIR, sel('codex-math', 'coordinator'));
    expect(line).toMatch(/^mkdir -p ~\/\.codex/);
    expect(line).not.toContain('claude plugin');
  });

  it('is null when no selected item needs a terminal', () => {
    expect(extensionSetupCommand('pwsh', DIR, sel('codex-tabs', 'coordinator'))).toBeNull();
    expect(extensionSetupNeedsTerminal(sel('codex-tabs', 'coordinator'))).toBe(false);
    expect(extensionSetupNeedsTerminal(sel('claude-math'))).toBe(true);
  });
});

describe('extensionSetupSettings', () => {
  it('flips exactly the switches of the selected items', () => {
    expect(extensionSetupSettings(sel('claude-math', 'coordinator'))).toEqual({
      claudeMathImages: true,
      tabControl: true,
    });
    expect(extensionSetupSettings(sel('claude-tabs', 'codex-tabs'))).toEqual({});
  });
});
