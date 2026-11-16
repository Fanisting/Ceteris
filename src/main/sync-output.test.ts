/**
 * @file src/main/sync-output.test.ts
 * @purpose Tests for SyncOutputTracker (DEC mode 2026 frame detection, ADR-051).
 */
import { describe, expect, it } from 'vitest';
import { SyncOutputTracker } from './sync-output';

const BEGIN = '\x1b[?2026h';
const END = '\x1b[?2026l';
const feed = (t: SyncOutputTracker, s: string): boolean => t.feed(Buffer.from(s, 'utf8'));

describe('SyncOutputTracker', () => {
  it('opens on the begin sequence and closes on the end sequence', () => {
    const t = new SyncOutputTracker();
    expect(feed(t, `x${BEGIN}frame`)).toBe(true);
    expect(feed(t, `more${END}`)).toBe(false);
  });

  it('the last sequence in a chunk wins', () => {
    const t = new SyncOutputTracker();
    expect(feed(t, `${BEGIN}a${END}b`)).toBe(false);
    expect(feed(t, `${END}a${BEGIN}b`)).toBe(true);
  });

  it('finds sequences split across chunks at every split point', () => {
    for (let i = 1; i < BEGIN.length; i++) {
      const t = new SyncOutputTracker();
      expect(feed(t, `abc${BEGIN.slice(0, i)}`)).toBe(false);
      expect(feed(t, `${BEGIN.slice(i)}xyz`)).toBe(true);
      expect(feed(t, `q${END.slice(0, i)}`)).toBe(true);
      expect(feed(t, END.slice(i))).toBe(false);
    }
  });

  it('a chunk without sequences keeps the state', () => {
    const t = new SyncOutputTracker();
    feed(t, BEGIN);
    expect(feed(t, 'plain text 中文')).toBe(true);
  });

  it('abandon closes the frame until the next begin, without re-reading the old one', () => {
    const t = new SyncOutputTracker();
    feed(t, BEGIN);
    t.abandon();
    expect(feed(t, 'later output')).toBe(false);
    expect(feed(t, BEGIN)).toBe(true);
  });
});
