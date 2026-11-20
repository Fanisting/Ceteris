/**
 * @file src/shared/link-test.ts
 * @purpose Ceteris Link 连接测试(ADR-055)的结果结构和判读规则。main 填结果,
 *   设置页按这里的判读显示结论和建议。
 *
 * @关键设计:
 * - 判读只出代码(LinkTestFindingCode)和数字,不出文字。中英文文案在 renderer 里,
 *   跟着界面语言走;规则在这里,能单测。
 * - 阈值按 Tailscale 的实际情况取:直连的往返一般在 50 ms 以内,DERP 中继在 50 到
 *   150 ms;终端打字的回显超过 150 ms 就能感觉到拖。
 * - "重标签"看的是远程窗口最近 5 分钟收到的输出,不看网络。网络好但某个 agent 一次
 *   重画十几万字节(omp 每次换尺寸都把整段对话重发一遍)时,慢的原因在那个标签。
 *
 * @对应文档章节: docs/软件定义书.md ADR-055;docs/ceteris-link-protocol.md 第 4.4 节
 *
 * @不要在这里做的事:
 * - 不要 import node 模块(renderer 也用这个文件)
 * - 不要放界面文案
 */

/**
 * 到 Host 的网络路径,从本机 `tailscale status --json` 读出。
 *
 * - local:目标就是本机(测试用的 127.0.0.1 或本机自己的 Tailscale 地址)
 * - direct:Tailscale 直连(endpoint 是对方的公网或局域网地址)
 * - relay:走 DERP 中继(relay 是中继区域代码,如 "tok")
 * - offline:Tailscale 认得这台机器,但它现在不在线
 * - not-tailscale:地址不在本机的 Tailscale 网络里(局域网直连或填错了)
 * - unknown:本机没装 Tailscale 命令行,或读不出状态
 */
export type LinkTestPathKind =
  | 'local'
  | 'direct'
  | 'relay'
  | 'offline'
  | 'not-tailscale'
  | 'unknown';

export interface LinkTestPath {
  kind: LinkTestPathKind;
  /** kind 为 relay 时的中继名:DERP 区域代码(如 "tok"),或 Tailscale peer relay 的地址 */
  relay?: string;
  /** kind 为 direct 时 Tailscale 正在用的对端地址,如 "203.0.113.5:41641" */
  endpoint?: string;
}

/** 一组往返时间的统计。 */
export interface LinkRttSummary {
  sent: number;
  received: number;
  minMs: number;
  medianMs: number;
  p95Ms: number;
  /** 相邻两次往返之差的平均绝对值 */
  jitterMs: number;
}

/** 远程窗口里一个标签最近 5 分钟的输出情况。 */
export interface LinkTabTraffic {
  sessionId: string;
  /** Host 上的标签名;取不到时是 sessionId 的前 8 位 */
  name: string;
  /** 5 分钟内收到的终端输出字节数(解码后的原始字节) */
  bytes: number;
  /** 最大的一阵输出(相邻两块间隔不到 250 ms 算同一阵)的字节数 */
  largestBurstBytes: number;
  /** 带清屏(ESC[2J)的输出块数,大致等于整屏重画的次数 */
  redraws: number;
  /** Host 因为窗口跟不上而丢掉输出、让窗口重放的次数(ADR-051 的 output-resync) */
  resyncs: number;
}

/** 速度测试没做的原因。 */
export type LinkSpeedSkipReason = 'not-connected' | 'host-too-old' | 'timeout' | 'failed';

/** cmd:link:test 的返回值。 */
export interface LinkTestResult {
  /** 测试完成的时刻(Unix ms) */
  at: number;
  /** "host:port" */
  address: string;
  /** 测试时这条连接是否已连上(没连上时只测路径和 TCP 建连) */
  connected: boolean;
  /** 没连上时测的 TCP 建连用时;建不起来,或测试时已经连上(不需要测)时为 null */
  connectMs: number | null;
  /** 建连失败的原因(可读文本,来自系统错误);成功时为空串 */
  connectError: string;
  path: LinkTestPath;
  /** 往返统计;没连上时为 null */
  rtt: LinkRttSummary | null;
  /** 下行(Host → 本机)速度,MB/s;没测时为 null */
  downMBps: number | null;
  /** 上行(本机 → Host)速度,MB/s;没测时为 null */
  upMBps: number | null;
  /** 速度没测的原因;测了为 null */
  speedSkipped: LinkSpeedSkipReason | null;
  /** 这条连接是否在压缩(两端都支持 ADR-056 时为 true) */
  compressed: boolean;
  /** 输出最多的几个标签,多的在前;没连上时为空 */
  tabs: LinkTabTraffic[];
}

