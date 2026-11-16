/**
 * @file src/main/link/link-liveness.test.ts
 * @purpose ADR-050 的活性规则:变慢与断线的时机、重连退避的范围、人工延迟开关。
 * @对应文档章节: docs/ceteris-link-protocol.md 第 4 章
 */
import { describe, expect, it } from 'vitest';
import {
  LINK_HEARTBEAT_TIMEOUT_MS,
  LINK_LAGGY_AFTER_INPUT_MS,
  LINK_LAGGY_AFTER_PING_MS,
  LINK_RECONNECT_MAX_MS,
} from '@shared/link-protocol';
import {
  computeReconnectDelay,
  evaluateLiveness,
  LinkLiveness,
  readLinkDelayMs,
} from './link-liveness';

describe('LinkLiveness:变慢', () => {
  it('ping 后 3 秒内没有入站时不算变慢,到 3 秒算', () => {
    const l = new LinkLiveness(0);
    l.notePingSent(1_000);
    expect(l.verdict(1_000 + LINK_LAGGY_AFTER_PING_MS - 1).laggy).toBe(false);
    expect(l.verdict(1_000 + LINK_LAGGY_AFTER_PING_MS).laggy).toBe(true);
  });

  it('输入后 1 秒没有入站算变慢', () => {
    const l = new LinkLiveness(0);
    l.noteInputSent(500);
    expect(l.verdict(500 + LINK_LAGGY_AFTER_INPUT_MS - 1).laggy).toBe(false);
    expect(l.verdict(500 + LINK_LAGGY_AFTER_INPUT_MS).laggy).toBe(true);
  });

  it('任何入站帧清掉变慢', () => {
    const l = new LinkLiveness(0);
    l.noteInputSent(0);
    expect(l.verdict(2_000).laggy).toBe(true);
    l.noteInbound(2_000);
    expect(l.verdict(2_000).laggy).toBe(false);
    expect(l.verdict(9_000).laggy).toBe(false);
  });

  it('连续打字不会把计时往后推:从入站后的第一次输入算起', () => {
    const l = new LinkLiveness(0);
    l.noteInputSent(100);
    l.noteInputSent(600);
    l.noteInputSent(1_000);
    expect(l.verdict(100 + LINK_LAGGY_AFTER_INPUT_MS).laggy).toBe(true);
  });

  it('没有发过 ping 或输入时,安静的连接不算变慢', () => {
    const l = new LinkLiveness(0);
    expect(l.verdict(10_000).laggy).toBe(false);
  });
});

describe('LinkLiveness:断线', () => {
  it('15 秒没有入站判定断线,14.999 秒不算', () => {
    const l = new LinkLiveness(0);
    expect(l.verdict(LINK_HEARTBEAT_TIMEOUT_MS - 1).dead).toBe(false);
    expect(l.verdict(LINK_HEARTBEAT_TIMEOUT_MS).dead).toBe(true);
    expect(LINK_HEARTBEAT_TIMEOUT_MS).toBe(15_000);
  });

  it('入站把断线计时重置', () => {
    const l = new LinkLiveness(0);
    l.noteInbound(10_000);
    expect(l.verdict(20_000).dead).toBe(false);
    expect(l.verdict(25_000).dead).toBe(true);
  });
});

describe('LinkLiveness.nextCheckAt', () => {
  it('取最近的一个阈值', () => {
    const l = new LinkLiveness(0);
    expect(l.nextCheckAt(0)).toBe(LINK_HEARTBEAT_TIMEOUT_MS);
    l.notePingSent(5_000);
    expect(l.nextCheckAt(5_000)).toBe(5_000 + LINK_LAGGY_AFTER_PING_MS);
    l.noteInputSent(5_500);
    expect(l.nextCheckAt(5_500)).toBe(5_500 + LINK_LAGGY_AFTER_INPUT_MS);
  });

  it('已经越过的变慢阈值不再计入,只剩断线', () => {
    const l = new LinkLiveness(0);
    l.noteInputSent(0);
    expect(l.nextCheckAt(2_000)).toBe(LINK_HEARTBEAT_TIMEOUT_MS);
  });
});

