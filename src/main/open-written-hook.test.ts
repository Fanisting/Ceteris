/**
 * @file open-written-hook.test.ts
 * @purpose The ceteris-tabs PostToolUse hook (extensions/ceteris-tabs/hooks/open-written.mjs,
 *   ADR-058): which file it shows after a Write, Edit or Bash call. Pure rules with a fake file
 *   system; the pipe request itself is the existing open-file op, tested in
 *   tab-control-mcp.test.ts.
 */
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BUILD_WINDOW_MS,
  builtPdf,
  fileToOpen,
  isAgentBookkeeping,
  type HookFs,
} from '../../extensions/ceteris-tabs/hooks/open-written.mjs';

const NOW = 1_000_000_000_000;
const HOME = resolve('/home/u');
const TEMP = resolve('/tmp');
const PROJ = resolve('/home/u/projects/example');

/** A file system holding the given files with their mtimes. */
function fakeFs(files: Record<string, number>): HookFs {
  const byPath = new Map(Object.entries(files).map(([p, t]) => [resolve(p), t]));
  return {
    mtime: (p) => byPath.get(resolve(p)) ?? null,
    list: (dir) =>
      [...byPath.keys()]
        .filter((p) => resolve(p, '..') === resolve(dir))
        .map((p) => p.slice(resolve(dir).length + 1)),
  };
}

function open(input: unknown, files: Record<string, number> = {}): string | null {
  return fileToOpen(input, { now: NOW, home: HOME, temp: TEMP, fs: fakeFs(files) });
}

describe('fileToOpen: file tools', () => {
  it('shows the file a Write, Edit or MultiEdit names, relative paths from the tab folder', () => {
    for (const tool of ['Write', 'Edit', 'MultiEdit']) {
      expect(open({ tool_name: tool, cwd: PROJ, tool_input: { file_path: 'src/app.ts' } })).toBe(
        join(PROJ, 'src/app.ts'),
      );
    }
  });

  it('ignores other tools and inputs without a path', () => {
    expect(open({ tool_name: 'Read', cwd: PROJ, tool_input: { file_path: 'a.md' } })).toBeNull();
    expect(open({ tool_name: 'Write', cwd: PROJ, tool_input: {} })).toBeNull();
    expect(open(null)).toBeNull();
  });

  it('never shows agent memory, plans, scratch files or git and omc state', () => {
    const write = (file_path: string) =>
      open({ tool_name: 'Write', cwd: PROJ, tool_input: { file_path } });
    expect(write(join(HOME, '.claude/projects/x/memory/a.md'))).toBeNull();
    expect(write(join(HOME, '.codex/AGENTS.md'))).toBeNull();
    expect(write(join(TEMP, 'claude/scratch/notes.md'))).toBeNull();
    expect(write('.git/COMMIT_EDITMSG')).toBeNull();
    expect(write('.omc/state/x.json')).toBeNull();
  });
});

describe('isAgentBookkeeping', () => {
  it('matches folder boundaries, not name prefixes', () => {
    expect(isAgentBookkeeping(join(HOME, '.claude-notes/a.md'), HOME, TEMP)).toBe(false);
    expect(isAgentBookkeeping(join(HOME, '.claude/a.md'), HOME, TEMP)).toBe(true);
  });
});

describe('builtPdf', () => {
  const fresh = NOW - 5_000;

  it('ignores commands that run no document builder, even when they name a PDF', () => {
    const fs = fakeFs({ [join(PROJ, 'paper.pdf')]: fresh });
    expect(builtPdf('ls paper.pdf', PROJ, NOW, fs)).toBeNull();
    expect(builtPdf('git add paper.tex', PROJ, NOW, fs)).toBeNull();
    expect(builtPdf(undefined, PROJ, NOW, fs)).toBeNull();
  });

  it('maps a source to its PDF for latexmk, typst and pandoc', () => {
    const fs = fakeFs({
      [join(PROJ, 'paper.pdf')]: fresh,
      [join(PROJ, 'notes.pdf')]: fresh,
      [join(PROJ, 'out/report.pdf')]: fresh,
    });
    expect(builtPdf('latexmk -pdf paper.tex', PROJ, NOW, fs)).toBe(join(PROJ, 'paper.pdf'));
    expect(builtPdf('typst compile notes.typ', PROJ, NOW, fs)).toBe(join(PROJ, 'notes.pdf'));
    expect(builtPdf('pandoc a.md -o out/report.pdf', PROJ, NOW, fs)).toBe(
      join(PROJ, 'out/report.pdf'),
    );
  });

  it('follows -outdir and a leading cd', () => {
    const fs = fakeFs({ [join(PROJ, 'draft/build/main.pdf')]: fresh });
    expect(builtPdf('cd draft && latexmk -outdir=build main.tex', PROJ, NOW, fs)).toBe(
      join(PROJ, 'draft/build/main.pdf'),
    );
  });

  it('with no file named, takes the newest PDF of the folder', () => {
    const fs = fakeFs({ [join(PROJ, 'old.pdf')]: fresh - 1000, [join(PROJ, 'new.pdf')]: fresh });
    expect(builtPdf('latexmk', PROJ, NOW, fs)).toBe(join(PROJ, 'new.pdf'));
  });

  it('skips a PDF older than the build window', () => {
    const fs = fakeFs({ [join(PROJ, 'paper.pdf')]: NOW - BUILD_WINDOW_MS - 1 });
    expect(builtPdf('pdflatex paper.tex', PROJ, NOW, fs)).toBeNull();
  });

  it('does not take a builder name inside another word', () => {
    const fs = fakeFs({ [join(PROJ, 'paper.pdf')]: fresh });
    expect(builtPdf('cat mypandocnotes.txt paper.pdf', PROJ, NOW, fs)).toBeNull();
  });

  it('is reached through fileToOpen for Bash calls', () => {
    expect(
      open(
        { tool_name: 'Bash', cwd: PROJ, tool_input: { command: 'quarto render deck.qmd' } },
        { [join(PROJ, 'deck.pdf')]: fresh },
      ),
    ).toBe(join(PROJ, 'deck.pdf'));
  });
});
