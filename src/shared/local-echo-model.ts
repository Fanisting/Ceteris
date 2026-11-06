/**
 * @file src/shared/local-echo-model.ts
 * @purpose Decides which typed characters to show before the Host echoes them. On a
 *   remote link every key waits a full round trip, so typing feels late however fast the
 *   code is. Showing predictions locally removes that wait.
 *
 * The prediction never enters the terminal buffer: renderer/local-echo.ts draws it in an
 * overlay. A wrong guess therefore cannot corrupt the screen, it just disappears.
 *
 * Trust rules, which is what keeps secrets off the screen:
 * - After Enter or any control key, nothing is predicted. The next key is a probe.
 * - A probe only earns trust if that same character comes back. Output alone proves
 *   nothing: a masked prompt such as Read-Host -AsSecureString answers each key with "*".
 *   Password prompts therefore never earn trust and nothing is ever drawn.
 * - A predicted character whose echo never comes withdraws trust.
 */

/** How long after the Host accepted a key its echo may still arrive. */
export const ECHO_WAIT_MS = 400;
/** A key the Host never accepted. The link is probably down. */
export const ENTRY_TTL_MS = 3_000;
const MAX_PREDICTED_INPUT = 8;
/** Enough to hold a redraw of the input line that contains the echoed key. */
const MAX_PROBE_OUTPUT = 8_192;

interface Entry {
  id: number;
  text: string;
  sentAt: number;
  ackedAt: number | null;
}

// eslint-disable-next-line no-control-regex -- control characters are exactly what it rejects
const CONTROL = /[\x00-\x1f\x7f]/;

export function isPredictable(data: string): boolean {
  return data.length > 0 && data.length <= MAX_PREDICTED_INPUT && !CONTROL.test(data);
}

export class LocalEchoModel {
  private entries: Entry[] = [];
  private probe: Entry | null = null;
  /** Output seen since the probe was sent. */
  private probeOutput = '';
  private trusted = false;
  private nextId = 1;
  private lastOutputAt = 0;

  /** What the overlay should show right now. */
  get text(): string {
    return this.entries.map((e) => e.text).join('');
  }

  /** True while a timer is needed to expire keys. */
  get busy(): boolean {
    return this.entries.length > 0 || this.probe !== null;
  }

  /**
   * Record a key the user typed.
   * @returns an id to pass to noteAck, or null when no ack is needed
   */
  noteInput(data: string, now: number): number | null {
    if (data === '\x7f' || data === '\b') {
      this.entries.pop();
      return null;
    }
    if (!isPredictable(data)) {
      this.reset();
      return null;
    }
    const entry: Entry = { id: this.nextId++, text: data, sentAt: now, ackedAt: null };
    if (this.trusted) {
      this.entries.push(entry);
    } else if (!this.probe) {
      this.probe = entry;
      this.probeOutput = '';
    } else {
      return null;
    }
    return entry.id;
  }

  /** The Host wrote this key to the terminal. */
  noteAck(id: number, now: number): void {
    if (this.probe?.id === id) {
      this.probe.ackedAt = now;
      this.settleProbe();
      return;
    }
    const entry = this.entries.find((e) => e.id === id);
    if (!entry) return;
    // The echo can overtake the ack on the wire, so output already seen counts.
    if (this.lastOutputAt > entry.sentAt) {
      this.entries = this.entries.filter((e) => e !== entry);
    } else {
      entry.ackedAt = now;
    }
  }

  /** Terminal output was drawn. */
  noteOutput(now: number, text: string): void {
    this.lastOutputAt = now;
    this.entries = this.entries.filter((e) => e.ackedAt === null);
    if (this.probe) {
      this.probeOutput = (this.probeOutput + text).slice(-MAX_PROBE_OUTPUT);
      this.settleProbe();
    }
  }

  /** The echo can overtake the ack, so this runs after either one. */
  private settleProbe(): void {
    if (this.probe?.ackedAt == null || !this.probeOutput.includes(this.probe.text)) return;
    this.trusted = true;
    this.probe = null;
  }

  /** Expire keys that never echoed. Returns true if the overlay changed. */
  tick(now: number): boolean {
    const before = this.entries.length;
    const silent = (e: Entry): boolean =>
      (e.ackedAt !== null && now - e.ackedAt >= ECHO_WAIT_MS) || now - e.sentAt >= ENTRY_TTL_MS;
    if (this.entries.some(silent)) {
      this.entries = this.entries.filter((e) => !silent(e));
      this.trusted = false;
    }
    if (this.probe && silent(this.probe)) this.probe = null;
    return this.entries.length !== before;
  }

  reset(): void {
    this.entries = [];
    this.probe = null;
    this.trusted = false;
  }
}
