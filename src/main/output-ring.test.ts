/**
 * @file src/main/output-ring.test.ts
 * @purpose OutputRing 的规则:上限与淘汰、连续 / 缺口判断、seq 去重。
 * @对应文档章节: docs/软件定义书.md ADR-050
 */
import { describe, expect, it } from 'vitest';
import { OutputRing } from './output-ring';

/** n 个字节的 base64。 */
const b64 = (n: number, ch = 'x'): string => Buffer.from(ch.repeat(n)).toString('base64');

describe('OutputRing', () => {
  it('空环对任何 afterSeq 都返回连续的空结果', () => {
    const ring = new OutputRing(100);
    expect(ring.since(-1)).toEqual({ gap: false, chunks: [] });
    expect(ring.since(5)).toEqual({ gap: false, chunks: [] });
  });

  it('只返回 seq 大于 afterSeq 的输出,顺序不变', () => {
    const ring = new OutputRing(100);
    ring.append(2, b64(1, 'a'));
    ring.append(5, b64(1, 'b'));
    ring.append(9, b64(1, 'c'));
    expect(ring.since(-1)).toEqual({
      gap: false,
      chunks: [
        { seq: 2, data: b64(1, 'a') },
        { seq: 5, data: b64(1, 'b') },
        { seq: 9, data: b64(1, 'c') },
      ],
    });
    // afterSeq 落在两条之间也算连续:聚合 emit 让 seq 本来就不连续
    expect(ring.since(3)).toEqual({
      gap: false,
      chunks: [
        { seq: 5, data: b64(1, 'b') },
        { seq: 9, data: b64(1, 'c') },
      ],
    });
    expect(ring.since(9)).toEqual({ gap: false, chunks: [] });
  });

  it('超过上限时从最旧的开始丢,总字节不超过上限', () => {
    const ring = new OutputRing(10);
    ring.append(0, b64(4));
    ring.append(1, b64(4));
    ring.append(2, b64(4));
    expect(ring.sizeBytes).toBe(8);
    expect(ring.since(0)).toEqual({
      gap: false,
      chunks: [
        { seq: 1, data: b64(4) },
        { seq: 2, data: b64(4) },
      ],
    });
  });

  it('afterSeq 早于被丢弃的部分时报告缺口', () => {
    const ring = new OutputRing(10);
    ring.append(0, b64(4));
    ring.append(1, b64(4));
    ring.append(2, b64(4)); // 丢掉 seq 0
    expect(ring.since(-1)).toEqual({ gap: true });
    expect(ring.since(0).gap).toBe(false);
  });

  it('单条超过上限时只保留这一条', () => {
    const ring = new OutputRing(10);
    ring.append(0, b64(4));
    ring.append(1, b64(50));
    expect(ring.sizeBytes).toBe(50);
    expect(ring.since(0)).toEqual({ gap: false, chunks: [{ seq: 1, data: b64(50) }] });
    expect(ring.since(-1)).toEqual({ gap: true });
  });

  it('重复或倒退的 seq 被忽略', () => {
    const ring = new OutputRing(100);
    ring.append(3, b64(1, 'a'));
    ring.append(3, b64(1, 'b'));
    ring.append(1, b64(1, 'c'));
    expect(ring.since(-1)).toEqual({ gap: false, chunks: [{ seq: 3, data: b64(1, 'a') }] });
  });

  it('长时间运行后内部压缩不丢数据', () => {
    const ring = new OutputRing(100);
    for (let seq = 0; seq < 1000; seq++) ring.append(seq, b64(10));
    const res = ring.since(989);
    expect(res.gap).toBe(false);
    expect(res.gap === false && res.chunks.map((c) => c.seq)).toEqual([
      990, 991, 992, 993, 994, 995, 996, 997, 998, 999,
    ]);
    expect(ring.since(988)).toEqual({ gap: true });
  });

  it('上限不是正数时拒绝构造', () => {
    expect(() => new OutputRing(0)).toThrow(/capBytes/);
  });
});
