/**
 * @file src/renderer/components/CodeEditor.tsx
 * @purpose The editor of the text file viewer: CodeMirror with the file type's colours, line
 *   numbers for code, wrapping for prose, and lint problems drawn as squiggles (ADR-040).
 *
 * @关键设计:
 * - Uncontrolled: the text starts from `initialValue` and every edit is reported through
 *   onChange. TextFileView remounts the editor (React key) to load the file again, so the
 *   editor never has to accept a new text from outside.
 * - Lint results arrive after the save that started them, and the user may have typed since.
 *   markLintBase() remembers the text as saved; showProblems() places each problem in that
 *   text and moves it through the edits made since, so squiggles stay on the right word.
 * - Keys: only what a plain textarea already had (cursor moves, undo / redo) plus Tab to
 *   indent. No save shortcut and no app-level shortcuts: in-app shortcuts are on the 13.2
 *   list. Escape then Tab still moves focus out of the editor.
 *
 * @对应文档章节: 软件定义书.md ADR-040, ADR-016
 *
 * @不要在这里做的事:
 * - 不要加 Ctrl+S、搜索面板、自动补全这类功能:这里是顺手改文件,不是 IDE
 * - 不要在这里调 IPC:保存和 lint 都由 TextFileView 发起
 */
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { history, historyKeymap, indentWithTab, standardKeymap } from '@codemirror/commands';
import { indentUnit, syntaxHighlighting } from '@codemirror/language';
import { forEachDiagnostic, setDiagnostics, type Diagnostic } from '@codemirror/lint';
import { ChangeSet, EditorState, type Extension, type Text } from '@codemirror/state';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';
import type { CodeFileInfo, LintProblem } from '@shared/code-files';
import { codeLanguage, editorTheme, indentWidth, themeHighlight } from '../code-languages';

export interface CodeEditorHandle {
  /** Remembers the current text as the one a lint run will report on. Returns its id. */
  markLintBase(): number;
  /**
   * Draws the problems found in the text of `mark`. Ignored when a newer mark exists.
   * @returns false when ignored
   */
  showProblems(mark: number, problems: LintProblem[]): boolean;
  /** Moves the cursor to the i-th problem passed to the last showProblems and focuses. */
  jumpToProblem(index: number): void;
}

interface CodeEditorProps {
  initialValue: string;
  /** Null shows plain wrapped text without line numbers. */
  info: CodeFileInfo | null;
  readOnly: boolean;
  ariaLabel: string;
  onChange: (value: string) => void;
}

/** Offset of a 1-based line and column, clamped into the text. */
function offsetOf(doc: Text, line: number, column: number): number {
  const l = doc.line(Math.min(Math.max(1, line), doc.lines));
  return l.from + Math.min(Math.max(0, column - 1), l.length);
}

/** The base text of a lint run and every edit made to it since. */
interface LintBase {
  id: number;
  doc: Text;
  changes: ChangeSet;
}

export const CodeEditor = forwardRef<CodeEditorHandle, CodeEditorProps>(function CodeEditor(
  { initialValue, info, readOnly, ariaLabel, onChange },
  ref,
) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const baseRef = useRef<LintBase | null>(null);
  const shownRef = useRef<Array<{ diagnostic: Diagnostic; line: number }>>([]);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const language = info?.language ?? null;
    const extensions: Extension[] = [
      editorTheme,
      syntaxHighlighting(themeHighlight),
      history(),
      keymap.of([...standardKeymap, ...historyKeymap, indentWithTab]),
      indentUnit.of(' '.repeat(indentWidth(language))),
      EditorState.readOnly.of(readOnly),
      EditorView.editable.of(!readOnly),
      EditorView.contentAttributes.of({ spellcheck: 'false', 'aria-label': ariaLabel }),
      EditorView.updateListener.of((update) => {
        if (!update.docChanged) return;
        const base = baseRef.current;
        if (base) base.changes = base.changes.compose(update.changes);
        onChangeRef.current(update.state.doc.toString());
      }),
    ];
    if (info?.lineNumbers) extensions.push(lineNumbers());
    if (info?.wrap ?? true) extensions.push(EditorView.lineWrapping);
    if (language) extensions.push(codeLanguage(language));

    const view = new EditorView({
      parent: host,
      state: EditorState.create({ doc: initialValue, extensions }),
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // The editor is built once per mount; TextFileView remounts it to change any of these.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      markLintBase() {
        const view = viewRef.current;
        const doc = view?.state.doc;
        if (!view || !doc) return -1;
        const id = (baseRef.current?.id ?? 0) + 1;
        baseRef.current = { id, doc, changes: ChangeSet.empty(doc.length) };
        return id;
      },
      showProblems(mark, problems) {
        const view = viewRef.current;
        const base = baseRef.current;
        if (!view || !base || base.id !== mark) return false;
        const shown: Array<{ diagnostic: Diagnostic; line: number }> = [];
        const diagnostics = problems.map((p): Diagnostic => {
          let from = offsetOf(base.doc, p.line, p.column);
          let to = offsetOf(base.doc, p.endLine ?? p.line, p.endColumn ?? p.column);
          if (to <= from) {
            // A point problem: underline the word under it (after any indentation), or one character.
            const line = base.doc.lineAt(from);
            const rest = /^\s*\w+/.exec(line.text.slice(from - line.from))?.[0].length ?? 1;
            to = Math.min(line.to, from + rest);
          }
          from = base.changes.mapPos(from, 1);
          to = Math.max(from, base.changes.mapPos(to, -1));
          const diagnostic: Diagnostic = {
            from,
            to,
            severity: p.severity,
            message: p.message,
            ...(p.code ? { source: p.code } : {}),
          };
          shown.push({ diagnostic, line: p.line });
          return diagnostic;
        });
        shownRef.current = shown;
        view.dispatch(setDiagnostics(view.state, diagnostics));
        return true;
      },
      jumpToProblem(index) {
        const view = viewRef.current;
        const target = shownRef.current[index];
        if (!view || !target) return;
        // The diagnostic has moved with any edits; find where it is now.
        let at: number | null = null;
        forEachDiagnostic(view.state, (d, from) => {
          if (d === target.diagnostic) at = from;
        });
        const pos = at ?? offsetOf(view.state.doc, target.line, 1);
        view.dispatch({
          selection: { anchor: pos },
          effects: EditorView.scrollIntoView(pos, { y: 'center' }),
        });
        view.focus();
      },
    }),
    [],
  );

  return <div ref={hostRef} className="code-editor" />;
});
