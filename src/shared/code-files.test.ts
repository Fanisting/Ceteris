/**
 * @file src/shared/code-files.test.ts
 * @purpose Tests for the table of code and data files the viewer edits (ADR-040).
 */
import { describe, expect, it } from 'vitest';
import { codeFileInfo, defaultSqlDialect, EDITABLE_TEXT_EXTENSIONS } from './code-files';
import { fileViewKind, isEditableTextFile } from './file-tree';

describe('codeFileInfo', () => {
  it.each([
    ['clean_panel.py', 'python', 'ruff'],
    ['did.R', 'r', 'lintr'],
    ['paper.Rmd', null, 'lintr'],
    ['slides.qmd', null, 'lintr'],
    ['etl.hive', 'hive', 'sqlfluff'],
    ['q.SQL', 'sql', 'sqlfluff'],
    ['blp.jl', 'julia', null],
    ['main.do', 'stata', null],
    ['est.m', 'octave', null],
    ['solve.f90', 'fortran', null],
  ])('%s: language %s, linter %s', (name, language, linter) => {
    expect(codeFileInfo(name)).toMatchObject({ language, linter });
  });

  it('wraps prose and keeps code and tables on one line with line numbers', () => {
    expect(codeFileInfo('notes.txt')).toMatchObject({ wrap: true, lineNumbers: false });
    expect(codeFileInfo('a.py')).toMatchObject({ wrap: false, lineNumbers: true });
    expect(codeFileInfo('prices.csv')).toMatchObject({ wrap: false, language: null });
  });

  it.each(['a.exe', 'a.dta', 'a.parquet', 'README', 'a.constructor', 'a.toString'])(
    'does not edit %s',
    (name) => {
      expect(codeFileInfo(name)).toBeNull();
    },
  );
});

describe('the file tree opens every type of the table as editable text', () => {
  it.each(EDITABLE_TEXT_EXTENSIONS.map((ext) => [`file.${ext}`]))('%s', (name) => {
    expect(isEditableTextFile(name)).toBe(true);
    expect(['text', 'markdown']).toContain(fileViewKind(name));
  });
});

describe('defaultSqlDialect', () => {
  it('uses hive for .hive and ANSI for everything else', () => {
    expect(defaultSqlDialect('etl.HIVE')).toBe('hive');
    expect(defaultSqlDialect('q.sql')).toBe('ansi');
  });
});
