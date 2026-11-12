/**
 * @file src/main/code-lint.test.ts
 * @purpose Tests for running installed linters on saved code files (ADR-040). No real tool
 *   runs: PATH lookup and the child process are injected. Config lookup uses a temp folder.
 */
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  findSqlfluffConfig,
  lintCodeFile,
  parseLintrOutput,
  parseRuffOutput,
  parseSqlfluffOutput,
  type CodeLintDeps,
  type RunResult,
} from './code-lint';

const ROOT = process.platform === 'win32' ? 'C:\\work' : '/work';
const file = (name: string): string => join(ROOT, name);

interface Call {
  exe: string;
  args: string[];
  input?: string | undefined;
  timeoutMs: number;
}

function fakeDeps(opts: {
  onPath?: Record<string, string[]>;
  known?: string[];
  existing?: string[];
  texts?: Record<string, string>;
  result?: Partial<RunResult>;
}): { deps: CodeLintDeps; calls: Call[] } {
  const calls: Call[] = [];
  const deps: CodeLintDeps = {
    findOnPath: (command) => opts.onPath?.[command] ?? [],
    knownToolPaths: () => opts.known ?? [],
    exists: (path) => (opts.existing ?? []).includes(path),
    readText: async (path) => opts.texts?.[path] ?? null,
    run: async (exe, args, o) => {
      calls.push({ exe, args, input: o.input, timeoutMs: o.timeoutMs });
      return { code: 0, stdout: '[]', stderr: '', timedOut: false, ...opts.result };
    },
  };
  return { deps, calls };
}

describe('parseRuffOutput', () => {
  it('reads positions and makes syntax errors and undefined names errors', () => {
    const out = JSON.stringify([
      {
        code: 'F401',
        message: '`os` imported but unused',
        location: { row: 1, column: 8 },
        end_location: { row: 1, column: 10 },
      },
      {
        code: 'F821',
        message: 'Undefined name `pd`',
        location: { row: 7, column: 10 },
        end_location: { row: 7, column: 12 },
      },
      {
        code: null,
        message: 'SyntaxError: Expected an expression',
        location: { row: 3, column: 5 },
        end_location: { row: 3, column: 6 },
      },
      {
        code: 'invalid-syntax',
        message: 'Unexpected indentation',
        location: { row: 1, column: 1 },
        end_location: { row: 1, column: 2 },
      },
    ]);
    expect(parseRuffOutput(out)).toEqual([
      {
        line: 1,
        column: 8,
        endLine: 1,
        endColumn: 10,
        severity: 'warning',
        code: 'F401',
        message: '`os` imported but unused',
      },
      {
        line: 7,
        column: 10,
        endLine: 7,
        endColumn: 12,
        severity: 'error',
        code: 'F821',
        message: 'Undefined name `pd`',
      },
      {
        line: 3,
        column: 5,
        endLine: 3,
        endColumn: 6,
        severity: 'error',
        code: '',
        message: 'SyntaxError: Expected an expression',
      },
      {
        line: 1,
        column: 1,
        endLine: 1,
        endColumn: 2,
        severity: 'error',
        code: 'invalid-syntax',
        message: 'Unexpected indentation',
      },
    ]);
  });

  it('skips a line printed before the JSON and rejects output that is not JSON', () => {
    expect(parseRuffOutput('Installed 1 package in 10ms\n[]')).toEqual([]);
    expect(parseRuffOutput('error: unexpected argument')).toBeNull();
  });
});

describe('parseLintrOutput', () => {
  it('reads tab-separated problems and turns style into info', () => {
    const out =
      'renv: project loaded\r\n' +
      '3\t6\twarning\tobject_usage_linter\tno visible binding\r\n' +
      '1\t2\tstyle\tinfix_spaces_linter\tPut spaces around all infix operators.\r\n';
    expect(parseLintrOutput(out)).toEqual([
      {
        line: 3,
        column: 6,
        severity: 'warning',
        code: 'object_usage_linter',
        message: 'no visible binding',
      },
      {
        line: 1,
        column: 2,
        severity: 'info',
        code: 'infix_spaces_linter',
        message: 'Put spaces around all infix operators.',
      },
    ]);
  });

  it('returns null when R has no lintr package', () => {
    expect(parseLintrOutput('CETERIS_NO_LINTR\r\n')).toBeNull();
  });
});

