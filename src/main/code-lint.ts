/**
 * @file src/main/code-lint.ts
 * @purpose Runs the linter the user has installed on a code file the viewer just saved, and
 *   turns its output into a list of problems (ADR-040): ruff for Python, lintr for R, R
 *   Markdown and Quarto, sqlfluff for SQL and HiveQL.
 *
 * @关键设计:
 * - Nothing is bundled. A tool on PATH runs first. ruff and sqlfluff can also run through
 *   `uvx`, which fetches them once into uv's cache; R needs Rscript (PATH, or where the R
 *   installer put it, see PlatformAdapter.knownToolPaths) with the lintr package.
 * - Each tool is asked for machine output (ruff and sqlfluff JSON, lintr tab-separated lines
 *   printed by a one-line R script), so no human-readable format is ever parsed.
 * - ruff runs with --no-cache: its cache folder would otherwise appear in the user's project.
 * - sqlfluff reads the text on stdin, so any extension works (.hive is not one it knows). It
 *   gets a --dialect only when no sqlfluff config with a dialect is found above the file.
 * - Over Link this command runs on the host, like the save before it: the file lives there.
 * - Only .exe or extensionless hits are run. A .cmd or .bat shim would need a shell, and file
 *   paths would then pass through cmd.exe quoting.
 *
 * @对应文档章节: 软件定义书.md ADR-040; ipc-protocol.md 5.12
 *
 * @不要在这里做的事:
 * - 不要用 --fix 或任何会改文件的参数:lint 只读,改文件只走查看器的保存
 * - 不要在没有 linter 时去下载、安装:没装就告诉用户怎么装
 */
import { spawn } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join } from 'node:path';
import {
  codeFileInfo,
  defaultSqlDialect,
  type LinterId,
  type LintPayload,
  type LintProblem,
  type LintResponse,
  type LintSeverity,
} from '@shared/code-files';
import { findOnPath } from './agent-versions';
import { logger } from './logger';
import type { PlatformAdapter } from './platform';

const RUN_TIMEOUT_MS = 60_000;
/** uvx downloads the tool the first time, which can take a while on a slow network. */
const UVX_TIMEOUT_MS = 180_000;
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

/** Printed by the R script when the lintr package is missing. */
const NO_LINTR_MARKER = 'CETERIS_NO_LINTR';

/**
 * One line of R, single quotes only, so Windows argument quoting leaves it alone. Prints one
 * problem per line: line, column, type, linter, message, separated by tabs.
 */
const LINTR_SCRIPT =
  "a <- commandArgs(TRUE); if (!requireNamespace('lintr', quietly = TRUE)) " +
  `{ cat('${NO_LINTR_MARKER}\\n'); quit(status = 0) }; ` +
  'for (x in lintr::lint(a[1])) cat(paste(x$line_number, x$column_number, x$type, x$linter, ' +
  "gsub('[\\t\\r\\n]+', ' ', x$message), sep = '\\t'), '\\n', sep = '')";

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Set when the program could not start at all. */
  spawnError?: string;
}

export interface CodeLintDeps {
  /** PATH hits of a command, first one wins. */
  findOnPath(command: string): string[];
  /** Install locations of Rscript when it is not on PATH. */
  knownToolPaths(tool: 'Rscript'): string[];
  exists(path: string): boolean;
  readText(path: string): Promise<string | null>;
  run(
    exe: string,
    args: string[],
    opts: { cwd: string; input?: string | undefined; timeoutMs: number },
  ): Promise<RunResult>;
}

interface Command {
  exe: string;
  args: string[];
  timeoutMs: number;
}

/** A hit that can start without a shell. */
function runnable(hits: string[]): string | null {
  return hits.find((hit) => !/\.(cmd|bat|ps1)$/i.test(hit)) ?? null;
}

/** The tool itself, or the same tool through uvx, or null when neither is there. */
function pythonTool(tool: 'ruff' | 'sqlfluff', args: string[], deps: CodeLintDeps): Command | null {
  const direct = runnable(deps.findOnPath(tool));
  if (direct) return { exe: direct, args, timeoutMs: RUN_TIMEOUT_MS };
  const uvx = runnable(deps.findOnPath('uvx'));
  if (uvx) return { exe: uvx, args: [tool, ...args], timeoutMs: UVX_TIMEOUT_MS };
  return null;
}

function findRscript(deps: CodeLintDeps): string | null {
  return (
    runnable(deps.findOnPath('Rscript')) ??
    deps.knownToolPaths('Rscript').find((path) => deps.exists(path)) ??
    null
  );
}

/**
 * The nearest sqlfluff config above the file, if any, and whether it names a dialect. Looks
 * at the files sqlfluff itself reads: .sqlfluff, and a sqlfluff section of pyproject.toml,
 * setup.cfg or tox.ini.
 */
