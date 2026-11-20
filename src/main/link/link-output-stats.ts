/**
 * @file src/main/link/link-output-stats.ts
 * @purpose 远程窗口里每个标签最近 5 分钟收到了多少终端输出(ADR-055 连接测试的"重标签")。
 *
 * @关键设计:
 * - 记在 Client 的 main 进程里,Host 推来的每条 evt:session:output 都经过这里。
 *   不改、不缓存输出内容,只记时间、字节数和"这块里有没有清屏"。
 * - 一阵输出 = 相邻两块间隔不到 250 ms。omp 换尺寸后的整屏重画在 Host 上一次写完,
 *   到这边被 16 ms 的聚合切成二十来块,连在一起就是一阵。
 * - 清屏用 ESC[2J 判断。整屏重画都会先清屏;普通的逐行输出不会。
 * - 只保留 5 分钟内的记录,每次记录时顺手清掉过期的,内存跟输出速度成正比、有上限。
 * - 时间由调用方传入,规则能脱离定时器单测。
 *
 * @对应文档章节: docs/软件定义书.md ADR-055
 *
 * @不要在这里做的事:
 * - 不要保存输出内容本身
 * - 不要在这里解码 base64 之外的任何东西(终端语义交给 renderer 的 xterm)
 */

/** 统计窗口 */
export const LINK_OUTPUT_STATS_WINDOW_MS = 5 * 60_000;
/** 相邻两块输出间隔小于这个值算同一阵 */
export const LINK_OUTPUT_BURST_GAP_MS = 250;
/** 每个标签最多保留的输出块记录数。超过时丢最旧的,统计会偏小但不会无限增长 */
const MAX_CHUNKS_PER_SESSION = 20_000;

/** ESC[2J 的字节 */
const CLEAR_SCREEN = Buffer.from('\x1b[2J', 'latin1');

interface ChunkRecord {
  at: number;
  bytes: number;
  clears: boolean;
}

interface SessionRecord {
  chunks: ChunkRecord[];
  resyncs: number[];
}

/** 一个标签的统计结果(还没有标签名,名字由调用方从 Host 的快照里补)。 */
export interface LinkSessionTraffic {
  sessionId: string;
  bytes: number;
  largestBurstBytes: number;
  redraws: number;
  resyncs: number;
}

export class LinkOutputStats {
  private readonly sessions = new Map<string, SessionRecord>();

  /**
   * 记一块输出。
   *
   * @param sessionId 输出所属的 session
   * @param base64 evt:session:output 的 data 字段
   * @param now 收到的时刻(ms)
   */
  noteOutput(sessionId: string, base64: string, now: number): void {
    const bytes = Buffer.from(base64, 'base64');
    const rec = this.record(sessionId);
    rec.chunks.push({ at: now, bytes: bytes.length, clears: bytes.includes(CLEAR_SCREEN) });
    if (rec.chunks.length > MAX_CHUNKS_PER_SESSION) rec.chunks.shift();
    this.prune(rec, now);
  }

  /** 记一次 Host 丢输出、让窗口重放(evt:session:output-resync)。 */
  noteResync(sessionId: string, now: number): void {
    const rec = this.record(sessionId);
    rec.resyncs.push(now);
    this.prune(rec, now);
  }

  /** session 关了或者归了别的窗口(evt:session:owner-changed),不再统计它。 */
  forget(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /**
   * 最近 5 分钟有输出的标签,按输出量从多到少。
   *
   * @param now 当前时刻(ms)
   * @param limit 最多返回几个
   */
  summarize(now: number, limit = 5): LinkSessionTraffic[] {
    const out: LinkSessionTraffic[] = [];
    for (const [sessionId, rec] of this.sessions) {
      this.prune(rec, now);
      if (rec.chunks.length === 0 && rec.resyncs.length === 0) continue;
      let bytes = 0;
      let redraws = 0;
      let largest = 0;
      let burst = 0;
      let lastAt = -Infinity;
      for (const c of rec.chunks) {
        bytes += c.bytes;
        if (c.clears) redraws++;
        burst = c.at - lastAt < LINK_OUTPUT_BURST_GAP_MS ? burst + c.bytes : c.bytes;
        lastAt = c.at;
        largest = Math.max(largest, burst);
      }
      out.push({
        sessionId,
        bytes,
        largestBurstBytes: largest,
        redraws,
        resyncs: rec.resyncs.length,
      });
    }
    return out.sort((a, b) => b.bytes - a.bytes).slice(0, limit);
  }

  private record(sessionId: string): SessionRecord {
    let rec = this.sessions.get(sessionId);
    if (!rec) {
      rec = { chunks: [], resyncs: [] };
      this.sessions.set(sessionId, rec);
    }
    return rec;
  }

  private prune(rec: SessionRecord, now: number): void {
    const cutoff = now - LINK_OUTPUT_STATS_WINDOW_MS;
    let i = 0;
    while ((rec.chunks[i]?.at ?? Infinity) < cutoff) i++;
    if (i > 0) rec.chunks.splice(0, i);
    let j = 0;
    while ((rec.resyncs[j] ?? Infinity) < cutoff) j++;
    if (j > 0) rec.resyncs.splice(0, j);
  }
}