describe('parseSqlfluffOutput', () => {
  it('reads both the 2.x and the 1.x field names; parse errors are errors', () => {
    const out = JSON.stringify([
      {
        filepath: 'stdin',
        violations: [
          {
            start_line_no: 1,
            start_line_pos: 1,
            code: 'LT09',
            description: 'Select targets should be on a new line.',
          },
          {
            line_no: 4,
            line_pos: 3,
            code: 'PRS',
            description: 'Line 4, Position 3: Found unparsable section',
          },
        ],
      },
    ]);
    expect(parseSqlfluffOutput(out)).toEqual([
      {
        line: 1,
        column: 1,
        endLine: 1,
        endColumn: 1,
        severity: 'warning',
        code: 'LT09',
        message: 'Select targets should be on a new line.',
      },
      {
        line: 4,
        column: 3,
        endLine: 4,
        endColumn: 3,
        severity: 'error',
        code: 'PRS',
        message: 'Line 4, Position 3: Found unparsable section',
      },
    ]);
  });
});

describe('findSqlfluffConfig', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'ceteris-code-lint-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });
  const read = (path: string): Promise<string | null> =>
    fs.readFile(path, 'utf8').catch(() => null);

  it('finds the nearest config above the file and whether it sets a dialect', async () => {
    const sub = join(dir, 'queries', 'daily');
    await fs.mkdir(sub, { recursive: true });
    await fs.writeFile(join(dir, 'pyproject.toml'), '[tool.sqlfluff.core]\ndialect = "sparksql"\n');
    expect(await findSqlfluffConfig(sub, read)).toEqual({
      path: join(dir, 'pyproject.toml'),
      hasDialect: true,
    });
    await fs.writeFile(join(dir, 'queries', '.sqlfluff'), '[sqlfluff]\nmax_line_length = 100\n');
    expect(await findSqlfluffConfig(sub, read)).toEqual({
      path: join(dir, 'queries', '.sqlfluff'),
      hasDialect: false,
    });
  });

  it('ignores a pyproject.toml without a sqlfluff section', async () => {
    await fs.writeFile(join(dir, 'pyproject.toml'), '[tool.ruff]\nline-length = 100\n');
    const found = await findSqlfluffConfig(dir, read);
    expect(found?.path).not.toBe(join(dir, 'pyproject.toml'));
  });
});

