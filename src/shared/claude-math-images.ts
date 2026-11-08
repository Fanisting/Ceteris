/**
 * @file claude-math-images.ts
 * @purpose The install commands for the latex-math Claude Code plugin that the "Claude Code
 *          formula images" extension needs (ADR-019), shown in Settings and typed into a terminal.
 *
 * @关键设计:
 * - The plugin ships with Ceteris: its folder `extensions/` is a local Claude Code marketplace
 *   named "ceteris" (resources/extensions when installed, the repository folder in a dev run;
 *   main answers cmd:extensions:get-marketplace-dir). No network or GitHub branch is involved.
 * - The settings button types one line and does not press Enter: pressing Enter is the user's
 *   consent to run it. The folder is quoted and the two commands joined the way the shell needs:
 *   cmd.exe uses "..." and `&&`; PowerShell uses '...' (a ' doubled) and `;` (5.1 has no `&&`);
 *   bash, zsh and fish use '...' (a ' as '\'') and `;`.
 *
 * @不要在这里做的事:
 * - Do not run anything here; this module only builds strings.
 */

/** The marketplace name in extensions/.claude-plugin/marketplace.json. */
export const LATEX_MATH_MARKETPLACE = 'ceteris';
/** Installs the Ceteris fork of the latex-math plugin from that marketplace. */
export const LATEX_MATH_INSTALL_COMMAND = `claude plugin install latex-math@${LATEX_MATH_MARKETPLACE}`;

/** Quotes a folder path for the given shell. */
function quotePath(dir: string, shellId: string): string {
  if (shellId === 'cmd') return `"${dir}"`;
  if (shellId === 'pwsh' || shellId === 'powershell') return `'${dir.replace(/'/g, "''")}'`;
  return `'${dir.replace(/'/g, "'\\''")}'`;
}

/** Adds the bundled folder as a local plugin marketplace, quoted for the shell. */
export function latexMathMarketplaceCommand(dir: string, shellId: string): string {
  return `claude plugin marketplace add ${quotePath(dir, shellId)}`;
}

/** Both commands, one per line, for display (double quotes read well in every shell). */
export function latexMathInstallLines(dir: string): string {
  return `${latexMathMarketplaceCommand(dir, 'cmd')}\n${LATEX_MATH_INSTALL_COMMAND}`;
}

/**
 * Both commands as one line for the given shell, without a trailing newline.
 *
 * @param shellId a detected shell id ('pwsh', 'powershell', 'cmd', 'git-bash', 'wsl', 'zsh', ...)
 * @param dir the bundled marketplace folder
 */
export function latexMathInstallLine(shellId: string, dir: string): string {
  const separator = shellId === 'cmd' ? ' && ' : '; ';
  return `${latexMathMarketplaceCommand(dir, shellId)}${separator}${LATEX_MATH_INSTALL_COMMAND}`;
}
