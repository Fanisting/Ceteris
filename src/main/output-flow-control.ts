/**
 * @file src/main/output-flow-control.ts
 * @purpose Per session bookkeeping for ADR-051 output flow control. SessionManager tells it
 *   what was emitted to the owner window and what the owner acknowledged; while the owner is
 *   too far behind, this class holds the emitted batches back in main and gives them out
 *   again when the owner catches up.
 *
 * @关键设计:
 * - **The PTY is never paused.** An earlier version called pty.pause(), which loses the tail
 *   of the output when the program exits while paused: on unix node-pty destroys the paused
 *   socket 200 ms after exit, dropping unread kernel buffer; with inbox ConPTY the 1 s flush
 *   timer is only re-armed by data events, which a paused socket never emits. So main keeps
 *   reading at full speed (the headless mirror and replay snapshots stay complete) and only
 *   the sending to the renderer is held back. The program is never slowed down.
 * - Counting happens where output is emitted to the owner (SessionManager.flushPendingEmit),
 *   not at PTY onData. Every reset point (replay snapshot, owner change) is then exact.
 * - State, per session:
 *
 *       sending ──unacked > HIGH and engaged──> holding (batches go to `held`)
 *       holding ──ack brings unacked < LOW────> sending (held released as one batch)
 *       holding ──no ack for WATCHDOG_MS──────> sending (held released, disengaged)
 *       holding ──held would exceed HOLD_CAP──> held dropped, owner asked to resync once
 *       any     ──reset (owner change, owner's replay snapshot)──> sending, held dropped
 *       any     ──releaseAll (exit / destroy)──> sending, held released
 *
 * - "engaged" means the current owner has acked at least once. Until then nothing is held,
 *   so an owner that never acks (a Ceteris Link client older than ADR-051) is unaffected.
 * - Dropping held bytes on reset is safe: an owner change or the owner's replay snapshot
 *   means the reader gets the full state from the snapshot, whose lastSeq covers every
 *   held seq. Dropping on overflow is safe for the same reason once the owner resyncs.
 * - HOLD_CAP is 1 MiB, ten times the window. Past that the renderer is far behind; a replay
 *   snapshot (screen plus at most 5 000 lines) is usually smaller than the backlog, cheaper
 *   to send over Link, and it bounds the memory one stuck window can pin in main.
 *
 * @对应文档章节: 软件定义书.md ADR-051;ipc-protocol.md 5.2 cmd:session:ack-output、8.5
 *
 * @不要在这里做的事:
 * - Do not look at owners, windows or IPC here; SessionManager passes `hasOwner` and filters
 *   acks from non-owners before calling ack().
 * - Do not touch the PTY here.
 */
import {
  FLOW_HIGH_WATERMARK,
  FLOW_HOLD_CAP,
  FLOW_LOW_WATERMARK,
  FLOW_WATCHDOG_MS,
} from '@shared/output-flow';
import { logger } from './logger';

export interface FlowControlOptions {
  highWatermark: number;
  lowWatermark: number;
  watchdogMs: number;
  holdCapBytes: number;
}

export const DEFAULT_FLOW_CONTROL: FlowControlOptions = {
  highWatermark: FLOW_HIGH_WATERMARK,
  lowWatermark: FLOW_LOW_WATERMARK,
  watchdogMs: FLOW_WATCHDOG_MS,
  holdCapBytes: FLOW_HOLD_CAP,
};

/** Held output to emit as one batch; `lastSeq` is the seq of its last chunk. */
export interface HeldOutput {
  bytes: Buffer;
  lastSeq: number;
}

export interface FlowControlHooks {
  /** Emit held output to the owner now (as one evt:session:output). */
  release(held: HeldOutput): void;
  /** Held output was dropped; ask the owner to replay a snapshot. Called once per backlog. */
  resync(): void;
}

export class OutputFlowControl {
  private unacked = 0;
  private holding = false;
  private engaged = false;
  private held: Buffer[] = [];
  private heldSize = 0;
  private heldLastSeq = -1;
  private resyncAsked = false;
  private watchdog: NodeJS.Timeout | null = null;
  private disposed = false;

  /**
   * @param sessionId for log lines only
   * @param hooks how SessionManager emits released output and asks for a resync
   * @param options thresholds; tests pass smaller numbers
   */
  constructor(
    private readonly sessionId: string,
    private readonly hooks: FlowControlHooks,
    private readonly options: FlowControlOptions = DEFAULT_FLOW_CONTROL,
  ) {}

  /** Whether flushed batches must go to hold() instead of being emitted. */
  get isHolding(): boolean {
    return this.holding;
  }

  /** Bytes currently held; exposed for tests and diagnostics. */
  get heldBytes(): number {
    return this.heldSize;
  }

