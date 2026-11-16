/**
 * @file src/shared/type-ahead.ts
 * @purpose Type ahead on remote agent tabs (ADR-047). Over Ceteris Link every key goes to
 *   the Host and back before it shows, and a busy agent redraws slowly, so typing a prompt
 *   stalled. Here the prompt stays on this machine while the user types and goes to the Host
 *   in one message on Enter.
 *
 * @关键设计:
 * - TypeAhead only decides. It returns what to write; the renderer draws the buffered text
 *   (renderer/type-ahead-view.ts) and sends the writes.
 * - Plain text, Backspace, Ctrl+U, Ctrl+W and Ctrl+C edit the buffer. Shift+Enter or Ctrl+J
 *   ('\n') adds a line. Enter returns a submit: the text, then Enter after a pause, because
 *   Claude Code reads text and Enter in one chunk as a paste.
 * - Only while the agent waits at its own input box (agentPromptReady). An approval or choice
 *   prompt gets its keys at once; held text stays, hidden, until the input box returns.
 * - Keys that act on the agent are not held. `/`, `!` and `#` at the start of the input and
 *   `@` anywhere open the agent's own menus or modes, so the rest of that message goes key by
 *   key ("live") until Enter or Ctrl+C. Arrows, Tab and other control keys first type out
 *   what is buffered, then pass through. Esc passes through and keeps the buffer; a second Esc
 *   clears it instead of reaching the agent.
 * - Replies the terminal sends for the program (focus reports, DA) and mouse reports are not
 *   keys and always pass through untouched.
 * - `name:` commands (ADR-020) expand inside the buffer. A command that starts the input is
 *   typed out at once and the message goes live, so the agent's `/` menu opens as before.
 *
 * @对应文档章节:软件定义书.md ADR-047;ceteris-link-protocol.md 第 9 节
 *
 * @不要在这里做的事:
 * - Do not decide whether a tab is remote; the renderer only feeds keys here in a remote
 *   window, and only while agentPromptReady holds or the message is live.
 * - Do not wrap text in bracketed paste markers; the renderer knows the terminal's modes.
 */
import { detectAgentPhase } from './agent-phase';
import { COLON_TRIGGERS, isTerminalReply, matchTrailingName } from './colon-commands';
import { detectAgent } from './next-prompt';

/** What the renderer writes to the session, in order. */
export type TypeAheadWrite =
  /** Raw key bytes, sent as they are. */
  | { kind: 'key'; data: string }
  /** Text to type into the agent's input; the renderer wraps it as a paste if it has lines. */
  | { kind: 'text'; text: string }
  /** Text to type, then Enter after a pause. */
  | { kind: 'submit'; text: string };

/**
 * Pause between the text and the Enter that sends it, counted from the Host accepting the
 * text. Claude Code reads text and Enter in one chunk as a paste and inserts a newline; the
 * same value as SUBMIT_DELAY_MS in main/tab-control-server.ts.
 */
export const TYPE_AHEAD_SUBMIT_DELAY_MS = 150;

/**
 * True when the agent waits at its own input box, so typed keys are prompt text.
 *
 * The agent's footer ("? for shortcuts", "shift+tab to cycle", Codex's "context left") must
 * sit on or below the input cursor row. That keeps a shell tab out after `/exit`: Claude's
 * old footer is then above the shell's cursor. The template is not trusted for the same
 * reason. An approval or choice prompt (ADR-021, ADR-035) is never prompt text: there a key
 * such as 1 must reach the agent at once.
 *
 * @param fromInputRow screen rows from the input cursor row to the bottom, joined by "\n"
 * @param screen the last rows of the screen, as detectAgentPhase reads them
 */
