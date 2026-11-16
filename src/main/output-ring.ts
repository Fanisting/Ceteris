/**
 * @file src/main/output-ring.ts
 * @purpose 每个 session 一份的"最近输出"环形缓冲:按 seq 记下已经 emit 过的
 *   evt:session:output,供 Ceteris Link 重连后只补发断线期间漏掉的那一段
 *   (ADR-050),不必整页 reload、重拉 2.7 MB 的 snapshot。
 *
 * @关键设计:
 * - 存的是 emit 时的原样 payload(base64 + seq)。补发时原样塞回事件流,renderer
 *   的 seq 去重逻辑不需要任何改动。
 * - 上限按解码后的字节数算(默认 1 MiB),超出从最旧的一条开始丢。单条超过上限时
 *   只保留它自己,保证"最新一条一定在"。
 * - 连续性靠 evictedThroughSeq:被丢掉的最后一条的 seq。调用方给的 afterSeq 只要
 *   不小于它,seq > afterSeq 的输出就全部还在环里;否则中间有缺口,调用方必须
 *   退回 snapshot 路径。emit 出去的 seq 并不连续(8ms 聚合只带最后一个 seq),
 *   所以不能用"首条 seq == afterSeq + 1"判断连续。
 *
 * @对应文档章节: docs/ceteris-link-protocol.md 第 6 章;docs/软件定义书.md ADR-050
 *
 * @不要在这里做的事:
 * - 不要在这里做 base64 编解码之外的任何解析(OSC、状态机都在 session-manager)
 * - 不要把它当 scrollback 用:它只覆盖最近一小段,完整状态在 headless 终端里
 */

/** 默认上限:每个 session 保留约 1 MiB 的原始输出字节。 */
export const OUTPUT_RING_DEFAULT_CAP_BYTES = 1024 * 1024;

/** 环里的一条输出,与 SessionOutputPayload 的 data / seq 同义。 */
export interface OutputRingChunk {
  seq: number;
  /** base64 编码的原始字节 */
  data: string;
}

/** since() 的结果:要么是 afterSeq 之后的全部输出,要么是"有缺口"。 */
export type OutputRingSinceResult = { gap: false; chunks: OutputRingChunk[] } | { gap: true };

interface StoredChunk extends OutputRingChunk {
  bytes: number;
}

export class OutputRing {
  private readonly chunks: StoredChunk[] = [];
  /** 第一条未丢弃的下标。用下标前移代替 shift(),避免大数组反复搬移。 */
  private head = 0;
  private totalBytes = 0;
  /** 被丢掉的最后一条的 seq;-1 表示从未丢过,环里是该 session 的全部输出。 */
  private evictedThroughSeq = -1;

  /**
   * @param capBytes 解码后字节数上限,必须是正数
   * @throws Error capBytes 不是正数时
   */
  constructor(private readonly capBytes: number = OUTPUT_RING_DEFAULT_CAP_BYTES) {
    if (!(capBytes > 0)) {
      throw new Error(
        `[OutputRing] capBytes 必须是正数,收到 ${capBytes}。` +
          `可能原因:(1) 配置项写成了 0;(2) 传入了 NaN。建议:不传,使用默认 1 MiB。`,
      );
    }
  }

  /**
   * 追加一条刚 emit 的输出。seq 必须严格递增,否则忽略这条(防御重复 emit)。
   *
   * @param seq SessionOutputPayload.seq
   * @param data SessionOutputPayload.data(base64)
   */
  append(seq: number, data: string): void {
    const last = this.chunks[this.chunks.length - 1];
    if (this.chunks.length > this.head && last && seq <= last.seq) return;
    const bytes = Buffer.byteLength(data, 'base64');
    this.chunks.push({ seq, data, bytes });
    this.totalBytes += bytes;
    while (this.totalBytes > this.capBytes && this.chunks.length - this.head > 1) {
      const dropped = this.chunks[this.head]!;
      this.head++;
      this.totalBytes -= dropped.bytes;
      this.evictedThroughSeq = dropped.seq;
    }
    // 下标前移累积到一半时整体压缩一次,摊还 O(1)
    if (this.head > 64 && this.head * 2 > this.chunks.length) {
      this.chunks.splice(0, this.head);
      this.head = 0;
    }
  }

  /**
   * 取 seq > afterSeq 的全部输出。
   *
   * @param afterSeq 调用方已经拿到的最后一个 seq;-1 表示什么都没拿到
   * @returns gap=true 表示其中一部分已被丢弃,调用方要退回完整 snapshot
   */
  since(afterSeq: number): OutputRingSinceResult {
    if (afterSeq < this.evictedThroughSeq) return { gap: true };
    const out: OutputRingChunk[] = [];
    for (let i = this.head; i < this.chunks.length; i++) {
      const c = this.chunks[i]!;
      if (c.seq > afterSeq) out.push({ seq: c.seq, data: c.data });
    }
    return { gap: false, chunks: out };
  }

  /** 当前保留的解码后字节数,仅用于测试与诊断日志。 */
  get sizeBytes(): number {
    return this.totalBytes;
  }
}