  /**
   * Records one emitted batch.
   *
   * @param bytes UTF-8 length of the emitted payload
   * @param hasOwner whether a window receives it; ownerless output is not counted
   */
  emitted(bytes: number, hasOwner: boolean): void {
    if (this.disposed || !hasOwner) return;
    this.unacked += bytes;
    if (!this.holding && this.engaged && this.unacked > this.options.highWatermark) {
      this.holding = true;
      logger.debug(
        'OutputFlow',
        `holding output for sessionId=${this.sessionId} unacked=${this.unacked} ` +
          `high=${this.options.highWatermark}`,
      );
      this.armWatchdog();
    }
  }

  /**
   * Keeps one flushed batch back. Call only while isHolding is true.
   *
   * @returns 'overflow' when the backlog would pass HOLD_CAP: everything held plus this
   *   batch is dropped, and the resync hook has run (once per backlog)
   */
  hold(bytes: Buffer, lastSeq: number): 'held' | 'overflow' {
    if (this.heldSize + bytes.length > this.options.holdCapBytes) {
      const dropped = this.heldSize + bytes.length;
      this.held = [];
      this.heldSize = 0;
      this.heldLastSeq = -1;
      if (!this.resyncAsked) {
        this.resyncAsked = true;
        logger.warn(
          'OutputFlow',
          `sessionId=${this.sessionId} owner is ${dropped} bytes behind (cap ` +
            `${this.options.holdCapBytes}); dropped the backlog and asked the owner to replay a ` +
            'snapshot. Possible causes: a very fast flood over a slow Link, or a busy renderer.',
        );
        this.hooks.resync();
      }
      return 'overflow';
    }
    this.held.push(bytes);
    this.heldSize += bytes.length;
    this.heldLastSeq = lastSeq;
    return 'held';
  }

  /**
   * Applies an ack from the owner window. The caller has already checked the sender.
   *
   * @param bytes bytes the renderer has parsed since its last ack; the count clamps at 0
   *   because acks for bytes emitted before a reset still arrive afterwards
   * @param detach the renderer's TerminalView went away: send what is held and disengage
   */
  ack(bytes: number, detach: boolean): void {
    if (this.disposed) return;
    if (detach) {
      this.unacked = 0;
      this.engaged = false;
      this.stopHolding('renderer detached', true);
      return;
    }
    this.engaged = true;
    this.unacked = Math.max(0, this.unacked - bytes);
    if (!this.holding) return;
    if (this.unacked < this.options.lowWatermark) {
      this.stopHolding('acked below low watermark', true);
    } else {
      this.armWatchdog();
    }
  }

  /**
   * Forgets every unacknowledged and held byte: the reader gets a snapshot instead.
   *
   * @param reason for the debug log (owner changed, replay snapshot, ...)
   * @param disengage true when the reader changed, so holding waits for its first ack
   */
  reset(reason: string, disengage: boolean): void {
    if (this.disposed) return;
    this.unacked = 0;
    this.resyncAsked = false;
    if (disengage) this.engaged = false;
    this.stopHolding(reason, false);
  }

  /** Session exits or is destroyed: send everything held, before the exit event. */
  releaseAll(): void {
    if (this.disposed) return;
    this.stopHolding('session ending', true);
  }

  dispose(): void {
    if (this.disposed) return;
    this.clearWatchdog();
    this.held = [];
    this.heldSize = 0;
    this.disposed = true;
  }

  private stopHolding(reason: string, release: boolean): void {
    const wasHolding = this.holding;
    this.holding = false;
    this.clearWatchdog();
    const held = this.takeHeld();
    if (wasHolding) {
      logger.debug(
        'OutputFlow',
        `stopped holding sessionId=${this.sessionId} reason=${reason} ` +
          `held=${held?.bytes.length ?? 0} ${release ? 'released' : 'dropped'}`,
      );
    }
    // After clearing the state: release() emits, which may start a new hold right away.
    if (held && release) this.hooks.release(held);
  }

  private takeHeld(): HeldOutput | null {
    if (this.heldSize === 0) return null;
    const held = { bytes: Buffer.concat(this.held), lastSeq: this.heldLastSeq };
    this.held = [];
    this.heldSize = 0;
    this.heldLastSeq = -1;
    return held;
  }

  private armWatchdog(): void {
    this.clearWatchdog();
    this.watchdog = setTimeout(() => {
      this.watchdog = null;
      if (!this.holding) return;
      logger.warn(
        'OutputFlow',
        `sessionId=${this.sessionId} held output for ${this.options.watchdogMs} ms without an ack ` +
          `(unacked=${this.unacked}, held=${this.heldSize}); sending it and not holding again ` +
          'until the owner acks. Possible causes: the owner window is hung, crashed or ' +
          'throttled, or the Link is down.',
      );
      this.unacked = 0;
      this.engaged = false;
      this.stopHolding('watchdog', true);
    }, this.options.watchdogMs);
  }

  private clearWatchdog(): void {
    if (this.watchdog) {
      clearTimeout(this.watchdog);
      this.watchdog = null;
    }
  }
}
