/**
 * @file src/shared/replay-rounds.ts
 * @purpose Sequences the scrollback replay rounds of one TerminalView (ADR-051): the first
 *   replay at mount, and a fresh one each time main sends evt:session:output-resync.
 *   Pure (the terminal is passed as a write function), so it is tested without xterm.
 *
 * @关键设计:
 * - A resync must not call term.reset() directly. In xterm 6.1 reset() clears the handler
 *   and buffers but not the write queue (CoreTerminal.reset / CoreBrowserTerminal.reset),
 *   so live chunks still queued, or a whole first snapshot still being parsed, would land
 *   after the reset and the new snapshot would be appended after them: history twice,
 *   wrong screen. Instead the reset goes through the queue as RIS (`ESC c`). The parser
 *   reaches it after everything queued before it, InputHandler.fullReset runs the same
 *   reset() (new buffers, so scrollback is cleared too), and only in RIS's write callback
 *   does the next round start.
 * - A resync during a round is remembered and run when that round is done: the round's
 *   snapshot may predate the backlog main dropped.
 * - done() says whether this was the last round, so the view reveals (and scrolls) only
 *   once the final snapshot is on screen.
 *
 * @对应文档章节: 软件定义书.md ADR-051;ipc-protocol.md 6.2 evt:session:output-resync
 *
 * @不要在这里做的事:
 * - No IPC and no xterm imports; TerminalView passes `write` and `run`.
 */

/** RIS, "Full Reset": xterm parses it in order and resets buffers, modes and scrollback. */
export const FULL_RESET = '\x1bc';

export class ReplayRounds {
  private replaying = false;
  private again = false;
  private disposed = false;

  /**
   * @param write term.write; the callback runs once xterm has parsed the data
   * @param run starts one round: fetch the snapshot, write it, then call done()
   */
  constructor(
    private readonly write: (data: string, parsed: () => void) => void,
    private readonly run: () => void,
  ) {}

  /** True while a round runs: live output must be buffered, not written. */
  get isReplaying(): boolean {
    return this.replaying;
  }

  /** The first round, at mount. The terminal is fresh, so no reset is needed. */
  start(): void {
    if (this.disposed) return;
    this.replaying = true;
    this.run();
  }

  /**
   * A round has written its snapshot and the buffered live output.
   *
   * @returns true when this was the last round (reveal the view now); false when a resync
   *   arrived meanwhile and another round has been queued behind a reset
   */
  done(): boolean {
    if (this.disposed) return false;
    if (!this.again) {
      this.replaying = false;
      return true;
    }
    this.again = false;
    this.restart();
    return false;
  }

  /** evt:session:output-resync arrived: replay again, after everything already queued. */
  resync(): void {
    if (this.disposed) return;
    if (this.replaying) {
      this.again = true;
      return;
    }
    this.restart();
  }

  dispose(): void {
    this.disposed = true;
  }

  private restart(): void {
    this.replaying = true;
    this.write(FULL_RESET, () => {
      if (!this.disposed) this.run();
    });
  }
}
