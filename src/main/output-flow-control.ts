/**
 * @file src/main/output-flow-control.ts
 * @purpose Per session pause / resume bookkeeping for ADR-051 output flow control.
 *   SessionManager owns one instance per session and tells it what was emitted to the
 *   owner window and what the owner acknowledged; this class decides when to call
 *   pty.pause() and pty.resume().
 *
 * @关键设计:
 * - Counting happens where output is emitted to the owner (SessionManager.flushPendingEmit),
 *   not at PTY onData as VS Code does. Every reset point (replay snapshot, owner change)
 *   is then exact: bytes emitted before the reset are exactly the bytes the renderer will
 *   drop or never see, and bytes held in the 8 ms batch or a DEC 2026 frame are not yet
 *   owed by anyone.
 * - State, per session:
 *
 *       running ──unacked > HIGH and engaged──> paused
 *       paused  ──ack brings unacked < LOW────> running
 *       paused  ──no ack for WATCHDOG_MS──────> running (and disengaged)
 *       any     ──reset / detach / dispose────> running
 *
 * - "engaged" means the current owner has acked at least once. Until then nothing pauses,
 *   so an owner that never acks (a Ceteris Link client older than ADR-051, a window that
 *   shows no terminal for the session) can never stall a PTY. An owner change, a detach
 *   from the renderer, and the watchdog all disengage.
 * - A session without an owner window is never counted and never paused: nobody reads
 *   the output, it only feeds the headless mirror for the next replay.
 * - The watchdog is the last line of defence. A stalled build or agent is far worse than
 *   choppy output, so a pause without any ack for WATCHDOG_MS is lifted, logged at warn,
 *   and the session stays unpaused until the owner acks again.
 *
 * @对应文档章节: 软件定义书.md ADR-051;ipc-protocol.md 5.2 cmd:session:ack-output
 *
 * @不要在这里做的事:
 * - Do not look at owners, windows or IPC here; SessionManager passes `hasOwner` and
 *   filters acks from non-owners before calling ack().
 * - Do not emit or buffer output here; emit timing stays in SessionManager.queueEmit.
 */
import { FLOW_HIGH_WATERMARK, FLOW_LOW_WATERMARK, FLOW_WATCHDOG_MS } from '@shared/output-flow';
import { logger } from './logger';

/** The two node-pty methods this class drives. */
export interface PausablePty {
  pause(): void;
  resume(): void;
}

export interface FlowControlOptions {
  highWatermark: number;
  lowWatermark: number;
  watchdogMs: number;
}

export const DEFAULT_FLOW_CONTROL: FlowControlOptions = {
  highWatermark: FLOW_HIGH_WATERMARK,
  lowWatermark: FLOW_LOW_WATERMARK,
  watchdogMs: FLOW_WATCHDOG_MS,
};

export class OutputFlowControl {
  private unacked = 0;
  private paused = false;
  private engaged = false;
  private watchdog: NodeJS.Timeout | null = null;
  private disposed = false;

  /**
   * @param sessionId for log lines only
   * @param getPty returns the live PTY, or null once it has exited
   * @param options thresholds; tests pass smaller numbers
   */
  constructor(
    private readonly sessionId: string,
    private readonly getPty: () => PausablePty | null,
    private readonly options: FlowControlOptions = DEFAULT_FLOW_CONTROL,
  ) {}

  /** Unacknowledged bytes; exposed for tests and diagnostics. */
  get unackedBytes(): number {
    return this.unacked;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  /**
   * Records one emitted batch.
   *
   * @param bytes UTF-8 length of the emitted payload
   * @param hasOwner whether a window receives it; ownerless output is not counted
   * @副作用 may call pty.pause()
   */
  emitted(bytes: number, hasOwner: boolean): void {
    if (this.disposed || !hasOwner) return;
    this.unacked += bytes;
    if (!this.paused && this.engaged && this.unacked > this.options.highWatermark) {
      this.pause();
    }
  }

  /**
   * Applies an ack from the owner window. The caller has already checked that the sender
   * is the owner.
   *
   * @param bytes bytes the renderer has parsed since its last ack; the count clamps at 0
   *   because acks for bytes emitted before a reset still arrive afterwards
   * @param detach the renderer's TerminalView went away: reset and disengage
   * @副作用 may call pty.resume()
   */
  ack(bytes: number, detach: boolean): void {
    if (this.disposed) return;
    if (detach) {
      this.reset('renderer detached', true);
      return;
    }
    this.engaged = true;
    this.unacked = Math.max(0, this.unacked - bytes);
    if (!this.paused) return;
    if (this.unacked < this.options.lowWatermark) {
      this.resume('acked below low watermark');
    } else {
      this.armWatchdog();
    }
  }

  /**
   * Forgets every unacknowledged byte and resumes a paused PTY.
   *
   * @param reason for the debug log (owner changed, replay snapshot, ...)
   * @param disengage true when the reader changed, so the next pause waits for its first ack
   */
  reset(reason: string, disengage: boolean): void {
    if (this.disposed) return;
    this.unacked = 0;
    if (disengage) this.engaged = false;
    if (this.paused) this.resume(reason);
  }

  /**
   * Session exited or is being destroyed. Resumes first: node-pty with the bundled
   * ConPTY DLL waits for a data event after kill, which a paused socket never delivers.
   */
  dispose(): void {
    if (this.disposed) return;
    if (this.paused) this.resume('session ending');
    this.clearWatchdog();
    this.disposed = true;
  }

  private pause(): void {
    const pty = this.getPty();
    if (!pty) return;
    try {
      pty.pause();
    } catch (err) {
      // A failed pause only costs smoothness; never let it break the output path.
      logger.warn(
        'OutputFlow',
        `pty.pause failed for sessionId=${this.sessionId}: ` +
          `${err instanceof Error ? err.message : String(err)}. Output keeps flowing unpaused. ` +
          'Likely the PTY socket is already closing; if it repeats on a live session, check the node-pty build.',
      );
      return;
    }
    this.paused = true;
    logger.debug(
      'OutputFlow',
      `paused sessionId=${this.sessionId} unacked=${this.unacked} high=${this.options.highWatermark}`,
    );
    this.armWatchdog();
  }

  private resume(reason: string): void {
    this.paused = false;
    this.clearWatchdog();
    const pty = this.getPty();
    if (pty) {
      try {
        pty.resume();
      } catch (err) {
        logger.warn(
          'OutputFlow',
          `pty.resume failed for sessionId=${this.sessionId} (${reason}): ` +
            `${err instanceof Error ? err.message : String(err)}. ` +
            'Likely the PTY already exited; if the tab stops updating while its program runs, close and reopen it.',
        );
      }
    }
    logger.debug(
      'OutputFlow',
      `resumed sessionId=${this.sessionId} unacked=${this.unacked} reason=${reason}`,
    );
  }

  private armWatchdog(): void {
    this.clearWatchdog();
    this.watchdog = setTimeout(() => {
      this.watchdog = null;
      if (!this.paused) return;
      logger.warn(
        'OutputFlow',
        `sessionId=${this.sessionId} paused for ${this.options.watchdogMs} ms without an ack ` +
          `(unacked=${this.unacked}); resuming and not pausing again until the owner acks. ` +
          'Possible causes: the owner window is hung, crashed or throttled, or the Link is down.',
      );
      this.reset('watchdog', true);
    }, this.options.watchdogMs);
  }

  private clearWatchdog(): void {
    if (this.watchdog) {
      clearTimeout(this.watchdog);
      this.watchdog = null;
    }
  }
}
