/**
 * @file colon-commands.ts
 * @purpose The "`name:` commands" extension (ADR-019): in a Claude Code or Codex terminal,
 *          typing a saved name followed by a colon turns it into that CLI's slash command,
 *          so `compact:` becomes `/compact`. This module holds the list rules and a tracker
 *          that follows what the user typed on the current input line.
 *
 * @关键设计:
 * - Ceteris cannot see the CLI's input box, so ColonTracker rebuilds the current line from
 *   the keystrokes it sends. Anything it cannot follow (arrow keys, Tab, Esc) makes the line
 *   unknown; a name then fires only after a space the tracker saw typed.
 * - The colon is swallowed. The expansion erases the typed name with one DEL (0x7f) per
 *   character and types the command, all in one write. Probed on 2026-11-07: Claude Code
 *   2.1 and Codex 0.166 both read that chunk as separate keys and show their own `/` menu.
 * - Enter is never pressed: the CLI's menu stays open on the command and the user confirms it.
 * - Replies the terminal sends for the program (DA, XTVERSION, colour queries, focus
 *   reports) also arrive as input. They are not keys, so they leave the line alone.
 *
 * @对应文档章节:软件定义书.md ADR-019
 *
 * @不要在这里做的事:
 * - Do not decide whether the session runs an agent; the caller passes that in the resolver.
 * - Do not send anything; the caller writes the returned string to the PTY.
 */

/** One saved trigger: typing `name:` types `command`. */
export interface ColonCommand {
  /** Letters, digits, `_`, `.` or `-`, starting with a letter or digit; matched ignoring case. */
  name: string;
  /** Text typed in place of `name:`, normally `/name`. One line, no control characters. */
  command: string;
}

export const COLON_COMMANDS_MAX = 50;
export const COLON_COMMAND_NAME_MAX = 32;
export const COLON_COMMAND_TEXT_MAX = 200;

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\x00-\x1f\x7f]/;

/** Slash commands that exist in both Claude Code and Codex, so the list works out of the box. */
export const DEFAULT_COLON_COMMANDS: ColonCommand[] = [
  { name: 'compact', command: '/compact' },
  { name: 'model', command: '/model' },
  { name: 'init', command: '/init' },
  { name: 'status', command: '/status' },
];

/**
 * Why a single entry is not allowed, or null when it is.
 *
 * @param entry the candidate, usually straight from settings.json or the settings form
 * @param others the entries already in the list, used for the duplicate check
 */
export function colonCommandProblem(
  entry: unknown,
  others: readonly ColonCommand[],
): string | null {
  if (typeof entry !== 'object' || entry === null) return '每一项必须是 { name, command } 对象';
  const { name, command } = entry as Record<string, unknown>;
  if (typeof name !== 'string' || !NAME_RE.test(name) || name.length > COLON_COMMAND_NAME_MAX) {
    return (
      `名称 "${String(name)}" 无效:只能用字母、数字、_ . -,以字母或数字开头,` +
      `最多 ${COLON_COMMAND_NAME_MAX} 个字符`
    );
  }
  if (others.some((o) => o.name.toLowerCase() === name.toLowerCase())) {
    return `名称 "${name}" 已经存在(不分大小写)`;
  }
  if (
    typeof command !== 'string' ||
    command.trim() === '' ||
    command.length > COLON_COMMAND_TEXT_MAX ||
    CONTROL_RE.test(command)
  ) {
    return `"${name}" 的命令无效:必须是一行非空文字,最多 ${COLON_COMMAND_TEXT_MAX} 个字符`;
  }
  return null;
}

/** Why a whole list is not allowed, or null when it is. */
export function colonCommandsProblem(list: unknown): string | null {
  if (!Array.isArray(list)) return '必须是数组';
  if (list.length > COLON_COMMANDS_MAX) return `最多 ${COLON_COMMANDS_MAX} 项`;
  const seen: ColonCommand[] = [];
  for (const entry of list) {
    const problem = colonCommandProblem(entry, seen);
    if (problem) return problem;
    seen.push(entry as ColonCommand);
  }
  return null;
}

/** Finds the entry for a typed name, ignoring case. */
export function findColonCommand(
  list: readonly ColonCommand[],
  name: string,
): ColonCommand | undefined {
  const key = name.toLowerCase();
  return list.find((c) => c.name.toLowerCase() === key);
}

const DEL = '\x7f';
const MAX_LINE = 256;
const TRIGGERS = new Set([':', '：']); // ASCII colon, and the full-width one a Chinese IME types
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';
// The trailing word on the line, and what comes before it (nothing or whitespace).
const TRAILING_NAME_RE = /(^|\s)([A-Za-z0-9][A-Za-z0-9_.-]*)$/;

