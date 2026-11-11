/**
 * @file src/shared/code-files.ts
 * @purpose Which code and data files the file viewer opens as editable text, how the editor
 *   shows each one (language, line numbers, wrapping), and which installed linter checks it
 *   after a save (ADR-040). Also the request and response types of the lint command.
 *
 * @关键设计:
 * - One table, keyed by lower-case extension. file-tree.ts derives its list of text types from
 *   it, so adding a row here is all it takes for a new extension to open, save and highlight.
 * - The language is only a name. The renderer maps it to a CodeMirror mode; main never loads
 *   CodeMirror.
 * - Lint runs tools the user already has (ruff, lintr, sqlfluff). Ceteris never bundles one,
 *   so a type without a common command-line linter (Julia, Stata, MATLAB) is highlight only.
 *
 * @对应文档章节: 软件定义书.md ADR-040, 14.6; ipc-protocol.md 5.12
 *
 * @不要在这里做的事:
 * - 不要在这里 import CodeMirror 或 Node 模块:main 和 renderer 都引用这个文件
 * - 不要给没有命令行 linter 的语言硬配一个:配错的 linter 只会报一堆假问题
 */

/** A CodeMirror mode the renderer knows. Null in a row means plain text. */
export type CodeLanguage =
  | 'python'
  | 'r'
  | 'julia'
  | 'sql'
  | 'hive'
  | 'stata'
  | 'octave'
  | 'sas'
  | 'fortran'
  | 'cpp'
  | 'json'
  | 'stex'
  | 'yaml'
  | 'toml'
  | 'shell'
  | 'powershell'
  | 'properties';

/** A command-line linter Ceteris knows how to run and read. */
export type LinterId = 'ruff' | 'lintr' | 'sqlfluff';

export interface CodeFileInfo {
  language: CodeLanguage | null;
  linter: LinterId | null;
  /** Prose wraps at the panel edge; code and tables scroll sideways. */
  wrap: boolean;
  lineNumbers: boolean;
}

const code = (language: CodeLanguage | null, linter: LinterId | null = null): CodeFileInfo => ({
  language,
  linter,
  wrap: false,
  lineNumbers: true,
});
const prose: CodeFileInfo = { language: null, linter: null, wrap: true, lineNumbers: false };

const CODE_FILES: Record<string, CodeFileInfo> = {
  // Prose, edited since ADR-016 and ADR-028.
  txt: prose,
  md: prose,
  markdown: prose,
  log: prose,
  tex: { language: 'stex', linter: null, wrap: true, lineNumbers: true },
  bib: { language: null, linter: null, wrap: true, lineNumbers: true },
  json: code('json'),
  // Analysis code.
  py: code('python', 'ruff'),
  r: code('r', 'lintr'),
  // lintr reads the R chunks of R Markdown and Quarto and skips the others.
  rmd: { language: null, linter: 'lintr', wrap: true, lineNumbers: true },
  qmd: { language: null, linter: 'lintr', wrap: true, lineNumbers: true },
  jl: code('julia'),
  sql: code('sql', 'sqlfluff'),
  hive: code('hive', 'sqlfluff'),
  do: code('stata'),
  ado: code('stata'),
  m: code('octave'),
  // Dynare model files use MATLAB syntax for everything outside their blocks.
  mod: code('octave'),
  sas: code('sas'),
  gms: code(null),
  f: code('fortran'),
  f90: code('fortran'),
  cpp: code('cpp'),
  // Configuration and scripts.
  yaml: code('yaml'),
  yml: code('yaml'),
  toml: code('toml'),
  ini: code('properties'),
  cfg: code('properties'),
  sh: code('shell'),
  ps1: code('powershell'),
  // Data as text: wide rows scroll instead of wrapping, so columns stay in line.
  csv: code(null),
  tsv: code(null),
};

/** Extensions, lower case without the dot, that open in the text editor. */
export const EDITABLE_TEXT_EXTENSIONS: readonly string[] = Object.keys(CODE_FILES);

function extensionOf(name: string): string | null {
  return /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? null;
}

/** How the editor shows a file, or null when the viewer does not edit this type. */
export function codeFileInfo(name: string): CodeFileInfo | null {
  const ext = extensionOf(name);
  if (ext === null || !Object.prototype.hasOwnProperty.call(CODE_FILES, ext)) return null;
  return CODE_FILES[ext] ?? null;
}

/**
 * The sqlfluff dialect for a file when no sqlfluff config says otherwise. sqlfluff refuses to
 * lint without one; ANSI is its neutral choice.
 */
export function defaultSqlDialect(name: string): 'hive' | 'ansi' {
  return extensionOf(name) === 'hive' ? 'hive' : 'ansi';
}

// ── Lint command (COMMAND_CHANNELS.CODE_LINT) ──────────────────────

export type LintSeverity = 'error' | 'warning' | 'info';

/** One problem. Lines and columns count from 1, as every linter prints them. */
export interface LintProblem {
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  severity: LintSeverity;
  /** Rule name such as F401 or object_name_linter. Empty when the tool gives none. */
  code: string;
  message: string;
}

export interface LintPayload {
  /** Absolute path of a saved file whose type has a linter. */
  path: string;
}

/**
 * - not-installed: neither the tool nor a way to run it (uvx, Rscript) was found, or R has no
 *   lintr package. The renderer shows how to install it.
 * - unsupported: the path is not absolute or its type has no linter.
 * - failed: the tool ran but gave no readable result; `detail` holds its first error line.
 */
export type LintResponse =
  | { ok: true; tool: LinterId; problems: LintProblem[] }
  | { ok: false; tool: LinterId | null; reason: 'not-installed' | 'unsupported' }
  | { ok: false; tool: LinterId; reason: 'failed'; detail: string };