describe('lintCodeFile', () => {
  it('runs ruff from PATH without fixing or leaving a cache folder', async () => {
    const { deps, calls } = fakeDeps({ onPath: { ruff: ['/bin/ruff'], uvx: ['/bin/uvx'] } });
    const res = await lintCodeFile({ path: file('clean.py') }, deps);
    expect(res).toEqual({ ok: true, tool: 'ruff', problems: [] });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.exe).toBe('/bin/ruff');
    expect(calls[0]?.args).toEqual(
      expect.arrayContaining(['check', '--no-fix', '--no-cache', file('clean.py')]),
    );
    expect(calls[0]?.args).not.toContain('--fix');
  });

  it('falls back to uvx with a longer timeout, and skips .cmd shims', async () => {
    const { deps, calls } = fakeDeps({
      onPath: { ruff: ['C:\\x\\ruff.cmd'], uvx: ['C:\\uv\\uvx.exe'] },
    });
    await lintCodeFile({ path: file('a.py') }, deps);
    expect(calls[0]?.exe).toBe('C:\\uv\\uvx.exe');
    expect(calls[0]?.args[0]).toBe('ruff');
    expect(calls[0]?.timeoutMs ?? 0).toBeGreaterThan(60_000);
  });

  it('says not-installed when neither the tool nor uvx is there', async () => {
    const { deps, calls } = fakeDeps({});
    expect(await lintCodeFile({ path: file('a.sql') }, deps)).toEqual({
      ok: false,
      tool: 'sqlfluff',
      reason: 'not-installed',
    });
    expect(calls).toHaveLength(0);
  });

  it('pipes SQL on stdin with the hive dialect for .hive files', async () => {
    const path = file('etl.hive');
    const { deps, calls } = fakeDeps({
      onPath: { sqlfluff: ['/bin/sqlfluff'] },
      texts: { [path]: 'select 1' },
    });
    await lintCodeFile({ path }, deps);
    expect(calls[0]?.args).toEqual([
      'lint',
      '-',
      '--format',
      'json',
      '--nocolor',
      '--dialect',
      'hive',
    ]);
    expect(calls[0]?.input).toBe('select 1');
  });

  it('leaves the dialect to a sqlfluff config that names one', async () => {
    const path = file('q.sql');
    const { deps, calls } = fakeDeps({
      onPath: { sqlfluff: ['/bin/sqlfluff'] },
      texts: { [path]: 'select 1', [file('.sqlfluff')]: '[sqlfluff]\ndialect = bigquery\n' },
    });
    await lintCodeFile({ path }, deps);
    expect(calls[0]?.args).not.toContain('--dialect');
  });

  it('finds Rscript where the R installer put it when PATH has none', async () => {
    const rscript = 'C:\\Program Files\\R\\R-4.5.2\\bin\\Rscript.exe';
    const { deps, calls } = fakeDeps({
      known: ['C:\\gone\\Rscript.exe', rscript],
      existing: [rscript],
      result: { stdout: '' },
    });
    const res = await lintCodeFile({ path: file('model.Rmd') }, deps);
    expect(res).toEqual({ ok: true, tool: 'lintr', problems: [] });
    expect(calls[0]?.exe).toBe(rscript);
    expect(calls[0]?.args[0]).toBe('-e');
    expect(calls[0]?.args[2]).toBe(file('model.Rmd'));
  });

  it('says not-installed when R has no lintr package', async () => {
    const { deps } = fakeDeps({
      onPath: { Rscript: ['/usr/bin/Rscript'] },
      result: { stdout: 'CETERIS_NO_LINTR\n' },
    });
    expect(await lintCodeFile({ path: file('a.R') }, deps)).toEqual({
      ok: false,
      tool: 'lintr',
      reason: 'not-installed',
    });
  });

  it('reports a tool that fails with its first error line', async () => {
    const { deps } = fakeDeps({
      onPath: { ruff: ['/bin/ruff'] },
      result: { code: 2, stdout: '', stderr: '\nruff failed\n  Cause: invalid config\n' },
    });
    expect(await lintCodeFile({ path: file('a.py') }, deps)).toEqual({
      ok: false,
      tool: 'ruff',
      reason: 'failed',
      detail: 'ruff failed',
    });
  });

  it('reports a timeout and a tool that cannot start', async () => {
    const slow = fakeDeps({
      onPath: { ruff: ['/bin/ruff'] },
      result: { timedOut: true, code: null },
    });
    const res = await lintCodeFile({ path: file('a.py') }, slow.deps);
    expect(res).toMatchObject({ ok: false, reason: 'failed' });
    const broken = fakeDeps({ onPath: { ruff: ['/bin/ruff'] }, result: { spawnError: 'EACCES' } });
    expect(await lintCodeFile({ path: file('a.py') }, broken.deps)).toMatchObject({
      ok: false,
      reason: 'failed',
      detail: expect.stringContaining('EACCES'),
    });
  });

  it.each([['relative.py'], [file('a.jl')], [file('a.txt')], ['']])('refuses %s', async (path) => {
    const { deps, calls } = fakeDeps({ onPath: { ruff: ['/bin/ruff'] } });
    expect(await lintCodeFile({ path }, deps)).toMatchObject({ ok: false, reason: 'unsupported' });
    expect(calls).toHaveLength(0);
  });
});
