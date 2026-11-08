/**
 * @file claude-math-images.ts
 * @purpose The install commands for the latex-math Claude Code plugin that the "Claude Code
 *          formula images" extension needs (ADR-019), shown in Settings and typed into a terminal.
 *
 * @关键设计:
 * - The settings button types one line and does not press Enter: pressing Enter is the user's
 *   consent to run it. Two commands on one line need a separator the shell understands: cmd.exe
 *   uses `&&`; PowerShell (5.1 has no `&&`), bash, zsh and fish accept `;`.
 *
 * @不要在这里做的事:
 * - Do not run anything here; this module only builds strings.
 */

/** Adds the Ceteris repository as a Claude Code plugin marketplace. */
export const LATEX_MATH_MARKETPLACE_COMMAND = 'claude plugin marketplace add Fanisting/ceteris';
/** Installs the Ceteris fork of the latex-math plugin from that marketplace. */
export const LATEX_MATH_INSTALL_COMMAND = 'claude plugin install latex-math@ceteris';

/** Both commands, one per line, for display. */
export const LATEX_MATH_INSTALL_LINES = `${LATEX_MATH_MARKETPLACE_COMMAND}\n${LATEX_MATH_INSTALL_COMMAND}`;

/**
 * Both commands as one line for the given shell, without a trailing newline.
 *
 * @param shellId a detected shell id ('pwsh', 'powershell', 'cmd', 'git-bash', 'wsl', 'zsh', ...)
 */
export function latexMathInstallLine(shellId: string): string {
  const separator = shellId === 'cmd' ? ' && ' : '; ';
  return `${LATEX_MATH_MARKETPLACE_COMMAND}${separator}${LATEX_MATH_INSTALL_COMMAND}`;
}
