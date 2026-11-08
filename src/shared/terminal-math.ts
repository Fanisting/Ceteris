/**
 * @file terminal-math.ts
 * @purpose Finds LaTeX math written as plain text in terminal output, and builds the command that
 *          tells Codex to write its formulas that way. Part of the "Codex formula rendering"
 *          extension (ADR-022, settings.extensions.terminalMath).
 *
 * @关键设计:
 * - Codex has no render hook and turns the TeX it understands into Unicode text before printing.
 *   Inline code is the one place it leaves untouched, so Codex is asked to write `$$...$$` for a
 *   display formula and `\(...\)` for inline math inside inline code. The delimiters then reach
 *   the terminal literally and Ceteris typesets them (renderer/terminal-math-overlay.ts).
 * - A match must hold real TeX (a backslash, ^, _ or {), so PowerShell's `$$` variable, bash's
 *   PID and prices such as "$5 and $10" are left alone. `\[...\]` is accepted too.
 * - A formula is drawn as display math only when it is the whole line (leading and trailing
 *   spaces aside) and uses $$ or \[; otherwise it is drawn inline, one row tall.
 *
 * @不要在这里做的事:
 * - Do not touch the terminal or the DOM here: this module only reads strings.
 */

/** One formula found in a line of terminal text. Offsets are string indices, end exclusive. */
export interface MathSpan {
  start: number;
  end: number;
  /** The TeX between the delimiters, trimmed */
  tex: string;
  display: boolean;
}

const MATH = /\$\$([^$]+?)\$\$|\\\[(.+?)\\\]|\\\((.+?)\\\)/g;
const TEX_SIGNAL = /[\\^_{]/;
/** Longer bodies are not math a reply would show on one screen; also bounds the work per line. */
const MAX_TEX = 1000;

/** Finds the formulas in one logical line of terminal text, left to right. */
export function findTerminalMath(line: string): MathSpan[] {
  const spans: MathSpan[] = [];
  for (const match of line.matchAll(MATH)) {
    const body = (match[1] ?? match[2] ?? match[3] ?? '').trim();
    if (body.length === 0 || body.length > MAX_TEX) continue;
    // `\(` and `\[` are signal enough (a single letter such as \(Q\) is math); $$ also appears as
    // PowerShell's last-token variable and bash's PID, so its body must hold TeX.
    if (match[1] !== undefined && !TEX_SIGNAL.test(body)) continue;
    const start = match.index ?? 0;
    const end = start + match[0].length;
    const wholeLine = line.slice(0, start).trim() === '' && line.slice(end).trim() === '';
    const displayDelimiter = match[3] === undefined;
    spans.push({ start, end, tex: body, display: wholeLine && displayDelimiter });
  }
  return spans;
}

/** The instruction appended to ~/.codex/AGENTS.md. No ' (it is single-quoted) and no cmd metacharacters. */
export const CODEX_MATH_INSTRUCTION =
  'When you write math, put each formula in inline code with LaTeX delimiters: `$$...$$` on its own line, with an empty line before and after it, for a display formula, and `\\(...\\)` for inline math. The Ceteris terminal typesets these.';

/** A phrase of the instruction, used to skip appending it twice. */
const MARKER = 'The Ceteris terminal typesets these';

/**
 * One line that appends the instruction to the Codex global instructions file once, for the
 * given shell. Typed into a terminal without Enter, so the user's Enter is the consent.
 */
export function codexMathInstructionCommand(shellId: string): string {
  if (shellId === 'cmd') {
    // No parentheses around echo: the ")" in "\(...\)" would close the group. cmd binds || tighter
    // than &, so this is: mkdir (an existing folder only prints an error, hidden); then findstr || echo.
    const file = '"%USERPROFILE%\\.codex\\AGENTS.md"';
    return (
      `mkdir "%USERPROFILE%\\.codex" 2>nul & ` +
      // The redirection goes before echo, so no trailing space lands in the file.
      `findstr /c:"${MARKER}" ${file} >nul 2>&1 || >>${file} echo ${CODEX_MATH_INSTRUCTION}`
    );
  }
  if (shellId === 'pwsh' || shellId === 'powershell') {
    return (
      `$f = Join-Path $HOME '.codex\\AGENTS.md'; ` +
      `New-Item -ItemType Directory -Force (Split-Path $f) | Out-Null; ` +
      // A missing file is a terminating error for Select-String, so Test-Path comes first.
      `if (-not ((Test-Path $f) -and (Select-String -Quiet -SimpleMatch '${MARKER}' $f))) ` +
      `{ Add-Content -Path $f -Value '${CODEX_MATH_INSTRUCTION}' }`
    );
  }
  return (
    `mkdir -p ~/.codex && { grep -qsF '${MARKER}' ~/.codex/AGENTS.md || ` +
    `printf '%s\\n' '${CODEX_MATH_INSTRUCTION}' >> ~/.codex/AGENTS.md; }`
  );
}
