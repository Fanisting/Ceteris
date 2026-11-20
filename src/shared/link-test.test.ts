/**
 * @file src/shared/link-test.test.ts
 * @purpose ADR-055 连接测试的往返统计和判读规则。
 */
import { describe, expect, it } from 'vitest';
import {
  assessLinkTest,
  LINK_TEST_HEAVY_BURST_BYTES,
  LINK_TEST_HIGH_RTT_MS,
  summarizeRtt,
  type LinkTestResult,
} from './link-test';

function healthy(over: Partial<LinkTestResult> = {}): LinkTestResult {
  return {
    at: 0,
    address: '100.64.0.2:38787',
    connected: true,
    connectMs: 12,
    connectError: '',
    path: { kind: 'direct', endpoint: '203.0.113.5:41641' },
    rtt: { sent: 20, received: 20, minMs: 20, medianMs: 30, p95Ms: 45, jitterMs: 4 },
    downMBps: 8,
    upMBps: 6,
    speedSkipped: null,
    compressed: true,
    tabs: [],
    ...over,
  };
}

describe('summarizeRtt', () => {
  it('returns null without samples', () => {
    expect(summarizeRtt([], 20)).toBeNull();
  });

  it('computes min, median, p95 and jitter', () => {
    const s = summarizeRtt([10, 30, 20, 40, 100], 6);
    expect(s).toEqual({
      sent: 6,
      received: 5,
      minMs: 10,
      medianMs: 30,
      p95Ms: 100,
      jitterMs: Math.round((20 + 10 + 20 + 60) / 4),
    });
  });

  it('handles a single sample', () => {
    expect(summarizeRtt([42], 1)).toMatchObject({ medianMs: 42, p95Ms: 42, jitterMs: 0 });
  });
});

describe('assessLinkTest', () => {
  it('is ok for a fast direct link', () => {
    expect(assessLinkTest(healthy())).toEqual({ level: 'ok', findings: [] });
  });

  it('is bad when the host cannot be reached', () => {
    const a = assessLinkTest(
      healthy({ connected: false, connectMs: null, rtt: null, downMBps: null, upMBps: null }),
    );
    expect(a.level).toBe('bad');
    expect(a.findings[0]?.code).toBe('unreachable');
  });

  it('is bad when pings are lost', () => {
    const a = assessLinkTest(
      healthy({ rtt: { sent: 20, received: 18, minMs: 20, medianMs: 30, p95Ms: 40, jitterMs: 3 } }),
    );
    expect(a.level).toBe('bad');
    expect(a.findings.map((f) => f.code)).toContain('packet-loss');
  });

  it('warns about a relay path and a high round trip', () => {
    const a = assessLinkTest(
      healthy({
        path: { kind: 'relay', relay: 'tok' },
        rtt: {
          sent: 20,
          received: 20,
          minMs: 100,
          medianMs: LINK_TEST_HIGH_RTT_MS + 1,
          p95Ms: 200,
          jitterMs: 20,
        },
      }),
    );
    expect(a.level).toBe('warn');
    expect(a.findings.map((f) => f.code)).toEqual(['relay', 'high-rtt']);
  });

  it('warns about slow transfers', () => {
    const a = assessLinkTest(healthy({ downMBps: 0.3, upMBps: 0.1 }));
    expect(a.findings.map((f) => f.code)).toEqual(['slow-down', 'slow-up']);
  });

  it('names a tab that sends large redraws even when the network is fine', () => {
    const tab = {
      sessionId: 's1',
      name: 'omp',
      bytes: 1_400_000,
      largestBurstBytes: LINK_TEST_HEAVY_BURST_BYTES,
      redraws: 2,
      resyncs: 0,
    };
    const quiet = { ...tab, sessionId: 's2', name: 'shell', largestBurstBytes: 2000, redraws: 0 };
    const a = assessLinkTest(healthy({ tabs: [tab, quiet] }));
    expect(a.level).toBe('warn');
    expect(a.findings).toEqual([{ code: 'heavy-tab', level: 'warn', tab }]);
  });

  it('is bad when a connected link answers no ping at all', () => {
    const a = assessLinkTest(
      healthy({ rtt: null, downMBps: null, upMBps: null, speedSkipped: 'timeout' }),
    );
    expect(a.level).toBe('bad');
    expect(a.findings.map((f) => f.code)).toEqual(['no-reply', 'speed-failed']);
  });

  it('warns when the speed test timed out', () => {
    const a = assessLinkTest(healthy({ downMBps: null, upMBps: null, speedSkipped: 'timeout' }));
    expect(a).toEqual({ level: 'warn', findings: [{ code: 'speed-failed', level: 'warn' }] });
  });

  it('only informs when the host is too old for the speed test', () => {
    const a = assessLinkTest(
      healthy({ downMBps: null, upMBps: null, speedSkipped: 'host-too-old', compressed: false }),
    );
    expect(a).toEqual({ level: 'ok', findings: [{ code: 'host-too-old', level: 'info' }] });
  });

  it('informs that only reachability was tested when not connected', () => {
    const a = assessLinkTest(
      healthy({
        connected: false,
        rtt: null,
        downMBps: null,
        upMBps: null,
        speedSkipped: 'not-connected',
      }),
    );
    expect(a.findings.map((f) => f.code)).toEqual(['not-connected']);
  });
});
