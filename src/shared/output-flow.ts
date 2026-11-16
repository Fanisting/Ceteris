/**
 * @file src/shared/output-flow.ts
 * @purpose Output flow control (ADR-051): the shared numbers, the payload check for
 *   cmd:session:ack-output, the resync event payload, and the renderer side ack batcher.
 *   Pure, so main, renderer and tests share one copy.
 *
 * @关键设计:
 * - The ack scheme is VS Code's. Main counts output bytes it has emitted to the owner window
 *   and not yet seen acknowledged. Above FLOW_HIGH_WATERMARK it holds further output back in
 *   main; when acks bring the count below FLOW_LOW_WATERMARK it sends what it held as one
 *   batch. The owner's renderer acks after xterm has parsed the data, in chunks of
 *   FLOW_ACK_CHUNK, so at most about 100 KB is in flight between main and the screen.
 *   Keystrokes, their echo and Ctrl+C then never wait behind megabytes of queued output,
 *   locally or over Ceteris Link. Unlike VS Code the PTY itself is never paused (see
 *   src/main/output-flow-control.ts for why), so a program is never slowed down.
 * - When more than FLOW_HOLD_CAP would be held, main drops the backlog and sends
 *   evt:session:output-resync; the renderer then replays a snapshot (the same path as a
 *   remount), which already contains everything dropped.
 * - The unit is UTF-8 bytes of the emitted payload, not JS string length as in VS Code.
 *   Main emits a Buffer and the renderer writes the decoded Uint8Array, so both sides
 *   count the very same number and no conversion can drift.
 * - OutputAcker acks on receipt instead of after parse while the window is hidden
 *   (minimized or fully covered). Chromium throttles timers in hidden pages, xterm parses
 *   in timer slices, so parse callbacks there can lag by seconds. Acking on receipt keeps a
 *   hidden window from ever holding output back; nobody is looking at it anyway.
 * - dispose() sends what is left plus `detach: true`, so main sends what it holds and stops
 *   holding for this window until the next TerminalView for the session acks again.
 *
 * @对应文档章节: 软件定义书.md ADR-051;ipc-protocol.md 5.2 (cmd:session:ack-output)、
 *   6.2 (evt:session:output-resync)、8.5
 *
 * @不要在这里做的事:
 * - Do not call IPC or touch xterm here; the caller passes a send function.
 * - Do not hold or release anything here; that is SessionManager's job (main only).
 */

/** Hold output back once this many emitted bytes are unacknowledged (VS Code's value). */
export const FLOW_HIGH_WATERMARK = 100_000;

/** Send held output once unacknowledged bytes drop below this. */
export const FLOW_LOW_WATERMARK = 5_000;

/**
 * The renderer acks in chunks of at least this many bytes. Must not exceed
 * FLOW_LOW_WATERMARK: whatever is parsed but not yet acked stays below one chunk, and held
 * output has to be released once everything is parsed.
 */
export const FLOW_ACK_CHUNK = 5_000;

/**
 * Output held with no ack for this long is sent anyway. Covers a renderer that crashed,
 * hangs or is throttled, or a Link that went quiet. Two seconds is long enough for a slow
 * parse over a 150 ms link and short enough that the screen never lags far.
 */
export const FLOW_WATCHDOG_MS = 2_000;

/**
 * At most this many bytes are held per session (1 MiB, ten times the window). Past it main
 * drops the backlog and asks the owner to replay a snapshot, which is usually smaller than
 * the backlog and bounds the memory a stuck window can pin.
 */
export const FLOW_HOLD_CAP = 1024 * 1024;

/** evt:session:output-resync: the owner should replay a snapshot of this session. */
export interface OutputResyncPayload {
  sessionId: string;
}

/**
 * Whether a failed ack can never succeed for this view: the Host (or main) does not know
 * the command, or rejects the payload. Other failures (a Link that is reconnecting, a
 * timeout) are transient and the next ack is sent as usual.
 *
 * Matches on the message because Electron IPC passes only the message, not `code`:
 * - "No handler registered for ..." from Electron when main has no handler
 * - "未知 channel" from a Link Host older than ADR-051 (ipc.ts dispatchLocalCommand)
 * - "InvalidPayload" from this command's own payload check
 */