describe('evaluateLiveness', () => {
  it('只读一次时钟:时钟在两次调用之间前进也不会跳过刚好到点的阈值', () => {
    const l = new LinkLiveness(0);
    l.noteInputSent(0); // 变慢阈值在 1000
    // 每读一次前进 1 ms。分两次读(先判定后排期)时,判定在 999 说"还没变慢",
    // 排期在 1000 把 1000 当成过去滤掉,下一次检查就跳到 15000。
    let t = LINK_LAGGY_AFTER_INPUT_MS - 1;
    const clock = (): number => t++;
    const step = evaluateLiveness(l, clock);
    expect(t).toBe(LINK_LAGGY_AFTER_INPUT_MS); // 只读了一次
    expect(step.verdict.laggy).toBe(false);
    expect(step.nextCheckAt).toBe(LINK_LAGGY_AFTER_INPUT_MS);

    // 对照:分两次读时阈值被跳过
    t = LINK_LAGGY_AFTER_INPUT_MS - 1;
    expect(l.verdict(clock()).laggy).toBe(false);
    expect(l.nextCheckAt(clock())).toBe(LINK_HEARTBEAT_TIMEOUT_MS);
  });
});

describe('computeReconnectDelay', () => {
  it('从 0.5 秒起翻倍,30 秒封顶(无抖动时)', () => {
    const mid = 0.5; // 抖动系数恰好为 1
    expect([0, 1, 2, 3, 4, 5, 6, 7, 20].map((a) => computeReconnectDelay(a, mid))).toEqual([
      500, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000,
    ]);
  });

  it('抖动在 ±20% 之内', () => {
    for (const attempt of [0, 3, 5]) {
      const base = computeReconnectDelay(attempt, 0.5);
      const low = computeReconnectDelay(attempt, 0);
      const high = computeReconnectDelay(attempt, 0.999999);
      expect(low).toBe(Math.round(base * 0.8));
      expect(high).toBeLessThanOrEqual(Math.round(base * 1.2));
      expect(high).toBeGreaterThan(base);
    }
  });

  it('抖动之后再封顶:到顶后的重试不超过 30 秒,最短 24 秒', () => {
    for (const attempt of [6, 7, 10, 99]) {
      expect(computeReconnectDelay(attempt, 0.999999)).toBe(LINK_RECONNECT_MAX_MS);
      expect(computeReconnectDelay(attempt, 0.5)).toBe(LINK_RECONNECT_MAX_MS);
      expect(computeReconnectDelay(attempt, 0)).toBe(LINK_RECONNECT_MAX_MS * 0.8);
    }
    for (let i = 0; i < 500; i++) {
      expect(computeReconnectDelay(i % 20)).toBeLessThanOrEqual(LINK_RECONNECT_MAX_MS);
    }
  });

  it('随机输入下始终落在范围内', () => {
    for (let i = 0; i < 200; i++) {
      const d = computeReconnectDelay(i % 8);
      const base = Math.min(500 * 2 ** (i % 8), LINK_RECONNECT_MAX_MS);
      expect(d).toBeGreaterThanOrEqual(Math.floor(base * 0.8));
      expect(d).toBeLessThanOrEqual(Math.min(Math.ceil(base * 1.2), LINK_RECONNECT_MAX_MS));
    }
  });
});

describe('readLinkDelayMs', () => {
  it('stable 构建忽略环境变量', () => {
    expect(readLinkDelayMs('120', 'stable')).toBe(0);
  });

  it('dev 与 beta 读取正整数', () => {
    expect(readLinkDelayMs('120', 'dev')).toBe(120);
    expect(readLinkDelayMs('80.4', 'beta')).toBe(80);
  });

  it('缺省、非数字、非正数都视为不延迟,过大的值封顶', () => {
    expect(readLinkDelayMs(undefined, 'dev')).toBe(0);
    expect(readLinkDelayMs('abc', 'dev')).toBe(0);
    expect(readLinkDelayMs('-5', 'dev')).toBe(0);
    expect(readLinkDelayMs('999999', 'dev')).toBe(5_000);
  });
});
