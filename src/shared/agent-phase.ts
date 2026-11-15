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
/** A description row: indented under its option, inside the box edges if any. */
const DESCRIPTION_ROW = /^\s*[│|]?\s{3,}(\S.*?)\s*[│|]?\s*$/;
/** Rows that cannot be the question: blank, box borders, rules, chips, the tab strip. */
const NOT_A_QUESTION = /^\s*[│|]?\s*(?:[─━╭╮╰╯┃═←]|☐|☑|☒|$)/;
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
  const rows = screenTail(screen, CHOICE_READ_ROWS).split('\n');
  let options: ChoiceOption[] = [];
  let first = -1;
  let pos = 0;
  let submitRowPos = -1;
  let submitRowPointed = false;
  let last: ChoiceOption | null = null;
  rows.forEach((row, i) => {
    const submit = SUBMIT_ROW.exec(row);
    if (submit && options.length > 0) {
      submitRowPos = pos;
      submitRowPointed = submit[1] !== undefined;
      pos++;
      last = null;
      return;
    }
    const m = OPTION_ROW.exec(row);
    if (!m) {
      if (last && ENDS_DESCRIPTION.test(row)) last = null;
      const d = last ? DESCRIPTION_ROW.exec(row) : null;
      if (last && d) last.description = last.description ? last.description + ' ' + d[1] : d[1]!;
      return;
    }
    const index = parseInt(m[2]!, 10);
    if (index === 1) {
      options = [];
      first = i;
      pos = 0;
      submitRowPos = -1;
      submitRowPointed = false;
    } else if (index !== options.length + 1) {
      return;
    }
    let label = m[3]!.trim();
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
    };
    options.push(last);
    pos++;
  });
  if (options.length === 0) return null;
  // Once text is typed into AskUserQuestion's field, its row shows that text instead of
  // "Type something", so the label no longer says what it is. The field is always the row
  // just above "Chat about this".
  const chatAt = options.findIndex((o) => /^Chat about this/.test(o.label));
  if (chatAt > 0 && options[chatAt - 1]!.input === 'none') options[chatAt - 1]!.input = 'type';
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
  };
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
