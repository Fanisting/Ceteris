/**
 * @file src/shared/paste-landing.ts
 * @purpose Decides when a long paste on a remote agent tab has landed on screen, so the
 *   "Sending N lines" pill (ADR-047 item 10) stays up until the user can see the paste.
 *
 * @关键设计:
 * - The Host accepting the write is not the end. On a normal link it accepts in well under
 *   the pill's 300 ms show delay (ShapeLoader delayMs), and only then does the agent read the
 *   paste and draw its "[Pasted text #1 +N lines]" block. Hiding the pill on accept meant
 *   it never appeared at all, while the slow part went uncovered.
 * - Landed means: the Host accepted, then output arrived after that, then the output was
 *   quiet for PASTE_QUIET_MS. That is the agent's redraw of its input box. Waiting for any
 *   text such as "[Pasted text" would tie this to one agent; Codex folds pastes differently.
 * - A busy agent's spinner never goes quiet, and a program may draw nothing at all, so
 *   PASTE_LANDING_MAX_MS after the accept counts as landed either way.
 * - Pure and clock free: the caller passes `now` and runs the timer, so tests need no fakes.
 *
 * @对应文档章节: 软件定义书.md ADR-047 第 10 条
 *
 * @不要在这里做的事:
 * - Do not touch xterm, React state or timers here; TerminalView owns them.
 * - Do not count output that arrived before the accept; the agent could not have drawn the
 *   paste yet, and a spinner frame would end the wait early.
 */

/** Output quiet for this long after the accept means the agent has drawn the paste. */
export const PASTE_QUIET_MS = 200;

/** After this long from the accept the paste counts as landed, output or not. */
export const PASTE_LANDING_MAX_MS = 5000;

/**
 * Tracks the latest accepted paste of one terminal. One instance per terminal; a new paste
 * calls accepted() again, which starts the wait over.
 */
export class PasteLanding {
  private acceptedAt: number | null = null;
  private lastOutputAt: number | null = null;

  /** The Host accepted the paste at `now`. Output seen before this no longer counts. */
  accepted(now: number): void {
    this.acceptedAt = now;
    this.lastOutputAt = null;
  }

  /** Output was drawn at `now`. Ignored while no paste is waiting. */
  output(now: number): void {
    if (this.acceptedAt !== null) this.lastOutputAt = now;
  }

  /** Stops waiting, for a failed send or a closed terminal. */
  reset(): void {
    this.acceptedAt = null;
    this.lastOutputAt = null;
  }

  /**
   * @returns 0 once the paste has landed (the wait then ends), otherwise how many ms to wait
   *   before asking again; null when no paste is waiting.
   * @sideeffect landing ends the wait, so later calls return null.
   */
  wait(now: number): number | null {
    if (this.acceptedAt === null) return null;
    const untilMax = this.acceptedAt + PASTE_LANDING_MAX_MS - now;
    const untilQuiet =
      this.lastOutputAt === null ? PASTE_QUIET_MS : this.lastOutputAt + PASTE_QUIET_MS - now;
    if (untilMax <= 0 || (this.lastOutputAt !== null && untilQuiet <= 0)) {
      this.reset();
      return 0;
    }
    return Math.min(untilQuiet, untilMax);
  }
}