export async function findSqlfluffConfig(
  dir: string,
  readText: (path: string) => Promise<string | null>,
): Promise<{ path: string; hasDialect: boolean } | null> {
  const sections: Array<[string, RegExp]> = [
    ['.sqlfluff', /^/],
    ['pyproject.toml', /^\s*\[tool\.sqlfluff/m],
    ['setup.cfg', /^\s*\[sqlfluff/m],
    ['tox.ini', /^\s*\[sqlfluff/m],
  ];
  let current = dir;
  for (;;) {
    for (const [name, section] of sections) {
      const path = join(current, name);
      const text = await readText(path);
      if (text !== null && section.test(text)) {
        return { path, hasDialect: /^\s*dialect\s*=/m.test(text) };
      }
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

// ── Output parsers ────────────────────────────────────────────────

function positive(value: unknown, fallback = 1): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1
    ? Math.floor(value)
    : fallback;
}

/** JSON from the first `[`: uvx and sqlfluff may print a line before it. */
function jsonArray(stdout: string): unknown[] | null {
  const at = stdout.indexOf('[');
  if (at < 0) return null;
  try {
    const value: unknown = JSON.parse(stdout.slice(at));
    return Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * `ruff check --output-format json`. Syntax errors (no code, invalid-syntax since ruff 0.12, or E9xx) and undefined names
 * (F82x) are errors: the script will not run. Everything else is a warning.
 */
export function parseRuffOutput(stdout: string): LintProblem[] | null {
  const items = jsonArray(stdout);
  if (!items) return null;
  return items.flatMap((item): LintProblem[] => {
    if (typeof item !== 'object' || item === null) return [];
    const r = item as Record<string, unknown>;
    const loc = (r.location ?? {}) as Record<string, unknown>;
    const end = (r.end_location ?? {}) as Record<string, unknown>;
    const code = typeof r.code === 'string' ? r.code : '';
    const severity: LintSeverity =
      code === '' || code === 'invalid-syntax' || /^(E9|F82)/.test(code) ? 'error' : 'warning';
    return [
      {
        line: positive(loc.row),
        column: positive(loc.column),
        endLine: positive(end.row, positive(loc.row)),
        endColumn: positive(end.column, positive(loc.column)),
        severity,
        code,
        message: typeof r.message === 'string' ? r.message : '',
      },
    ];
  });
}

/**
 * The tab-separated lines of LINTR_SCRIPT. Null when lintr is missing. lintr's types are
 * error, warning and style; style becomes info.
 */
export function parseLintrOutput(stdout: string): LintProblem[] | null {
  if (stdout.includes(NO_LINTR_MARKER)) return null;
  const problems: LintProblem[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const parts = line.split('\t');
    if (parts.length < 5) continue;
    const [lineNo, column, type, linter, ...message] = parts;
    const severity: LintSeverity =
      type === 'error' ? 'error' : type === 'warning' ? 'warning' : 'info';
    problems.push({
      line: positive(Number(lineNo)),
      column: positive(Number(column)),
      severity,
      code: linter ?? '',
      message: message.join(' ').trim(),
    });
  }
  return problems;
}

/**
 * `sqlfluff lint --format json`. Field names changed in 2.0 (line_no became start_line_no);
 * both are read. A parse or templating failure (PRS, TMP) is an error, rules are warnings.
 */
export function parseSqlfluffOutput(stdout: string): LintProblem[] | null {
  const files = jsonArray(stdout);
  if (!files) return null;
  return files.flatMap((file): LintProblem[] => {
    const violations = (file as { violations?: unknown })?.violations;
    if (!Array.isArray(violations)) return [];
    return violations.flatMap((v): LintProblem[] => {
      if (typeof v !== 'object' || v === null) return [];
      const r = v as Record<string, unknown>;
      const line = positive(r.start_line_no ?? r.line_no);
      const column = positive(r.start_line_pos ?? r.line_pos);
      const code = typeof r.code === 'string' ? r.code : '';
      return [
        {
          line,
          column,
          endLine: positive(r.end_line_no, line),
          endColumn: positive(r.end_line_pos, column),
          severity: code === 'PRS' || code === 'TMP' ? 'error' : 'warning',
          code,
          message: typeof r.description === 'string' ? r.description : '',
        },
      ];
    });
  });
}

/** First non-empty line of stderr, for the viewer to show. */
function firstLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find(Boolean)
      ?.slice(0, 300) ?? ''
  );
}

/**
 * Lints one saved file.
 *
 * @param payload absolute path of a file whose type has a linter (codeFileInfo)
 * @returns the problems, or why there are none to show. Never throws: a tool that crashes,
 *   hangs or prints nonsense comes back as reason 'failed' with its first error line.
 * @sideeffect starts one child process, read-only on the file
 */
export async function lintCodeFile(
  payload: LintPayload,
  deps: CodeLintDeps,
): Promise<LintResponse> {
  const path = typeof payload?.path === 'string' ? payload.path : '';
  const tool: LinterId | null = codeFileInfo(basename(path))?.linter ?? null;
  if (!tool || !isAbsolute(path)) return { ok: false, tool, reason: 'unsupported' };
  const cwd = dirname(path);

  let command: Command | null;
  let parse: (stdout: string) => LintProblem[] | null;
  if (tool === 'ruff') {
    command = pythonTool(
      'ruff',
      ['check', '--output-format', 'json', '--no-fix', '--no-cache', '--exit-zero', path],
      deps,
    );
    parse = parseRuffOutput;
  } else if (tool === 'sqlfluff') {
    const config = await findSqlfluffConfig(cwd, deps.readText);
    const dialect = config?.hasDialect ? [] : ['--dialect', defaultSqlDialect(path)];
    command = pythonTool(
      'sqlfluff',
      ['lint', '-', '--format', 'json', '--nocolor', ...dialect],
      deps,
    );
    parse = parseSqlfluffOutput;
  } else {
    const rscript = findRscript(deps);
    command = rscript
      ? { exe: rscript, args: ['-e', LINTR_SCRIPT, path], timeoutMs: RUN_TIMEOUT_MS }
      : null;
    parse = parseLintrOutput;
  }
  if (!command) {
    logger.info('code-lint', `no ${tool} for ${extname(path)} file`);
    return { ok: false, tool, reason: 'not-installed' };
  }
  let input: string | undefined;
  if (tool === 'sqlfluff') {
    const text = await deps.readText(path);
    if (text === null) {
      return { ok: false, tool, reason: 'failed', detail: `Could not read ${basename(path)}` };
    }
    input = text;
  }

  const started = Date.now();
  const result = await deps.run(command.exe, command.args, {
    cwd,
    input,
    timeoutMs: command.timeoutMs,
  });
  if (result.spawnError || result.timedOut) {
    const detail = result.timedOut
      ? `${tool} took longer than ${Math.round(command.timeoutMs / 1000)} s`
      : `${tool} could not start: ${result.spawnError}`;
    logger.warn('code-lint', `${tool} failed: exe=${command.exe} ${detail}`);
    return { ok: false, tool, reason: 'failed', detail };
  }
  if (tool === 'lintr' && result.stdout.includes(NO_LINTR_MARKER)) {
    return { ok: false, tool, reason: 'not-installed' };
  }
  const problems = parse(result.stdout);
  if (problems === null) {
    const detail = firstLine(result.stderr) || `${tool} exited with code ${result.code}`;
    logger.warn(
      'code-lint',
      `${tool} gave no result: exe=${command.exe} code=${result.code} ${detail}`,
    );
    return { ok: false, tool, reason: 'failed', detail };
  }
  logger.info(
    'code-lint',
    `${tool} on ${extname(path)} file: ${problems.length} problems in ${Date.now() - started} ms`,
  );
  return { ok: true, tool, problems };
}

/** Starts a program without a shell, feeds it `input` and collects its output. */
function runProgram(
  env: Record<string, string>,
  exe: string,
  args: string[],
  opts: { cwd: string; input?: string | undefined; timeoutMs: number },
): Promise<RunResult> {
  return new Promise((resolve) => {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    let timedOut = false;
    let settled = false;
    const finish = (result: RunResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(exe, args, { cwd: opts.cwd, env, windowsHide: true });
    } catch (e) {
      resolve({ code: null, stdout: '', stderr: '', timedOut: false, spawnError: String(e) });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, opts.timeoutMs);
    const collect = (into: Buffer[]) => (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_OUTPUT_BYTES) {
        child.kill();
        return;
      }
      into.push(chunk);
    };
    child.stdout?.on('data', collect(out));
    child.stderr?.on('data', collect(err));
    child.on('error', (e) =>
      finish({ code: null, stdout: '', stderr: '', timedOut: false, spawnError: e.message }),
    );
    child.on('close', (code) =>
      finish({
        code,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        timedOut,
      }),
    );
    // A tool that exits before reading stdin makes the write fail with EPIPE; the exit code
    // and output still tell what happened.
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(opts.input ?? '');
  });
}

/** The production linter: PATH from the platform layer, so a tool installed now is found. */
export function createCodeLinter(
  adapter: PlatformAdapter,
): (payload: LintPayload) => Promise<LintResponse> {
  const buildEnv = (): Record<string, string> => {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') env[k] = v;
    const path = adapter.getRefreshedPath();
    if (path) {
      env.PATH = path;
      env.Path = path;
    }
    // Python tools print UTF-8 JSON even under a legacy Windows code page.
    env.PYTHONIOENCODING = 'utf-8';
    adapter.normalizeSpawnEnv(env);
    return env;
  };
  return (payload) => {
    const env = buildEnv();
    return lintCodeFile(payload, {
      findOnPath: (command) => findOnPath(command, env),
      knownToolPaths: (tool) => adapter.knownToolPaths?.(tool) ?? [],
      exists: (path) => existsSync(path),
      readText: (path) => fs.readFile(path, 'utf8').catch(() => null),
      run: (exe, args, opts) => runProgram(env, exe, args, opts),
    });
  };
}
