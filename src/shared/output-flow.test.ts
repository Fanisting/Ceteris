/**
 * @file src/shared/output-flow.test.ts
 * @purpose Tests for the ADR-051 ack payload check and the renderer side ack batcher.
 *   One test per rule; no xterm, the parse callback is called by hand.
 */
import { describe, expect, it } from 'vitest';
import {
  checkAckPayload,
  FLOW_ACK_CHUNK,
  FLOW_HIGH_WATERMARK,
  FLOW_HOLD_CAP,
  FLOW_LOW_WATERMARK,
  isPermanentAckError,
  OutputAcker,
} from './output-flow';

function makeAcker(chunk = 100): { acker: OutputAcker; sent: Array<[number, boolean]> } {
  const sent: Array<[number, boolean]> = [];
  const acker = new OutputAcker((bytes, detach) => sent.push([bytes, detach]), chunk);
  return { acker, sent };
}

describe('output flow constants', () => {
  it('an ack chunk never exceeds the low watermark, so a fully parsed stream always resumes', () => {
    expect(FLOW_ACK_CHUNK).toBeLessThanOrEqual(FLOW_LOW_WATERMARK);
  });

  it('the hold cap is well above the window, so only a far behind owner is resynced', () => {
    expect(FLOW_HOLD_CAP).toBeGreaterThanOrEqual(FLOW_HIGH_WATERMARK * 10);
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

describe('isPermanentAckError', () => {
  it('is permanent when the Host or main does not know the command, or rejects the payload', () => {
    const electron = "Error invoking remote method 'cmd:session:ack-output': Error: ";
    expect(isPermanentAckError(new Error(electron + "No handler registered for 'x'"))).toBe(true);
    expect(
      isPermanentAckError(new Error(electron + '[ipc] dispatchLocalCommand: 未知 channel')),
    ).toBe(true);
    expect(isPermanentAckError(new Error(electron + '[ipc] InvalidPayload: ack-output'))).toBe(
      true,
    );
  });

  it('is transient for a Link that is reconnecting or a timeout', () => {
    expect(isPermanentAckError(new Error('[LinkClient] 连接中断,命令结果未知:socket closed'))).toBe(
      false,
    );
    expect(isPermanentAckError(new Error('timeout after 30000 ms'))).toBe(false);
    expect(isPermanentAckError('weird')).toBe(false);
  });
});

describe('OutputAcker', () => {
  it('giveBack keeps the bytes of a failed ack for the next one without sending by itself', () => {
    const { acker, sent } = makeAcker();
    acker.giveBack(40);
    expect(sent).toEqual([]);
    acker.received(60)?.();
    expect(sent).toEqual([[100, false]]);
  });

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
