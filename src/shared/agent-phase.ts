/**
 * @file src/shared/agent-phase.ts
 * @purpose Reads what a Claude Code or Codex session is doing from the end of its screen:
 *   working, blocked on the user's approval, or done and waiting for the next prompt; and
 *   while working, what kind of work (generating, running a tool, waiting) and how fast it
 *   generates. Pure, so the rules can be tested without a PTY.
 *
 * @关键设计:
 * - The screen is the source, not the byte rate. An agent at an approval prompt sends no
 *   bytes, exactly like one that finished, and only the screen tells them apart. The byte
 *   rate is no use for pace either: Claude Code redraws its spinner and timers all the time,
 *   so thinking, running a tool and writing all measured 650 to 760 B/s on 2026-11-08.
 * - Pace comes from the token counter on Claude Code's spinner line instead. It rises while
 *   the model generates and stands still while a tool runs.
 * - A choice prompt (Claude Code's AskUserQuestion, ADR-035) is 'blocked' too: the agent
 *   stopped and waits for the user exactly as at an approval, and the tab and the toast
 *   treat the two the same. The rules are what the prompt's own rows look like, not the
 *   footer alone, because the footer wording is shared with menus the user opens.
 * - The approval and working rules apply to any session, because an agent started by typing
 *   `claude` in a plain shell hides the markers detectAgent looks for while a prompt is open.
 * - "done" needs a detected agent, so a plain shell that goes quiet stays null and keeps
 *   the old output-driven wave.
 * - Wording checked against the installed binaries on 2026-11-07 (approval prompts) and a
 *   recorded Claude Code 2026-11 screen on 2026-11-08 (spinner, tool rows). Codex was not
 *   recorded: it gets phases from "esc to interrupt" and the approval prompt, and no work
 *   kind or pace. An agent update that rewords these falls back to the plain wave, never
 *   to a wrong state.
 *
 * @对应文档章节:软件定义书.md ADR-021、ADR-035
 */
import { detectAgent } from './next-prompt';
import type {
  AgentPhase,
  AgentWork,
  ChoiceInput,
  ChoiceOption,
  ChoicePrompt,
  ChoiceStep,
  ScreenRows,
  SessionState,
} from './types';

/**
 * Rows of the screen end that main reads. Claude Code leaves about ten blank rows between a
 * tool's output and its spinner, and a status line adds more below, so this is generous;
 * the rules then look only at the non-empty rows within it.
 */
export const AGENT_PHASE_SCREEN_ROWS = 60;

/** Non-empty rows searched; an approval box with its options fits in this. */
const SEARCH_ROWS = 20;

/** Non-empty rows searched for the agent's own markers. Few, so a shell after `/exit` stops matching. */
const AGENT_MARKER_ROWS = 12;

const APPROVAL_QUESTION = /\b(Do you want to|Would you like to)\b[^\n]*\?/;
/** An option line: box border or pointer, an optional number, then "Yes". */
const APPROVAL_YES_OPTION = /^[\s│|❯›>]*(\d+\.\s*)?Yes\b/m;
/**
 * Claude Code's AskUserQuestion prompt (ADR-035), recorded from 2.1.319 on 2026-11-10:
 * a question, numbered options with a pointer on the chosen one, a "Chat about this" row
 * and the footer "Enter to select · ↑/↓ to navigate · Esc to cancel". The footer is shared
 * with other pickers, so the rule also wants a pointed numbered option; the "Chat about
 * this" row alone is enough, it is this prompt's own.
 */
const CHOICE_FOOTER = /\bEnter to select\b[^\n]*\bEsc to cancel\b/;
const CHOICE_POINTED_OPTION = /^\s*[❯›>]\s*\d+\.\s/m;
const CHOICE_CHAT_OPTION = /^\s*[❯›>]?\s*(\d+\.\s*)?Chat about this\s*$/m;
/** The review page of a paged AskUserQuestion: no footer, a question and a pointed option. */
const CHOICE_REVIEW = /^\s*Ready to submit your answers\?\s*$/m;
/** Codex, and older Claude Code versions. */
const ESC_TO_INTERRUPT = /\besc to interrupt\b/i;
/** Claude Code's spinner line: a star glyph, a random verb, an ellipsis ("✻ Cogitating…"). */
const SPINNER = /^\s*[✶✻✽✢✳·*] \S+…/m;
/** The token counter on the spinner line: "↓ 94 tokens", "↓ 1.9k tokens". */
const TOKENS = /↓ ([\d.]+)(k?) tokens/;
/**
 * A running tool's header: its description, then a live timer outside any parentheses
 * ("● Running the ping command · 14s"). The spinner line's timer sits inside parentheses,
 * and a finished tool's header ("Ran 1 shell command") has no timer.
 */