/**
 * True for data the terminal sends on the program's behalf rather than a key the user
 * pressed: DA1/DA2 and mode reports (`ESC [ ?` / `ESC [ >`), focus reports, cursor
 * position reports, DCS replies such as XTVERSION, OSC replies such as colour queries, and
 * mouse wheel reports. Keys never start this way, except Alt+P / Alt+] which are two bytes
 * and have no terminator.
 */
/* eslint-disable no-control-regex -- these patterns match escape sequences on purpose */
function isTerminalReply(data: string): boolean {
  return (
    /^\x1b\[[?>]/.test(data) ||
    data === '\x1b[I' ||
    data === '\x1b[O' ||
    /^\x1b\[\d+;\d+R$/.test(data) ||
    /^\x1bP[\s\S]+\x1b\\$/.test(data) ||
    /^\x1b\][\s\S]+(\x07|\x1b\\)$/.test(data) ||
    /^\x1b\[<6[4-7];\d+;\d+[Mm]$/.test(data)
  );
}
/* eslint-enable no-control-regex */

/**
 * Follows the current input line from the keystrokes Ceteris sends, and turns `name:` into
 * the saved command when the resolver allows it. One tracker per terminal view.
 */
export class ColonTracker {
  /** What the user typed on this line since the tracker last knew where the line began. */
  private line = '';
  /** True when `line` starts at the start of the input, so a name may fire with no space. */
  private atStart = true;

  /**
   * Feeds one onData chunk and returns what to write to the PTY instead.
   *
   * @param data the chunk xterm produced (a key, an IME commit, a paste, or a terminal reply)
   * @param resolve called only when `name:` was just typed at a word start; returns the command
   *        text to type, or null to let the colon through (unknown name, extension off, not
   *        an agent session)
   * @returns `data` unchanged, or DELs that erase the name followed by the command text
   */
  feed(data: string, resolve: (name: string) => string | null): string {
    if (TRIGGERS.has(data)) {
      const expanded = this.expand(resolve);
      if (expanded !== null) return expanded;
      this.append(data);
      return data;
    }
    if (data === '\r' || data === '\n' || data === '\x03' || data === '\x15') {
      // Enter submits, Ctrl+C and Ctrl+U clear: the next key starts a fresh input.
      this.reset(true);
      return data;
    }
    if (data === DEL || data === '\b') {
      this.line = this.line.slice(0, -1);
      return data;
    }
    // A lone Esc closes a menu or stops the agent; it moves neither the cursor nor the text.
    // Codex shows an update prompt that the user dismisses with Esc right before typing.
    if (isTerminalReply(data) || data === '\x1b') return data;
    if (data.startsWith(PASTE_START) && data.endsWith(PASTE_END)) {
      this.appendText(data.slice(PASTE_START.length, -PASTE_END.length));
      return data;
    }
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x1f\x7f]/.test(data)) {
      // Arrows, Home/End, Tab, Alt+key, other Ctrl keys: the cursor or text moved in a way
      // the tracker cannot follow.
      this.reset(false);
      return data;
    }
    this.append(data);
    return data;
  }

  private expand(resolve: (name: string) => string | null): string | null {
    const match = TRAILING_NAME_RE.exec(this.line);
    if (!match) return null;
    const name = match[2]!;
    if (match[1] === '' && !this.atStart) return null; // the name may be the tail of unseen text
    const command = resolve(name);
    if (command === null) return null;
    this.line = this.line.slice(0, -name.length) + command;
    this.trim();
    return DEL.repeat(name.length) + command;
  }

  private appendText(text: string): void {
    const lastBreak = Math.max(text.lastIndexOf('\r'), text.lastIndexOf('\n'));
    if (lastBreak >= 0) {
      // A pasted line break makes a new line inside the input, not a new input.
      this.reset(false);
      text = text.slice(lastBreak + 1);
    }
    // eslint-disable-next-line no-control-regex
    this.append(text.replace(/[\x00-\x1f\x7f]/g, ''));
  }

  private append(text: string): void {
    this.line += text;
    this.trim();
  }

  /** Keeps the tail; a name sits at the end, so the start only matters for atStart. */
  private trim(): void {
    if (this.line.length <= MAX_LINE) return;
    this.line = this.line.slice(-MAX_LINE);
    this.atStart = false;
  }

  private reset(atStart: boolean): void {
    this.line = '';
    this.atStart = atStart;
  }
}
