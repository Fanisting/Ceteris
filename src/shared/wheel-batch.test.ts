import { describe, expect, it } from 'vitest';
import { isWheelReport, WheelBatch } from './wheel-batch';

const UP = '\x1b[<64;10;5M';
const DOWN = '\x1b[<65;10;5M';

/** A send whose writes the test resolves by hand. */
function manualSend() {
  const sent: string[] = [];
  const settle: Array<(ok: boolean) => void> = [];
  const fail: Array<(e: Error) => void> = [];
  const send = (data: string): Promise<boolean> => {
    sent.push(data);
    return new Promise<boolean>((resolve, reject) => {
      settle.push(resolve);
      fail.push(reject);
    });
  };
  return { sent, settle, fail, send };
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('isWheelReport', () => {
  it('accepts wheel up, down, left, right with modifiers', () => {
    expect(isWheelReport(UP)).toBe(true);
    expect(isWheelReport('\x1b[<67;1;1M')).toBe(true);
    expect(isWheelReport('\x1b[<81;3;4M')).toBe(true); // ctrl + wheel down
    expect(isWheelReport(UP + DOWN)).toBe(true);
  });

  it('rejects clicks, drags, extra buttons, releases, keys and mixtures', () => {
    expect(isWheelReport('\x1b[<0;10;5M')).toBe(false);
    expect(isWheelReport('\x1b[<32;10;5M')).toBe(false); // drag
    expect(isWheelReport('\x1b[<128;10;5M')).toBe(false); // button 8
    expect(isWheelReport('\x1b[<64;10;5m')).toBe(false);
    expect(isWheelReport('a')).toBe(false);
    expect(isWheelReport('')).toBe(false);
    expect(isWheelReport(UP + 'a')).toBe(false);
    expect(isWheelReport(UP + '\x1b[<0;1;1M')).toBe(false);
  });
});

describe('WheelBatch', () => {
  it('sends a step at once when nothing is on its way', () => {
    const m = manualSend();
    new WheelBatch(m.send).push(UP);
    expect(m.sent).toEqual([UP]);
  });

  it('joins steps that come while a write travels, in order, and sends them together', async () => {
    const m = manualSend();
    const b = new WheelBatch(m.send);
    b.push(UP);
    b.push(DOWN);
    b.push(UP);
    expect(m.sent).toEqual([UP]);
    m.settle[0]!(true);
    await flush();
    expect(m.sent).toEqual([UP, DOWN + UP]);
    m.settle[1]!(true);
    await flush();
    expect(m.sent).toHaveLength(2);
  });

  it('frees the slot after a refusal or a failed write', async () => {
    const m = manualSend();
    const b = new WheelBatch(m.send);
    b.push(UP);
    b.push(DOWN);
    m.settle[0]!(false);
    await flush();
    expect(m.sent).toEqual([UP, DOWN]);
    b.push(UP);
    m.fail[1]!(new Error('link down'));
    await flush();
    expect(m.sent).toEqual([UP, DOWN, UP]);
  });

  it('drops the waiting batch on close', async () => {
    const m = manualSend();
    const b = new WheelBatch(m.send);
    b.push(UP);
    b.push(DOWN);
    b.close();
    m.settle[0]!(true);
    await flush();
    b.push(UP);
    expect(m.sent).toEqual([UP]);
  });
});
