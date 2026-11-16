/**
 * @file src/main/sync-output.ts
 * @purpose Tracks whether a PTY byte stream is inside a synchronized output frame
 *   (DEC private mode 2026: `ESC[?2026h` begins a frame, `ESC[?2026l` ends it).
 *   SessionManager holds an emit batch while a frame is open, so a TUI redraw from
 *   Claude Code or Codex reaches xterm as one piece instead of two halves (ADR-051).
 *
 * @关键设计:
 * - Only the plain forms `ESC[?2026h` and `ESC[?2026l` are recognised. That is what Ink
 *   (Claude Code) and Codex send. A combined form such as `ESC[?2026;25h` is not, so such
 *   output simply flows unheld, exactly as before ADR-051.
 * - Sequences split across PTY chunks are found by keeping the last 7 bytes (one less than
 *   the sequence length) and scanning them together with the next chunk. 7 bytes can never
 *   hold a whole sequence, so a match is never counted twice.
 * - The last sequence in the scanned text wins: `h ... l` closes, `l ... h` opens.
 * - Bytes are read as latin1 so each byte maps to one char. UTF-8 multibyte sequences never
 *   contain 0x1B, so they cannot fake a match.
 * - abandon() is for the caller's cap (time or size): the frame counts as closed until the
 *   next begin sequence, so a program that never closes its frame is not held repeatedly.
 *
 * @对应文档章节: 软件定义书.md ADR-051
 *
 * @不要在这里做的事:
 * - No timers and no emitting here; the hold cap lives in SessionManager.queueEmit.
 */

const BEGIN = '\x1b[?2026h';
const END = '\x1b[?2026l';
const TAIL = BEGIN.length - 1;

export class SyncOutputTracker {
  private open = false;
  private saw = false;
  private tail = '';

  /**
   * Whether the last feed() completed a begin or end sequence (also one split across
   * chunks). SessionManager does not emit such a chunk on the leading edge, so a write
   * that follows the frame within 8 ms (Codex's cursor return) joins the same batch.
   */
  get sawSequence(): boolean {
    return this.saw;
  }

  /** Whether the stream is inside a frame after the last feed(). */
  get isOpen(): boolean {
    return this.open;
  }

  /**
   * Scans one chunk.
   *
   * @param bytes the passthrough bytes about to be emitted
   * @returns whether a frame is open after this chunk
   */
  feed(bytes: Buffer): boolean {
    const text = this.tail + bytes.toString('latin1');
    const begin = text.lastIndexOf(BEGIN);
    const end = text.lastIndexOf(END);
    this.saw = begin !== -1 || end !== -1;
    if (this.saw) this.open = begin > end;
    this.tail = text.slice(-TAIL);
    return this.open;
  }

  /** Treats the open frame as closed; the next begin sequence opens a new one. */
  abandon(): void {
    this.open = false;
  }
}
