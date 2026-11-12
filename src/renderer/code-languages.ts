/**
 * @file src/renderer/code-languages.ts
 * @purpose Turns the language names of shared/code-files.ts into CodeMirror languages, and
 *   holds the editor's colours, which come from the current theme's CSS variables (ADR-040).
 *
 * @关键设计:
 * - Legacy CodeMirror 5 modes (StreamLanguage) cover every language in the table with one
 *   package; Stata has its own small mode in shared/stata-mode.ts.
 * - Colours are CSS variables, not fixed values, so all themes, user themes included, apply
 *   without any per-theme code. A theme switch repaints at once.
 * - The lint squiggle is a wavy text underline in the theme's danger / warning / info colour,
 *   replacing CodeMirror's built-in squiggle image, whose colours are fixed.
 *
 * @对应文档章节: 软件定义书.md ADR-040
 *
 * @不要在这里做的事:
 * - 不要在这里写死颜色:颜色只从主题变量取,全部带 #f0f 兜底
 */
import { HighlightStyle, StreamLanguage, type StreamParser } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
import { tags } from '@lezer/highlight';
import { cpp } from '@codemirror/legacy-modes/mode/clike';
import { fortran } from '@codemirror/legacy-modes/mode/fortran';
import { json } from '@codemirror/legacy-modes/mode/javascript';
import { julia } from '@codemirror/legacy-modes/mode/julia';
import { octave } from '@codemirror/legacy-modes/mode/octave';
import { powerShell } from '@codemirror/legacy-modes/mode/powershell';
import { properties } from '@codemirror/legacy-modes/mode/properties';
import { python } from '@codemirror/legacy-modes/mode/python';
import { r } from '@codemirror/legacy-modes/mode/r';
import { sas } from '@codemirror/legacy-modes/mode/sas';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { hive, standardSQL } from '@codemirror/legacy-modes/mode/sql';
import { stex } from '@codemirror/legacy-modes/mode/stex';
import { toml } from '@codemirror/legacy-modes/mode/toml';
import { yaml } from '@codemirror/legacy-modes/mode/yaml';
import type { CodeLanguage } from '@shared/code-files';
import { stata } from '@shared/stata-mode';

const PARSERS: Record<CodeLanguage, StreamParser<unknown>> = {
  python,
  r,
  julia,
  sql: standardSQL,
  hive,
  stata: stata as StreamParser<unknown>,
  octave,
  sas,
  fortran,
  cpp,
  json,
  stex,
  yaml,
  toml,
  shell,
  powershell: powerShell,
  properties,
};

const languages = new Map<CodeLanguage, StreamLanguage<unknown>>();

/** The CodeMirror language for a name, built once and reused. */
export function codeLanguage(name: CodeLanguage): StreamLanguage<unknown> {
  let language = languages.get(name);
  if (!language) {
    language = StreamLanguage.define(PARSERS[name]);
    languages.set(name, language);
  }
  return language;
}

/** Spaces per indent level: what each language's own style guide uses. */
export function indentWidth(name: CodeLanguage | null): number {
  return name === 'python' || name === 'julia' || name === 'fortran' || name === 'octave' ? 4 : 2;
}

const v = (name: string): string => `var(${name}, #f0f)`;

export const themeHighlight = HighlightStyle.define([
  {
    tag: [tags.keyword, tags.controlKeyword, tags.operatorKeyword],
    color: v('--color-accent-special'),
  },
  { tag: [tags.string, tags.special(tags.string), tags.regexp], color: v('--color-success') },
  { tag: [tags.number, tags.bool, tags.atom, tags.null], color: v('--color-warning') },
  {
    tag: [tags.comment, tags.lineComment, tags.blockComment, tags.meta],
    color: v('--color-text-muted'),
    fontStyle: 'italic',
  },
  {
    tag: [
      tags.definition(tags.variableName),
      tags.function(tags.variableName),
      tags.standard(tags.variableName),
    ],
    color: v('--color-info'),
  },
  {
    tag: [tags.special(tags.variableName), tags.typeName, tags.tagName],
    color: v('--color-accent-secondary'),
  },
  { tag: [tags.operator, tags.punctuation, tags.bracket], color: v('--color-text-secondary') },
  { tag: tags.heading, fontWeight: 'bold' },
  { tag: tags.invalid, color: v('--color-danger') },
]);

const squiggle = (color: string): Record<string, string> => ({
  backgroundImage: 'none',
  textDecoration: `underline wavy ${v(color)}`,
  textDecorationSkipInk: 'none',
  textUnderlineOffset: '3px',
});

export const editorTheme = EditorView.theme({
  '&': { height: '100%', color: v('--color-text-primary'), backgroundColor: 'transparent' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: "Consolas, 'Cascadia Mono', 'Microsoft YaHei UI', monospace",
    fontSize: '13px',
    lineHeight: '1.5',
  },
  '.cm-content': { padding: '8px 0', caretColor: v('--color-text-primary') },
  '.cm-line': { padding: '0 12px' },
  '.cm-cursor': { borderLeftColor: v('--color-text-primary') },
  '.cm-gutters': { backgroundColor: 'transparent', border: 'none', color: v('--color-text-muted') },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 4px 0 12px', minWidth: '28px' },
  '.cm-lintRange-error': squiggle('--color-danger'),
  '.cm-lintRange-warning': squiggle('--color-warning'),
  '.cm-lintRange-info': squiggle('--color-info'),
  '.cm-lintRange-hint': squiggle('--color-info'),
  '.cm-tooltip': {
    backgroundColor: v('--color-bg-elevated'),
    color: v('--color-text-primary'),
    border: `1px solid ${v('--md-outline-variant')}`,
    borderRadius: '8px',
  },
  '.cm-diagnostic': { fontFamily: 'inherit', padding: '4px 10px' },
  '.cm-diagnostic-error': { borderLeftColor: v('--color-danger') },
  '.cm-diagnostic-warning': { borderLeftColor: v('--color-warning') },
  '.cm-diagnostic-info': { borderLeftColor: v('--color-info') },
  '.cm-diagnosticSource': { color: v('--color-text-muted') },
});
