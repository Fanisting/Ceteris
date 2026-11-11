/**
 * @file src/shared/stata-mode.ts
 * @purpose Syntax colours for Stata do and ado files in the file viewer (ADR-040). CodeMirror
 *   ships no Stata mode, so this is a small line tokenizer in CodeMirror's StreamParser form.
 *
 * @关键设计:
 * - Covers what makes a do-file readable: the three comment styles (`*` at line start, `//`
 *   and `///`, nestable block comments), strings including compound `"..."' quotes, local
 *   `macros' and $globals, numbers, and the common commands as keywords.
 * - Token names are CodeMirror's legacy names (keyword, string, comment, variable-2, number,
 *   operator), which StreamLanguage maps to highlight tags, so the theme colours apply.
 * - A block comment carries over lines in the state; nothing else spans lines.
 *
 * @对应文档章节: 软件定义书.md ADR-040
 *
 * @不要在这里做的事:
 * - 不要往这里加解析或检查:它只给颜色,不判断代码对不对
 */
import type { StreamParser, StringStream } from '@codemirror/language';

export interface StataState {
  /** Depth of open block comments; they nest in Stata. */
  commentDepth: number;
}

/** Common commands, prefixes and their usual abbreviations. Not exhaustive on purpose. */
const KEYWORDS = new Set(
  (
    'about append areg as assert by bys bysort cap capture cd clear collapse compress ' +
    'cond confirm continue count decode describe des destring di display do drop ' +
    'duplicates else encode end erase est estimates eststo esttab exit export foreach ' +
    'format forv forval forvalues fvset gen generate global graph if import in include ' +
    'inlist inrange ivreg2 ivreghdfe ivregress keep label levelsof lincom local log logit ' +
    'mata margins matrix merge mi mkdir noi noisily nlcom of order outreg2 predict ' +
    'preserve probit program pwd qui quietly recode reg regress reghdfe rename replace ' +
    'reshape restore return ereturn rreturn save scalar set sort sum summarize svy syntax ' +
    'tab tabulate tempfile tempname tempvar test tokenize tostring tsset twoway use ' +
    'using version while xi xtreg xtset'
  ).split(' '),
);

function blockComment(stream: StringStream, state: StataState): string {
  while (!stream.eol()) {
    if (stream.match('*/')) {
      state.commentDepth -= 1;
      if (state.commentDepth === 0) break;
    } else if (stream.match('/*')) {
      state.commentDepth += 1;
    } else {
      stream.next();
    }
  }
  return 'comment';
}

export const stata: StreamParser<StataState> = {
  name: 'stata',
  startState: () => ({ commentDepth: 0 }),
  copyState: (state) => ({ commentDepth: state.commentDepth }),
  token(stream, state) {
    if (state.commentDepth > 0) return blockComment(stream, state);
    // `*` as the first thing on a line comments out the whole line.
    if (stream.sol() && stream.match(/^\s*\*/)) {
      stream.skipToEnd();
      return 'comment';
    }
    if (stream.eatSpace()) return null;
    if (stream.match('/*')) {
      state.commentDepth = 1;
      return blockComment(stream, state);
    }
    if (stream.match('//')) {
      stream.skipToEnd();
      return 'comment';
    }
    if (stream.match('`"')) {
      // Compound quotes end at "' and may hold plain quotes inside.
      while (!stream.eol() && !stream.match(`"'`)) stream.next();
      return 'string';
    }
    if (stream.eat('"')) {
      while (!stream.eol()) {
        if (stream.next() === '"') break;
      }
      return 'string';
    }
    if (stream.match(/^`[^'\s]*'/) || stream.match(/^\$\{?[A-Za-z_]\w*\}?/)) {
      return 'variable-2';
    }
    if (stream.match(/^(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/i)) return 'number';
    const word = stream.match(/^[A-Za-z_]\w*/);
    if (word) {
      return KEYWORDS.has((word as RegExpMatchArray)[0]) ? 'keyword' : null;
    }
    const ch = stream.next();
    return ch !== undefined && /[=<>!&|+\-*/^~]/.test(ch) ? 'operator' : null;
  },
  languageData: {
    commentTokens: { line: '//', block: { open: '/*', close: '*/' } },
  },
};
