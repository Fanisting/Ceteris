/**
 * @file src/shared/paste-landing.test.ts
 * @purpose One test per rule of PasteLanding (ADR-047 item 10): when the "Sending N lines"
 *   pill may go away.
 * @对应文档章节: 软件定义书.md ADR-047 第 10 条
 */
import { describe, expect, it } from 'vitest';
import { PASTE_LANDING_MAX_MS, PASTE_QUIET_MS, PasteLanding } from './paste-landing';

describe('PasteLanding', () => {
  it('waits for nothing before any paste is accepted', () => {
    expect(new PasteLanding().wait(0)).toBeNull();
  });

  it('has not landed at the accept itself, before the agent drew anything', () => {
    const p = new PasteLanding();
    p.accepted(1000);
    expect(p.wait(1000 + PASTE_QUIET_MS * 3)).toBeGreaterThan(0);
  });

  it('lands once output after the accept has been quiet long enough', () => {
    const p = new PasteLanding();
    p.accepted(1000);
    p.output(1050);
    expect(p.wait(1050 + PASTE_QUIET_MS - 1)).toBe(1);
    expect(p.wait(1050 + PASTE_QUIET_MS)).toBe(0);
  });

  it('keeps waiting while output keeps coming', () => {
    const p = new PasteLanding();
    p.accepted(0);
    for (let t = 100; t < 1000; t += 100) {
      p.output(t);
      expect(p.wait(t + 50)).toBeGreaterThan(0);
    }
  });

  it('ignores output from before the accept', () => {
    const p = new PasteLanding();
    p.output(10);
    p.accepted(1000);
    expect(p.wait(1000 + PASTE_QUIET_MS)).toBeGreaterThan(0);
  });

  it('lands at the cap when the agent never goes quiet or never draws', () => {
    const busy = new PasteLanding();
    busy.accepted(0);
    busy.output(PASTE_LANDING_MAX_MS - 10);
    expect(busy.wait(PASTE_LANDING_MAX_MS)).toBe(0);

    const silent = new PasteLanding();
    silent.accepted(0);
    expect(silent.wait(PASTE_LANDING_MAX_MS - 1)).toBe(1);
    expect(silent.wait(PASTE_LANDING_MAX_MS)).toBe(0);
  });

  it('starts over when a second paste is accepted', () => {
    const p = new PasteLanding();
    p.accepted(0);
    p.output(100);
    p.accepted(150);
    expect(p.wait(100 + PASTE_QUIET_MS)).toBeGreaterThan(0);
  });

  it('ends the wait on landing and on reset', () => {
    const landed = new PasteLanding();
    landed.accepted(0);
    landed.output(10);
    expect(landed.wait(10 + PASTE_QUIET_MS)).toBe(0);
    expect(landed.wait(10 + PASTE_QUIET_MS + 1)).toBeNull();

    const failed = new PasteLanding();
    failed.accepted(0);
    failed.reset();
    expect(failed.wait(1)).toBeNull();
  });
});
