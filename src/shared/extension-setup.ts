/**
 * @file src/shared/extension-setup.ts
 * @purpose The one-time setup list for the agent extensions (ADR-041): which items exist, what
 *   each one needs, and the single command line that installs the selected ones.
 *
 * @关键设计:
 * - Three kinds of work hide behind the checkboxes. Settings flip at once (formula images,
 *   Codex formula rendering, coordinator switch). The Codex config entry is written by main
 *   (cmd:extensions:codex-mcp-install). Everything that changes Claude Code's or Codex's own
 *   files goes into ONE terminal as one line, so the user reads it and presses Enter once; that
 *   Enter is the consent, as for the single rows in Settings.
 * - The marketplace is added once even when both Claude Code plugins are selected.
 * - For cmd the Codex instruction cannot sit in parentheses (see terminal-math.ts), so it is
 *   chained with `&` after the Claude commands instead of `&&`; it is independent of them.
 *
 * @对应文档章节:软件定义书.md ADR-041
 *
 * @不要在这里做的事:
 * - Do not read settings or detect agents here; the card decides what to preselect.
 */
import { LATEX_MATH_INSTALL_COMMAND, latexMathMarketplaceCommand } from './claude-math-images';
import { TAB_CONTROL_INSTALL_COMMAND } from './tab-control';
import { codexMathInstructionCommand } from './terminal-math';

export type ExtensionSetupItemId =
  | 'claude-tabs'
  | 'claude-math'
  | 'codex-tabs'
  | 'codex-math'
  | 'coordinator';

export const EXTENSION_SETUP_ITEMS: readonly ExtensionSetupItemId[] = [
  'claude-tabs',
  'claude-math',
  'codex-tabs',
  'codex-math',
  'coordinator',
];

/** Window event that opens the card again (Settings, Extensions, "Open the setup list"). */
export const EXTENSION_SETUP_OPEN_EVENT = 'ceteris:extension-setup-open';

/** Items that need the terminal line (Claude Code plugins, the Codex instructions file). */
export function extensionSetupNeedsTerminal(selected: ReadonlySet<ExtensionSetupItemId>): boolean {
  return selected.has('claude-tabs') || selected.has('claude-math') || selected.has('codex-math');
}

/**
 * One command line for the selected items, or null when none needs the terminal.
 *
 * @param shellId a detected shell id ('pwsh', 'powershell', 'cmd', 'git-bash', 'zsh', ...)
 * @param marketplaceDir the bundled extensions folder (cmd:extensions:get-marketplace-dir)
 */
export function extensionSetupCommand(
  shellId: string,
  marketplaceDir: string,
  selected: ReadonlySet<ExtensionSetupItemId>,
): string | null {
  const claude: string[] = [];
  if (selected.has('claude-tabs') || selected.has('claude-math')) {
    claude.push(latexMathMarketplaceCommand(marketplaceDir, shellId));
  }
  if (selected.has('claude-tabs')) claude.push(TAB_CONTROL_INSTALL_COMMAND);
  if (selected.has('claude-math')) claude.push(LATEX_MATH_INSTALL_COMMAND);
  const codex = selected.has('codex-math') ? codexMathInstructionCommand(shellId) : null;
  if (claude.length === 0 && !codex) return null;
  const isCmd = shellId === 'cmd';
  const claudeLine = claude.join(isCmd ? ' && ' : '; ');
  if (!codex) return claudeLine;
  if (!claudeLine) return codex;
  return `${claudeLine}${isCmd ? ' & ' : '; '}${codex}`;
}

/** The settings flipped on for the selected items. Empty when none is a switch. */
export function extensionSetupSettings(selected: ReadonlySet<ExtensionSetupItemId>): {
  claudeMathImages?: true;
  terminalMath?: true;
  tabControl?: true;
} {
  return {
    ...(selected.has('claude-math') ? { claudeMathImages: true as const } : {}),
    ...(selected.has('codex-math') ? { terminalMath: true as const } : {}),
    ...(selected.has('coordinator') ? { tabControl: true as const } : {}),
  };
}
