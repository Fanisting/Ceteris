/**
 * @file src/main/link/link-output-stats.test.ts
 * @purpose ADR-055 远程标签输出统计:一阵的划分、清屏计数、5 分钟窗口。
 */
import { describe, expect, it } from 'vitest';
import {
  LINK_OUTPUT_BURST_GAP_MS,
  LINK_OUTPUT_STATS_WINDOW_MS,
  LinkOutputStats,
} from './link-output-stats';

const ESC = String.fromCharCode(27);
const b64 = (text: string): string => Buffer.from(text, 'latin1').toString('base64');

describe('LinkOutputStats', () => {
  it('returns nothing before any output', () => {
    expect(new LinkOutputStats().summarize(0)).toEqual([]);
  });

  it('adds chunks closer than the gap into one burst', () => {
    const s = new LinkOutputStats();
    s.noteOutput('a', b64('x'.repeat(1000)), 0);
    s.noteOutput('a', b64('x'.repeat(1000)), LINK_OUTPUT_BURST_GAP_MS - 1);
    s.noteOutput('a', b64('x'.repeat(500)), 10_000);
    const [a] = s.summarize(10_000);
    expect(a).toMatchObject({ sessionId: 'a', bytes: 2500, largestBurstBytes: 2000 });
  });

  it('starts a new burst after a gap of exactly the threshold', () => {
    const s = new LinkOutputStats();
    s.noteOutput('a', b64('x'.repeat(100)), 0);
    s.noteOutput('a', b64('x'.repeat(100)), LINK_OUTPUT_BURST_GAP_MS);
    expect(s.summarize(1000)[0]?.largestBurstBytes).toBe(100);
  });

  it('counts chunks that clear the screen as redraws', () => {
    const s = new LinkOutputStats();
    s.noteOutput('a', b64(`${ESC}[2J${ESC}[3J${ESC}[Hhello`), 0);
    s.noteOutput('a', b64('plain line\r\n'), 1000);
    s.noteOutput('a', b64(`more${ESC}[2J`), 2000);
    expect(s.summarize(2000)[0]?.redraws).toBe(2);
  });

  it('drops records older than five minutes', () => {
    const s = new LinkOutputStats();
    s.noteOutput('a', b64('old'), 0);
    s.noteResync('a', 0);
    s.noteOutput('a', b64('new!'), LINK_OUTPUT_STATS_WINDOW_MS);
    const [a] = s.summarize(LINK_OUTPUT_STATS_WINDOW_MS + 1);
    expect(a).toMatchObject({ bytes: 4, resyncs: 0 });
    expect(s.summarize(3 * LINK_OUTPUT_STATS_WINDOW_MS)).toEqual([]);
  });

  it('counts resyncs and lists the busiest tabs first, up to the limit', () => {
    const s = new LinkOutputStats();
    s.noteOutput('small', b64('x'), 0);
    s.noteOutput('big', b64('x'.repeat(50)), 0);
    s.noteOutput('mid', b64('x'.repeat(10)), 0);
    s.noteResync('big', 10);
    const list = s.summarize(100, 2);
    expect(list.map((t) => t.sessionId)).toEqual(['big', 'mid']);
    expect(list[0]?.resyncs).toBe(1);
  });

  it('forgets a session', () => {
    const s = new LinkOutputStats();
    s.noteOutput('a', b64('x'), 0);
    s.forget('a');
    expect(s.summarize(0)).toEqual([]);
  });
});
