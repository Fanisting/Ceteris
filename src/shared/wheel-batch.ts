/**
 * @file src/shared/wheel-batch.ts
 * @purpose Batches mouse wheel reports on remote tabs (Ceteris Link) so a fast scroll costs
 *   one round trip per batch instead of one per wheel step.
 *
 * @关键设计:
 * - Why: Claude Code's fullscreen mode (and any program with mouse tracking on the alternate
 *   screen) keeps its history in its own memory on the Host. The local xterm has no
 *   scrollback for it, so every wheel step travels to the Host, the program redraws the whole
 *   screen, and the redraw travels back. A touchpad gives dozens of steps per flick; sent one
 *   by one they queue up behind each other and the program redraws for each, so the scroll
 *   arrives late and in jerks.
 * - How: at most one wheel write is on its way. Steps that come while it travels are joined
 *   into one string and go out together as soon as the Host accepts the previous write. The
 *   program reads them in one chunk and redraws once. The batch size follows the link: on a
 *   fast link each step goes out alone, as before.
 * - Nothing is dropped or merged into a different step count: the program still gets every
 *   report, so the scroll distance is unchanged.
 * - Only SGR (1006) wheel reports. X10 reports cannot carry columns past 223 and every agent
 *   that tracks the mouse asks for SGR.
 *
 * @对应文档章节:软件定义书.md ADR-047 第 11 条
 *
 * @不要在这里做的事:
 * - Do not decide whether a tab is remote; the renderer only routes wheel reports here in a
 *   remote window.
 * - Do not hold anything but wheel reports: keys must keep their order with each other.
 */

/* eslint-disable no-control-regex -- SGR mouse reports start with ESC */
const SGR_REPORT = /\x1b\[<(\d+);\d+;\d+M/g;
const SGR_REPORTS_ONLY = /^(?:\x1b\[<\d+;\d+;\d+M)+$/;
/* eslint-enable no-control-regex */

/**
 * True when data is one or more SGR wheel reports and nothing else.
 * Wheel buttons are 64 to 67 (up, down, left, right) plus the modifier bits 4, 8 and 16;
 * 128 and above are the extra buttons 8 to 11, not the wheel.
 */
export function isWheelReport(data: string): boolean {
  if (!SGR_REPORTS_ONLY.test(data)) return false;
  for (const m of data.matchAll(SGR_REPORT)) {
    if ((Number(m[1]) & 0b1100_0000) !== 64) return false;
  }
  return true;
}

export class WheelBatch {
  private inFlight = false;
  private pending = '';
  private closed = false;

  /**
   * @param send writes data to the session; resolves when the Host accepted or refused it.
   *   A refusal or a rejection still frees the slot, so one lost write cannot stop scrolling.
   */
  constructor(private readonly send: (data: string) => Promise<unknown>) {}

  /** Sends the report now, or joins it to the next batch while a write is on its way. */
  push(report: string): void {
    if (this.closed) return;
    if (this.inFlight) {
      this.pending += report;
      return;
    }
    this.inFlight = true;
    void this.send(report)
      .catch(() => undefined)
      .then(() => {
        this.inFlight = false;
        const next = this.pending;
        this.pending = '';
        if (next) this.push(next);
      });
  }

  /** Drops the waiting batch; later pushes do nothing. For the tab closing. */
  close(): void {
    this.closed = true;
    this.pending = '';
  }
}
