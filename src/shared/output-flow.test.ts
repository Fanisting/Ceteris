/**
 * @file src/shared/output-flow.test.ts
 * @purpose Tests for the ADR-051 ack payload check and the renderer side ack batcher.
 *   One test per rule; no xterm, the parse callback is called by hand.
 */
import { describe, expect, it } from 'vitest';
import { checkAckPayload, FLOW_ACK_CHUNK, FLOW_LOW_WATERMARK, OutputAcker } from './output-flow';

function makeAcker(chunk = 100): { acker: OutputAcker; sent: Array<[number, boolean]> } {
  const sent: Array<[number, boolean]> = [];
  const acker = new OutputAcker((bytes, detach) => sent.push([bytes, detach]), chunk);
  return { acker, sent };
}

describe('output flow constants', () => {
  it('an ack chunk never exceeds the low watermark, so a fully parsed stream always resumes', () => {
    expect(FLOW_ACK_CHUNK).toBeLessThanOrEqual(FLOW_LOW_WATERMARK);
  });
});

describe('checkAckPayload', () => {
  it('accepts a session id with a non-negative integer and an optional boolean detach', () => {
    expect(checkAckPayload({ sessionId: 's', bytes: 0 })).toBeNull();
    expect(checkAckPayload({ sessionId: 's', bytes: 5000, detach: true })).toBeNull();
  });

  it('rejects absurdly large acks', () => {
    expect(checkAckPayload({ sessionId: 's', bytes: 2 ** 31 })).toMatch(/larger than/);
  });

  it('rejects an empty session id', () => {
    expect(checkAckPayload({ sessionId: '', bytes: 1 })).toMatch(/sessionId/);
  });
});

describe('OutputAcker', () => {
  it('acks only after the parse callback runs', () => {
    const { acker, sent } = makeAcker();
    const parsed = acker.received(150);
    expect(sent).toEqual([]);
    parsed?.();
    expect(sent).toEqual([[150, false]]);
  });

  it('batches parsed bytes until one chunk is reached', () => {
    const { acker, sent } = makeAcker();
    acker.received(60)?.();
    expect(sent).toEqual([]);
    acker.received(60)?.();
    expect(sent).toEqual([[120, false]]);
  });

  it('acks on receipt while hidden and returns no callback', () => {
    const { acker, sent } = makeAcker();
    acker.setHidden(true);
    expect(acker.received(150)).toBeUndefined();
    expect(sent).toEqual([[150, false]]);
  });

  it('going hidden acks bytes still in the parser, and their late callbacks do not ack twice', () => {
    const { acker, sent } = makeAcker();
    const parsed = acker.received(30);
    acker.setHidden(true);
    expect(sent).toEqual([[30, false]]);
    parsed?.();
    expect(sent).toEqual([[30, false]]);
  });

  it('dispose sends the remainder with detach, once', () => {
    const { acker, sent } = makeAcker();
    acker.received(10)?.();
    const inParser = acker.received(20);
    acker.dispose();
    acker.dispose();
    inParser?.();
    expect(sent).toEqual([[30, true]]);
    expect(acker.received(500)).toBeUndefined();
    expect(sent).toHaveLength(1);
  });
});