/** 判读出的一条发现。按严重程度排,最重的在前。 */
export type LinkTestFindingCode =
  | 'unreachable'
  | 'no-reply'
  | 'packet-loss'
  | 'relay'
  | 'high-rtt'
  | 'jitter'
  | 'slow-down'
  | 'slow-up'
  | 'speed-failed'
  | 'heavy-tab'
  | 'host-too-old'
  | 'not-connected';

export interface LinkTestFinding {
  code: LinkTestFindingCode;
  level: 'bad' | 'warn' | 'info';
  /** heavy-tab 时是那个标签 */
  tab?: LinkTabTraffic;
}

export interface LinkTestAssessment {
  /** 总体:bad = 基本不能用,warn = 能用但慢,ok = 正常 */
  level: 'ok' | 'warn' | 'bad';
  findings: LinkTestFinding[];
}

/** 往返中位数超过这个值,打字回显就能感觉到拖 */
export const LINK_TEST_HIGH_RTT_MS = 150;
/** p95 比中位数高出这么多,说明时快时慢 */
export const LINK_TEST_JITTER_SPREAD_MS = 250;
/** 下行低于这个速度,一次 160 KB 的整屏重画要等 0.3 秒以上 */
export const LINK_TEST_SLOW_DOWN_MBPS = 0.5;
export const LINK_TEST_SLOW_UP_MBPS = 0.2;
/** 一阵输出超过这个字节数,算"重画很重"的标签 */
export const LINK_TEST_HEAVY_BURST_BYTES = 100 * 1024;
/** 5 分钟里整屏重画超过这个次数,也算重 */
export const LINK_TEST_HEAVY_REDRAWS = 5;

/**
 * 把往返样本整理成统计。
 *
 * @param samples 收到回音的往返时间(ms),按发出顺序
 * @param sent 一共发出的 ping 数
 * @returns 没有任何样本时为 null
 */
export function summarizeRtt(samples: number[], sent: number): LinkRttSummary | null {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const pick = (q: number): number =>
    sorted[Math.max(0, Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1))] ?? 0;
  let jitter = 0;
  samples.forEach((v, i) => {
    if (i > 0) jitter += Math.abs(v - (samples[i - 1] ?? v));
  });
  return {
    sent,
    received: samples.length,
    minMs: pick(0),
    medianMs: pick(0.5),
    p95Ms: pick(0.95),
    jitterMs: samples.length > 1 ? Math.round(jitter / (samples.length - 1)) : 0,
  };
}

/**
 * 判读一次测试结果。
 *
 * @returns 总体结论和发现列表,最重的发现在前
 */
export function assessLinkTest(r: LinkTestResult): LinkTestAssessment {
  const findings: LinkTestFinding[] = [];
  if (!r.connected && r.connectMs === null) {
    findings.push({ code: 'unreachable', level: 'bad' });
  }
  // 连着却一个 pong 都没回来:Host 写缓冲积压或线路几乎不通
  if (r.connected && r.rtt === null) {
    findings.push({ code: 'no-reply', level: 'bad' });
  }
  if (r.rtt && r.rtt.received < r.rtt.sent) {
    findings.push({ code: 'packet-loss', level: 'bad' });
  }
  if (r.path.kind === 'relay') findings.push({ code: 'relay', level: 'warn' });
  if (r.rtt && r.rtt.medianMs > LINK_TEST_HIGH_RTT_MS) {
    findings.push({ code: 'high-rtt', level: 'warn' });
  }
  if (r.rtt && r.rtt.p95Ms - r.rtt.medianMs > LINK_TEST_JITTER_SPREAD_MS) {
    findings.push({ code: 'jitter', level: 'warn' });
  }
  if (r.downMBps !== null && r.downMBps < LINK_TEST_SLOW_DOWN_MBPS) {
    findings.push({ code: 'slow-down', level: 'warn' });
  }
  if (r.upMBps !== null && r.upMBps < LINK_TEST_SLOW_UP_MBPS) {
    findings.push({ code: 'slow-up', level: 'warn' });
  }
  if (r.speedSkipped === 'timeout' || r.speedSkipped === 'failed') {
    findings.push({ code: 'speed-failed', level: 'warn' });
  }
  for (const tab of r.tabs) {
    if (
      tab.largestBurstBytes >= LINK_TEST_HEAVY_BURST_BYTES ||
      tab.redraws > LINK_TEST_HEAVY_REDRAWS
    ) {
      findings.push({ code: 'heavy-tab', level: 'warn', tab });
    }
  }
  if (r.speedSkipped === 'host-too-old') findings.push({ code: 'host-too-old', level: 'info' });
  if (!r.connected && r.connectMs !== null) findings.push({ code: 'not-connected', level: 'info' });

  const level = findings.some((f) => f.level === 'bad')
    ? 'bad'
    : findings.some((f) => f.level === 'warn')
      ? 'warn'
      : 'ok';
  return { level, findings };
}