const TOOL_HEADER = /^[^(\n]*\S · (?:\d+h )?(?:\d+m )?\d+s$/m;
/** The result line under a tool header. */
const TOOL_BODY = /^\s*⎿\s/m;

/** Tokens per second that counts as generating rather than waiting on hooks or the API. */
const GENERATING_MIN_RATE = 2;
/** Tokens per second that reads as full pace. */
const FULL_PACE_RATE = 80;

/** The last non-empty rows of the screen, so blank padding does not push markers out. */
function screenTail(screen: string, rows: number): string {
  return screen
    .split('\n')
    .filter((row) => row.trim() !== '')
    .slice(-rows)
    .join('\n');
}

/**
 * The phase of a session from the end of its rendered screen.
 *
 * @param templateId the session's template; 'claude-code' and 'codex' count as agents
 * @param screen the last rows of the rendered screen, oldest first, joined by "\n"
 * @param state the output-driven state; 'active' means bytes arrived recently
 * @returns null for a session that shows no agent, which keeps the output-driven wave
 */
export function detectAgentPhase(
  templateId: string,
  screen: string,
  state: SessionState,
): AgentPhase | null {
  if (state === 'exited') return null;
  const tail = screenTail(screen, SEARCH_ROWS);
  if (APPROVAL_QUESTION.test(tail) && APPROVAL_YES_OPTION.test(tail)) return 'blocked';
  if (CHOICE_CHAT_OPTION.test(tail)) return 'blocked';
  if (CHOICE_FOOTER.test(tail) && CHOICE_POINTED_OPTION.test(tail)) return 'blocked';
  if (CHOICE_REVIEW.test(tail) && CHOICE_POINTED_OPTION.test(tail)) return 'blocked';
  if (ESC_TO_INTERRUPT.test(tail) || SPINNER.test(tail)) return 'working';
  const agent = detectAgent(templateId, screenTail(screen, AGENT_MARKER_ROWS));
  if (!agent) return null;
  return state === 'active' ? 'working' : 'done';
}

/** What the screen of a working agent shows, before the token rate is known. */
export interface WorkSignals {
  /** A tool header with a live timer and its result line are on screen. */
  tool: boolean;
  /** Claude Code's spinner line is on screen. */
  spinner: boolean;
  /** The spinner's token count, or null when it shows none yet (or it is Codex). */
  tokens: number | null;
}

/** Reads the work signals from the end of a working agent's screen. */
export function readWorkSignals(screen: string): WorkSignals {
  const tail = screenTail(screen, SEARCH_ROWS);
  const m = TOKENS.exec(tail);
  const tokens = m ? Math.round(parseFloat(m[1]!) * (m[2] ? 1000 : 1)) : null;
  return {
    tool: TOOL_HEADER.test(tail) && TOOL_BODY.test(tail),
    spinner: SPINNER.test(tail),
    tokens: tokens !== null && Number.isFinite(tokens) ? tokens : null,
  };
}

/** A smoothed token rate, carried from one screen read to the next. */
export interface TokenRate {
  tokens: number;
  at: number;
  /** Tokens per second, smoothed. */
  rate: number;
}

/**
 * Folds one token reading into the smoothed rate.
 *
 * @param prev the previous reading, or null at the start of a turn
 * @param tokens the counter now; null when the spinner shows none, which ends the turn
 * @param at the time of the reading in ms
 * @returns null when there is no counter
 */
export function updateTokenRate(
  prev: TokenRate | null,
  tokens: number | null,
  at: number,
): TokenRate | null {
  if (tokens === null) return null;
  // A smaller count means a new turn started from zero.
  if (!prev || tokens < prev.tokens) return { tokens, at, rate: 0 };
  const dt = (at - prev.at) / 1000;
  if (dt <= 0) return prev;
  const instant = (tokens - prev.tokens) / dt;
  // Counts above 1000 move in steps of 100 ("1.9k"), so smooth hard enough to hide the steps.
  return { tokens, at, rate: prev.rate * 0.6 + instant * 0.4 };
}

/**
 * The kind of work and its pace, from the screen signals and the token rate.
 *
 * @returns work null when the screen shows no kind (Codex), so the renderer draws the plain
 *   wave; pace 0.25 to 1 in quarter steps while generating, null otherwise. Quarter steps
 *   keep the state-changed events down to a few per turn.
 */
export function classifyWork(
  signals: WorkSignals,
  rate: TokenRate | null,
): { work: AgentWork | null; pace: number | null } {
  if (signals.tool) return { work: 'tool', pace: null };
  if (!signals.spinner) return { work: null, pace: null };
  const r = rate?.rate ?? 0;
  if (r < GENERATING_MIN_RATE) return { work: 'waiting', pace: null };
  const pace = Math.max(0.25, Math.min(1, Math.ceil((r / FULL_PACE_RATE) * 4) / 4));
  return { work: 'generating', pace };
}

/** Non-empty rows the prompt reader looks at: a prompt with long option descriptions is tall. */
const CHOICE_READ_ROWS = 40;
/** An option row: optional box edge, optional pointer, a number, the label, optional box edge. */
const OPTION_ROW = /^\s*[│|]?\s*([❯›>])?\s*(\d+)\.\s+(.*?)\s*[│|]?\s*$/;
/** Multi-select's own "Submit" row: no number, so only the pointer and the word. */
const SUBMIT_ROW = /^\s*([❯›>])?\s+Submit\s*$/;
/**
 * "Chat about this" without a number: Claude Code draws it so when options have previews
 * (seen in 2.1.322 on 2026-11-22). The down arrow reaches it after the last option, and
 * the option above keeps its ❯ while the pointer sits here.
 */
const CHAT_ROW = /^\s*([❯›>])?\s+Chat about this\s*$/;
/** The preview box Claude Code draws to the right of the options, cut off their labels. */
const PREVIEW_COLUMN = /\s{2,}[│┌└├].*$/;
/** A multi-select option's box at the start of its label. */
const CHECKBOX = /^\[([✔✓xX ])\]\s*/;
/** The mark Claude Code puts after the answer already given, when the user steps back. */
const CHOSEN_MARK = /\s+[✔✓]$/;
/** The tab strip of a paged AskUserQuestion: "←  ☐ Colour  ☒ Size  ✔ Submit  →". */
const STEP_STRIP = /^\s*←\s+(.*?)\s+→\s*$/;
const REVIEW_TITLE = /^\s*Review your answers\s*$/;
const REVIEW_QUESTION = /^\s*Ready to submit your answers\?\s*$/;
/** Rows that end an option's description: rules, box bottoms, the footer. */
const ENDS_DESCRIPTION = /^\s*[│|]?\s*(?:[─━╌═╭╮╰╯]|.*\bEsc to cancel\b|.*\bEnter to select\b)/;
/**
 * A description row: indented under its option, inside the box edges if any. A row of the
 * preview box (it starts with a box edge far to the right) is not one.
 */
const DESCRIPTION_ROW = /^\s*[│|]?\s{3,}(?![│┌└├┐┘])(\S.*?)\s*[│|]?\s*$/;
/** Rows that cannot be the question: blank, box borders, rules, chips, the tab strip. */
const NOT_A_QUESTION = /^\s*[│|]?\s*(?:[─━╭╮╰╯┃═←]|☐|☑|☒|$)/;
/**
 * The top edge of a prompt: the rule Claude Code draws above an approval or AskUserQuestion,
 * or the top of an older approval box. The dashed rules around a diff (╌) do not count.
 */
const PROMPT_TOP = /^\s*(?:╭[─━]|[─━]{8,})/;
/** Rows that still belong to the prompt after its last option: the footer, a box bottom. */
const PROMPT_TAIL = /^\s*╰|\bEsc to cancel\b|\bEnter to select\b/;
/** Rows after the last option searched for the footer. */
const PROMPT_TAIL_ROWS = 4;
/**
 * Options that open a text field in place: typing replaces the label, Enter sends it.
 * Exported for main, which clears text typed there earlier before typing the new answer.
 */
export const TYPE_OPTION = /^(?:Type something|Other\b)/;
/** Options that leave the prompt so the user can write to the agent in its normal input. */
const CHAT_OPTION = /^(?:Chat about this|No, and tell (?:Claude|Codex)\b)/;

/** Which kind of answer an option takes, from its label. */
function optionInput(label: string): ChoiceInput {
  if (CHAT_OPTION.test(label)) return 'chat';
  if (TYPE_OPTION.test(label)) return 'type';
  return 'none';
}

/** The tab strip's entries; the Submit entry is left out, it is the review page. */
function readSteps(row: string): ChoiceStep[] {
  const m = STEP_STRIP.exec(row);
  if (!m) return [];
  return m[1]!
    .split(/\s{2,}/)
    .map((item) => /^([☐☒☑✔])\s+(.+)$/.exec(item.trim()))
    .filter((x): x is RegExpExecArray => x !== null && x[1] !== '✔')
    .map((x) => ({ label: x[2]!.trim(), done: x[1] !== '☐' }));
}

/**
 * The prompt an agent stopped at, from the end of its screen (ADR-035). Reads every shape
 * recorded from Claude Code 2.1.319 to 2.1.322 on 2026-11-10: approval boxes, single and
 * multi-select AskUserQuestion, the tab strip of a paged one and its review page.
 *
 * Rules: option rows count 1, 2, 3 in order, and a new "1." starts the set over, so the
 * last numbered run on screen wins and a numbered list in the agent's prose above the
 * prompt cannot pass for it. The pointer must sit on an option or on multi-select's Submit
 * row; only a live prompt draws it. Every row the arrow keys stop on gets a position, the
 * Submit row included, so moving the pointer is a plain count. The caller checks the
 * phase is 'blocked' first.
 *
 * @returns null when the rows do not read as a prompt
 */
export function readChoicePrompt(screen: string): ChoicePrompt | null {
  // The rules read the last non-empty rows; `lineOf` maps them back to rows of `screen`,
  // because the choice panel mirrors those rows with their colours (ChoicePrompt.region).
  const all = screen.split('\n');
  const lineOf = all
    .map((row, i) => (row.trim() === '' ? -1 : i))
    .filter((i) => i >= 0)
    .slice(-CHOICE_READ_ROWS);
  const rows = lineOf.map((i) => all[i]!);
  let options: ChoiceOption[] = [];
  let first = -1;
  let pos = 0;
  let submitRowPos = -1;
  let submitRowPointed = false;
  let last: ChoiceOption | null = null;
  /** The unnumbered "Chat about this" row, which gets the next number here. */
  let chatRow: ChoiceOption | null = null;
  rows.forEach((row, i) => {
    const submit = SUBMIT_ROW.exec(row);
    if (submit && options.length > 0) {
      submitRowPos = pos;
      submitRowPointed = submit[1] !== undefined;
      pos++;
      last = null;
      return;
    }
    const chat = CHAT_ROW.exec(row);
    if (chat && options.length > 0 && !chatRow) {
      chatRow = {
        index: options.length + 1,
        label: 'Chat about this',
        description: '',
        pos,
        pointed: chat[1] !== undefined,
        input: 'chat',
        checked: null,
        chosen: false,
        rows: { from: lineOf[i]!, to: lineOf[i]! },
      };
      options.push(chatRow);
      pos++;
      last = null;
      return;
    }
    const m = OPTION_ROW.exec(row);
    if (!m) {
      if (last && ENDS_DESCRIPTION.test(row)) last = null;
      const d = last ? DESCRIPTION_ROW.exec(row) : null;
      if (last && d) {
        last.description = last.description ? last.description + ' ' + d[1] : d[1]!;
        last.rows.to = lineOf[i]!;
      } else {
        // Descriptions sit right under their option; anything else in between ends them.
        last = null;
      }
      return;
    }
    const index = parseInt(m[2]!, 10);
    if (index === 1) {
      options = [];
      first = i;
      pos = 0;
      submitRowPos = -1;
      submitRowPointed = false;
      chatRow = null;
    } else if (index !== options.length + 1) {
      return;
    }
    let label = m[3]!.trim().replace(PREVIEW_COLUMN, '');
    let checked: boolean | null = null;
    const box = CHECKBOX.exec(label);
    if (box) {
      checked = box[1] !== ' ';
      label = label.slice(box[0].length);
    }
    const chosen = CHOSEN_MARK.test(label);
    if (chosen) label = label.replace(CHOSEN_MARK, '');
    last = {
      index,
      label,
      description: '',
      pos,
      pointed: m[1] !== undefined,
      input: optionInput(label),
      checked,
      chosen,
      rows: { from: lineOf[i]!, to: lineOf[i]! },
    };
    options.push(last);
    pos++;
  });
  if (options.length === 0) return null;
  // Once text is typed into AskUserQuestion's field, its row shows that text instead of
  // "Type something", so the label no longer says what it is. The field is always the row
  // just above "Chat about this". A prompt with previews has no such field.
  const chatAt = options.findIndex((o) => /^Chat about this/.test(o.label));
  if (chatAt > 0 && !chatRow && options[chatAt - 1]!.input === 'none') {
    options[chatAt - 1]!.input = 'type';
  }
  // With previews the option above keeps its ❯ while the pointer is on the chat row.
  const pointedChat = (chatRow as ChoiceOption | null)?.pointed === true;
  if (pointedChat) for (const o of options) o.pointed = o === chatRow;
  const pointedOption = options.find((o) => o.pointed);
  const pointer = pointedOption ? pointedOption.pos : submitRowPointed ? submitRowPos : -1;
  if (pointer < 0) return null;

  let question = '';
  for (let i = first - 1; i >= 0; i--) {
    const row = rows[i]!;
    if (NOT_A_QUESTION.test(row)) continue;
    question = row.replace(/^\s*[│|]\s*|\s*[│|]\s*$/g, '').trim();
    break;
  }

  let steps: ChoiceStep[] = [];
  for (let i = first - 1; i >= 0 && steps.length === 0; i--) steps = readSteps(rows[i]!);

  const titleAt = rows.findIndex((r) => REVIEW_TITLE.test(r));
  const askAt = rows.findIndex((r) => REVIEW_QUESTION.test(r));
  const reviewing = titleAt >= 0 && askAt > titleAt && askAt < first;
  const review = reviewing
    ? rows
        .slice(titleAt + 1, askAt)
        .map((r) => r.trim())
        .filter((r) => r !== '')
    : [];

  return {
    question,
    options,
    pointer,
    multiSelect: options.some((o) => o.checked !== null),
    steps,
    reviewing,
    review,
    region: promptRegion(rows, lineOf, first, options),
  };
}

/**
 * The rows the whole prompt takes, as rows of the screen: from its top rule (or box top)
 * down to its footer, so the panel can show the tool's header, the command or diff and any
 * preview exactly as drawn. Without a top rule it starts at the tab strip or the question.
 *
 * @param rows the non-empty rows the prompt was read from
 * @param lineOf for each of `rows`, its row in the screen text
 * @param first the index in `rows` of option 1
 */
function promptRegion(
  rows: string[],
  lineOf: number[],
  first: number,
  options: ChoiceOption[],
): ScreenRows {
  let top = -1;
  for (let i = first - 1; i >= 0 && top < 0; i--) if (PROMPT_TOP.test(rows[i]!)) top = i;
  if (top < 0) {
    // The question is the nearest row up that can be one; a tab strip may sit above it.
    top = first;
    for (let i = first - 1; i >= 0; i--) {
      if (STEP_STRIP.test(rows[i]!)) {
        top = i;
        break;
      }
      if (top === first && !NOT_A_QUESTION.test(rows[i]!)) top = i;
      else if (top !== first) break;
    }
  }
  let to = options[options.length - 1]!.rows.to;
  const lastAt = lineOf.indexOf(to);
  for (let i = lastAt + 1; i < rows.length && i <= lastAt + PROMPT_TAIL_ROWS; i++) {
    if (PROMPT_TAIL.test(rows[i]!)) to = lineOf[i]!;
  }
  return { from: lineOf[top]!, to };
}

/** Arrow keys that move the pointer between two positions; no Enter. */
export function moveKeys(from: number, to: number): string {
  const step = to > from ? '\x1b[B' : '\x1b[A';
  return step.repeat(Math.abs(to - from));
}

/**
 * Text for a prompt's one-line field: no control characters, line breaks become spaces,
 * because an Enter inside it would send half an answer.
 */
export function oneLineAnswer(text: string): string {
  return (
    text
      .replace(/[\r\n]+/g, ' ')
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x1f\x7f]/g, '')
      .trim()
  );
}