export function agentPromptReady(fromInputRow: string, screen: string): boolean {
  if (detectAgent('', fromInputRow) === null) return false;
  return detectAgentPhase('', screen, 'idle') !== 'blocked';
}

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';
/** First characters that switch the agent into a menu or mode when typed into an empty input. */
const LIVE_AT_START = new Set(['/', '!', '#']);
/* eslint-disable no-control-regex -- these match control characters and escape sequences */
const CONTROL = /[\x00-\x1f\x7f]/;
/** Mouse reports (SGR and X10): the agent's mouse tracking, not keys at the cursor. */
const MOUSE_REPORT = /^\x1b\[(<\d+;\d+;\d+[Mm]|M[\s\S]{3})$/;
/* eslint-enable no-control-regex */

export class TypeAhead {
  private buffered: string;
  /** The rest of this message goes key by key. */
  private live = false;
  /** Nothing of this message reached the agent yet, so the buffer starts its input. */
  private atStart = true;
  /** The previous key was Esc, so a second one clears the text (Claude Code's Esc Esc). */
  private afterEsc = false;

  /** @param text buffered text to start from, as saved before a reload */
  constructor(text = '') {
    this.buffered = text;
  }

  /** Text typed but not sent. */
  get text(): string {
    return this.buffered;
  }

  /** True while keys go straight through (an agent menu or mode is open). */
  get isLive(): boolean {
    return this.live;
  }

  /**
   * Feeds one onData chunk.
   *
   * @param data a key, an IME commit, a paste, or a terminal reply
   * @param resolveColon returns the command for a saved `name:` name, or null
   * @returns writes to send now, in order; empty when the key only edited the buffer
   */
  feed(data: string, resolveColon: (name: string) => string | null = () => null): TypeAheadWrite[] {
    if (isTerminalReply(data) || MOUSE_REPORT.test(data)) return [key(data)];
    const afterEsc = this.afterEsc;
    this.afterEsc = data === '\x1b';

    if (this.live) {
      if (data === '\r' || data === '\x03') this.newMessage();
      return [key(data)];
    }

    if (data === '\r') {
      if (!this.buffered) {
        this.newMessage();
        return [key(data)];
      }
      const text = this.buffered;
      this.buffered = '';
      this.newMessage();
      return [{ kind: 'submit', text }];
    }

    if (!this.buffered && isEditKey(data)) {
      if (data === '\x03') this.newMessage();
      return [key(data)];
    }
    switch (data) {
      case '\x7f':
      case '\b':
        this.buffered = Array.from(this.buffered).slice(0, -1).join('');
        return [];
      case '\x03':
        this.buffered = '';
        return [];
      case '\x15':
        this.buffered = this.buffered.slice(0, this.buffered.lastIndexOf('\n') + 1);
        return [];
      case '\x17':
        this.buffered = this.buffered.replace(/[^\S\n]+$/, '').replace(/[^\s]+$/, '');
        return [];
      case '\n':
        this.buffered += '\n';
        return [];
      case '\x1b':
        // Esc stops the agent or closes its menu; what the user is typing stays. A second Esc
        // clears it, as Esc Esc clears Claude Code's input. Sending it would open the agent's
        // rewind menu instead, because the agent's own input is empty.
        if (afterEsc) {
          this.buffered = '';
          this.afterEsc = false;
          return [];
        }
        return [key(data)];
    }

    if (data.startsWith(PASTE_START) && data.endsWith(PASTE_END)) {
      this.buffered += data.slice(PASTE_START.length, -PASTE_END.length).replace(/\r\n?/g, '\n');
      return [];
    }

    if (CONTROL.test(data)) {
      // Arrows, Tab, Home/End, Alt+key, other Ctrl keys act at the agent's cursor, so the
      // text has to be there first.
      const out = this.flush();
      out.push(key(data));
      return out;
    }

    if (!this.buffered && this.atStart && LIVE_AT_START.has(data[0]!)) {
      this.live = true;
      return [key(data)];
    }

    const at = data.indexOf('@');
    if (at >= 0) {
      // `@` opens the agent's file picker, which filters as the user types.
      this.buffered += data.slice(0, at);
      const out = this.flush();
      this.live = true;
      out.push(key(data.slice(at)));
      return out;
    }

    if (COLON_TRIGGERS.has(data)) {
      const expanded = this.expandColon(resolveColon);
      if (expanded) return expanded;
    }

    this.buffered += data;
    return [];
  }

  /**
   * Adds pasted or dropped text to the buffer.
   *
   * @returns false when the message is live; the caller then sends the text as usual
   */
  insert(text: string): boolean {
    if (this.live) return false;
    this.buffered += text.replace(/\r\n?/g, '\n');
    return true;
  }

  /**
   * Puts back text whose send failed, ahead of anything typed since. The message starts over,
   * so a live key queued during the failed send cannot leave the text unsendable.
   */
  restore(text: string): void {
    this.buffered = text + this.buffered;
    this.newMessage();
  }

  private expandColon(resolve: (name: string) => string | null): TypeAheadWrite[] | null {
    const lineStart = this.buffered.lastIndexOf('\n') + 1;
    const line = this.buffered.slice(lineStart);
    const hit = matchTrailingName(line, this.atStart && lineStart === 0, resolve);
    if (!hit) return null;
    this.buffered = this.buffered.slice(0, this.buffered.length - hit.name.length) + hit.command;
    if (this.atStart && this.buffered === hit.command && LIVE_AT_START.has(hit.command[0]!)) {
      // A command alone: type it now so the agent's menu opens on it, as without type ahead.
      const out = this.flush();
      this.live = true;
      return out;
    }
    return [];
  }

  private flush(): TypeAheadWrite[] {
    if (!this.buffered) return [];
    const text = this.buffered;
    this.buffered = '';
    this.atStart = false;
    return [{ kind: 'text', text }];
  }

  private newMessage(): void {
    this.live = false;
    this.atStart = true;
  }
}

function key(data: string): TypeAheadWrite {
  return { kind: 'key', data };
}

/** Keys that edit the buffer when it has text, and go to the agent when it is empty. */
function isEditKey(data: string): boolean {
  return ['\x7f', '\b', '\x03', '\x15', '\x17', '\n'].includes(data);
}
