/**
 * @file src/shared/replay-rounds.test.ts
 * @purpose Tests for ReplayRounds (ADR-051 resync sequencing) against a fake terminal whose
 *   write queue is parsed only when the test says so, like xterm's WriteBuffer.
 */
import { describe, expect, it } from 'vitest';
import { FULL_RESET, ReplayRounds } from './replay-rounds';

/** A terminal whose writes queue up until parse() runs them in order. */
class FakeTerm {
  readonly screen: string[] = [];
  private readonly queue: Array<{ data: string; cb?: () => void }> = [];
  write = (data: string, cb?: () => void): void => {
    this.queue.push({ data, ...(cb ? { cb } : {}) });
  };
  parse(): void {
    while (this.queue.length) {
      const { data, cb } = this.queue.shift()!;
      if (data === FULL_RESET) this.screen.length = 0;
      else this.screen.push(data);
      cb?.();
    }
  }
}

function setup(): { term: FakeTerm; rounds: ReplayRounds; runs: number[] } {
  const term = new FakeTerm();
  const runs: number[] = [];
  const rounds = new ReplayRounds(term.write, () => runs.push(runs.length + 1));
  return { term, rounds, runs };
}

describe('ReplayRounds', () => {
  it('resets through the write queue, after output already queued, before the next round', () => {
    const { term, rounds, runs } = setup();
    rounds.start();
    term.write('snapshot 1');
    expect(rounds.done()).toBe(true);
    term.write('live a');
    term.write('live b'); // still queued when the resync comes
    rounds.resync();
    expect(rounds.isReplaying).toBe(true);
    expect(runs).toEqual([1]); // the next round waits for the reset to be parsed
    term.parse();
    expect(runs).toEqual([1, 2]);
    expect(term.screen).toEqual([]); // nothing queued before the reset survives it
    term.write('snapshot 2');
    term.parse();
    expect(term.screen).toEqual(['snapshot 2']);
  });

  it('a resync during a round runs one more round after it, and only the last one reveals', () => {
    const { term, rounds, runs } = setup();
    rounds.start();
    rounds.resync();
    rounds.resync(); // two resyncs during one round need only one more round
    term.write('snapshot 1'); // the first snapshot is still queued when the round ends
    expect(rounds.done()).toBe(false);
    term.parse();
    expect(term.screen).toEqual([]);
    expect(runs).toEqual([1, 2]);
    term.write('snapshot 2');
    expect(rounds.done()).toBe(true);
    term.parse();
    expect(term.screen).toEqual(['snapshot 2']);
    expect(rounds.isReplaying).toBe(false);
  });

  it('starts nothing after dispose, even when a queued reset is parsed later', () => {
    const { term, rounds, runs } = setup();
    rounds.start();
    rounds.done();
    rounds.resync();
    rounds.dispose();
    term.parse();
    expect(runs).toEqual([1]);
  });
});