export function isPermanentAckError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /No handler registered|未知 channel|InvalidPayload/.test(message);
}

export interface AckOutputPayload {
  sessionId: string;
  /** Bytes of evt:session:output payloads that xterm has parsed since the last ack. */
  bytes: number;
  /** TerminalView for this session is going away: send what is held, stop holding until the next ack. */
  detach?: boolean;
}

/** Upper bound for one ack, far above anything a renderer can parse between two acks. */
const MAX_ACK_BYTES = 1 << 30;

/**
 * Checks a cmd:session:ack-output payload.
 *
 * @returns null when the payload is fine, else a short reason for the log
 */
export function checkAckPayload(p: unknown): string | null {
  if (typeof p !== 'object' || p === null) return 'payload is not an object';
  const o = p as Record<string, unknown>;
  if (typeof o['sessionId'] !== 'string' || o['sessionId'].length === 0) {
    return 'sessionId must be a non-empty string';
  }
  const bytes = o['bytes'];
  if (typeof bytes !== 'number' || !Number.isInteger(bytes) || bytes < 0) {
    return `bytes must be a non-negative integer, got ${String(bytes)}`;
  }
  if (bytes > MAX_ACK_BYTES) return `bytes ${bytes} is larger than ${MAX_ACK_BYTES}`;
  if (o['detach'] !== undefined && typeof o['detach'] !== 'boolean') {
    return 'detach must be a boolean when present';
  }
  return null;
}

/**
 * Renderer side ack batcher for one TerminalView.
 *
 * Usage: for every chunk written to xterm call `received(bytes)` and pass the returned
 * callback to `term.write`. Call `setHidden` on visibility changes and `dispose` on
 * unmount.
 */
export class OutputAcker {
  /** Parsed (or received while hidden) but not yet sent. */
  private unsent = 0;
  /** Written to xterm, parse callback still pending. */
  private readonly inParser = new Set<{ bytes: number }>();
  private hidden = false;
  private disposed = false;

  /**
   * @param send sends one ack; must not throw (fire and forget)
   * @param chunk minimum ack size, FLOW_ACK_CHUNK in production
   */
  constructor(
    private readonly send: (bytes: number, detach: boolean) => void,
    private readonly chunk: number = FLOW_ACK_CHUNK,
  ) {}

  /**
   * Records a chunk about to be written to xterm.
   *
   * @returns the callback to pass to term.write, or undefined when the chunk was acked
   *   on receipt already (hidden window, or after dispose)
   */
  received(bytes: number): (() => void) | undefined {
    if (this.disposed || bytes <= 0) return undefined;
    if (this.hidden) {
      this.add(bytes);
      return undefined;
    }
    const entry = { bytes };
    this.inParser.add(entry);
    return () => {
      // Already counted when the window went hidden or the view was disposed.
      if (this.inParser.delete(entry)) this.add(entry.bytes);
    };
  }

  /**
   * Switches between ack after parse (visible) and ack on receipt (hidden). Going hidden
   * also acks everything still waiting in the parser, since those callbacks may now be
   * throttled for seconds.
   */
  setHidden(hidden: boolean): void {
    if (this.disposed || this.hidden === hidden) return;
    this.hidden = hidden;
    if (!hidden) return;
    this.drainParser();
    this.flush();
  }

  /**
   * Takes back an ack that failed for a transient reason (Link reconnecting, timeout), so
   * its bytes go out with the next ack instead of being lost. Does not send by itself.
   */
  giveBack(bytes: number): void {
    if (this.disposed || bytes <= 0) return;
    this.unsent += bytes;
  }

  /** Sends everything still owed, with detach so main stops holding for this view. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.drainParser();
    const bytes = this.unsent;
    this.unsent = 0;
    this.send(bytes, true);
  }

  private drainParser(): void {
    for (const entry of this.inParser) this.unsent += entry.bytes;
    this.inParser.clear();
  }

  private add(bytes: number): void {
    this.unsent += bytes;
    if (this.unsent >= this.chunk) this.flush();
  }

  private flush(): void {
    if (this.unsent <= 0) return;
    const bytes = this.unsent;
    this.unsent = 0;
    this.send(bytes, false);
  }
}
