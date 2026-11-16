/**
 * @file src/main/link/link-liveness.ts
 * @purpose Ceteris Link 连接活性判断的纯逻辑(ADR-050):什么时候算"变慢"、什么时候算
 *   "已断",断了之后隔多久重连,以及开发用的人工延迟开关。
 *
 * @关键设计:
 * - 纯函数 + 不持有定时器的状态类,时间由调用方传入。link-client.ts 负责定时器,这里
 *   只回答"现在是什么状态、下一次该什么时候再看"。这样规则能脱离 socket 单测。
 * - 任何入站帧都算活动(pong、事件、命令结果都一样),它会同时清掉"变慢"。
 * - "变慢"有两个来源:ping 发出 3 秒没有回音;用户输入 1 秒没有回音。两者都以
 *   "上一次入站之后第一次发出"为起点,连续打字不会把计时一直往后推。
 * - 重连退避从 0.5 秒起翻倍到 30 秒,带 ±20% 抖动。
 *
 * @对应文档章节: docs/ceteris-link-protocol.md 第 4 章;docs/软件定义书.md ADR-050
 *
 * @不要在这里做的事:
 * - 不要在这里起定时器或碰 socket(那是 link-client.ts / link-server.ts 的职责)
 * - 不要读 process.env(调用方读好传进来,测试才不依赖环境)
 */
import {
  LINK_HEARTBEAT_TIMEOUT_MS,
  LINK_LAGGY_AFTER_INPUT_MS,
  LINK_LAGGY_AFTER_PING_MS,
  LINK_RECONNECT_BASE_MS,
  LINK_RECONNECT_JITTER,
  LINK_RECONNECT_MAX_MS,
} from '@shared/link-protocol';
import type { Channel } from '@shared/channel';

/** 活性阈值,默认取 link-protocol.ts 的常量。 */
export interface LinkLivenessThresholds {
  laggyAfterPingMs: number;
  laggyAfterInputMs: number;
  deadAfterMs: number;
}

const DEFAULT_THRESHOLDS: LinkLivenessThresholds = {
  laggyAfterPingMs: LINK_LAGGY_AFTER_PING_MS,
  laggyAfterInputMs: LINK_LAGGY_AFTER_INPUT_MS,
  deadAfterMs: LINK_HEARTBEAT_TIMEOUT_MS,
};

/** 某一时刻的判定结果。 */
export interface LinkLivenessVerdict {
  laggy: boolean;
  dead: boolean;
}

/**
 * 一条连接的活性状态。
 *
 *   有入站 ──> 正常 ──ping 后 3s / 输入后 1s 无入站──> 变慢
 *     ^                                                 │
 *     └──────────────── 任何入站帧 ─────────────────────┘
 *   任一状态下 15s 无入站 ──> 已断(调用方断开并重连)
 */
export class LinkLiveness {
  private lastInboundAt: number;
  /** 上一次入站之后第一次发 ping 的时刻;null = 之后还没发过 */
  private pingPendingSince: number | null = null;
  /** 上一次入站之后第一次发输入的时刻;null = 之后还没发过 */
  private inputPendingSince: number | null = null;

  constructor(
    now: number,
    private readonly t: LinkLivenessThresholds = DEFAULT_THRESHOLDS,
  ) {
    this.lastInboundAt = now;
  }

  /** 收到任何入站数据。清掉"变慢"。 */
  noteInbound(now: number): void {
    this.lastInboundAt = now;
    this.pingPendingSince = null;
    this.inputPendingSince = null;
  }

  /** 发出了一个 ping。 */
  notePingSent(now: number): void {
    if (this.pingPendingSince === null) this.pingPendingSince = now;
  }

  /** 发出了一条终端输入。 */
  noteInputSent(now: number): void {
    if (this.inputPendingSince === null) this.inputPendingSince = now;
  }

  /** 现在的判定。 */
  verdict(now: number): LinkLivenessVerdict {
    const laggyByPing =
      this.pingPendingSince !== null && now - this.pingPendingSince >= this.t.laggyAfterPingMs;
    const laggyByInput =
      this.inputPendingSince !== null && now - this.inputPendingSince >= this.t.laggyAfterInputMs;
    return {
      laggy: laggyByPing || laggyByInput,
      dead: now - this.lastInboundAt >= this.t.deadAfterMs,
    };
  }

  /**
   * 判定结果下一次可能变化的时刻,调用方在那时再调 verdict()。
   *
   * @returns 绝对时间(与传入的 now 同一时钟);已经变慢的条件不再计入,只剩"已断"
   */
  nextCheckAt(now: number): number {
    const candidates = [this.lastInboundAt + this.t.deadAfterMs];
    if (this.pingPendingSince !== null) {
      candidates.push(this.pingPendingSince + this.t.laggyAfterPingMs);
    }
    if (this.inputPendingSince !== null) {
      candidates.push(this.inputPendingSince + this.t.laggyAfterInputMs);
    }
    const future = candidates.filter((at) => at > now);
    return future.length > 0 ? Math.min(...future) : now;
  }
}

/**
 * 第 attempt 次重连(从 0 起)前要等多久。
 *
 * @param attempt 已经失败的次数,0 表示第一次重试
 * @param random [0, 1) 的随机数,测试时传固定值
 * @returns 毫秒数,落在 base·2^attempt(封顶 30 秒)的 ±20% 之内
 */
export function computeReconnectDelay(attempt: number, random: number = Math.random()): number {
  const exp = Math.min(LINK_RECONNECT_BASE_MS * 2 ** Math.max(0, attempt), LINK_RECONNECT_MAX_MS);
  const factor = 1 + (random * 2 - 1) * LINK_RECONNECT_JITTER;
  return Math.round(exp * factor);
}

/** 人工延迟的上限:再大就不是在模拟网络,而是在制造断线了。 */
const LINK_DELAY_MAX_MS = 5_000;

/**
 * 读开发用的人工延迟 CETERIS_LINK_DELAY_MS(模拟 DERP 中继的延迟)。
 *
 * 只在 dev 与 beta 构建里生效:stable 是用户的日常环境,一个遗留在系统环境变量里的
 * 设置不应该让真实使用变慢。
 *
 * @param raw 环境变量原值
 * @param channel 当前构建渠道
 * @returns 每个出站帧额外等待的毫秒数;0 表示不延迟
 */
export function readLinkDelayMs(raw: string | undefined, channel: Channel): number {
  if (channel === 'stable' || raw === undefined) return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(Math.round(n), LINK_DELAY_MAX_MS);
}
