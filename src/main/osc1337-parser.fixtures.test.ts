/**
 * @file src/main/osc1337-parser.fixtures.test.ts
 * @purpose 真实字节流 fixture 驱动的 parser 不变量测试。
 *
 * @背景
 * 51ab975 (OSC-3/4/6) 引入的两个 bug 都通过了原有的 67 个单测,因为单测
 * 的输入都是"设计者构造的预期场景"(知道 0x9D 是 C1 OSC 起始,于是构造
 * [0x9D,'1337;...',BEL] 来验证识别)。没有人喂"包含 UTF-8 多字节字符尾
 * 字节恰好是 0x9D 的真实 banner 字节流"作为输入,所以 OSC-4 的误识别
 * + OSC-3 的静默丢弃叠加导致 ceteris-app 启动 Claude Code 大段内容丢失
 * 的回归没被任何单测拦下来。bisect 5 步才定位到。
 *
 * @策略
 * 本测试用真实代表性的字节流 fixture(含 UTF-8 box drawing / CJK /
 * ANSI SGR / 真实 OSC 1337/0/2 / 跨 chunk split)断言**不变量**而不是
 * "我喂这个,你输出那个"。核心不变量:
 *
 *   parse(fixture).passthrough  ===  原始字节去掉已识别的 OSC 序列
 *
 * 此不变量被违反 = parser 误吃了不该吃的字节。OSC-4 误判 0x9D 会让
 * 后续字节被当 OSC payload 吞掉,passthrough 短于预期,断言失败。
 *
 * @如何加新 fixture
 * 1. 在真实 PTY 录一段问题字节流(开发者工具 / `script` 命令均可)。
 * 2. 转 base64 存为 const 字符串。
 * 3. 标注其中已识别 OSC 的位置 + 长度(stripExpectedOscRanges 参数)。
 * 4. 跑测试,验证不变量。
 *
 * @对应文档章节: AGENTS.md 5.3 必测项的"真实输入"补强;
 *   docs/终端渲染审计备忘录-20260513.md OSC-3/4 回归
 */
import { describe, expect, it } from 'vitest';
import { Osc1337Parser } from './osc1337-parser';

// ──────────────────────────────────────────────────────────────────
// Fixture helpers
// ──────────────────────────────────────────────────────────────────

/**
 * 构造 fixture:把若干 buffer 拼起来,同时记录每段在最终 buffer 中的偏移
 * 和"是否应该被 parser 剥离"。让测试不变量可以自动算出"期望 passthrough"。
 */
interface Segment {
  bytes: Buffer;
  /** true = parser 应当剥离这段(OSC 1337 / OSC 0/1/2);false = 应当透传 */
  stripped: boolean;
  /** 调试标签,断言失败时定位 */
  label: string;
}

function buildFixture(segs: Segment[]): {
  input: Buffer;
  expectedPassthrough: Buffer;
} {
  const inputParts: Buffer[] = [];
  const passParts: Buffer[] = [];
  for (const s of segs) {
    inputParts.push(s.bytes);
    if (!s.stripped) passParts.push(s.bytes);
  }
  return {
    input: Buffer.concat(inputParts),
    expectedPassthrough: Buffer.concat(passParts),
  };
}

/**
 * 把 fixture 按指定切点切成多个 chunk,模拟 PTY 字节流跨多次 onData 到达。
 */
function splitAt(buf: Buffer, points: number[]): Buffer[] {
  const out: Buffer[] = [];
  let prev = 0;
  for (const p of points) {
    if (p > prev && p <= buf.length) {
      out.push(buf.subarray(prev, p));
      prev = p;
    }
  }
  if (prev < buf.length) out.push(buf.subarray(prev));
  return out;
}

function feed(parser: Osc1337Parser, chunks: Buffer[]): Buffer {
  const passes: Buffer[] = [];
  for (const c of chunks) {
    const r = parser.parse(c);
    passes.push(r.passthrough);
  }
  return Buffer.concat(passes);
}

// ──────────────────────────────────────────────────────────────────
// Real-world byte patterns
// ──────────────────────────────────────────────────────────────────

/**
 * UTF-8 编码尾字节恰好是 0x9D 的常见字符,是历史 OSC-4 (0x9D C1 OSC
 * 识别) 误判的最小复现样本。
 *   ╝  U+255D BOX DRAWINGS DOUBLE UP AND LEFT   → E2 95 9D
 *   ݝ  U+075D ARABIC LETTER GHAIN WITH 3 DOTS   → DD 9D
 *   ѝ  U+045D CYRILLIC SMALL LETTER I GRAVE     → D1 9D
 */
const UTF8_TRAILING_0X9D = {
  boxDoubleUpLeft: Buffer.from([0xe2, 0x95, 0x9d]),
  arabicGhain: Buffer.from([0xdd, 0x9d]),
  cyrillicIGrave: Buffer.from([0xd1, 0x9d]),
} as const;

/** 真实 SGR 颜色序列(256 色 / RGB),不含 0x9D 字节但 ESC 多 */
const SGR_RESET = Buffer.from('\x1b[0m');
const SGR_RED = Buffer.from('\x1b[31m');
const SGR_RGB_PINK = Buffer.from('\x1b[38;2;255;93;158m');

/** Claude Code 风格 box drawing 单线边框 — 全是 UTF-8 多字节但不含 0x9D */
const BOX_TOP_LEFT = Buffer.from('╭', 'utf8'); // E2 95 AD
const BOX_TOP_RIGHT = Buffer.from('╮', 'utf8'); // E2 95 AE
const BOX_HORIZ = Buffer.from('─', 'utf8'); // E2 94 80
const BOX_VERT = Buffer.from('│', 'utf8'); // E2 94 82

/** 真实 OSC 0/2 标题序列与 OSC 1337 CurrentDir 序列 */
const OSC_TITLE_CLAUDE = Buffer.from('\x1b]0;Claude · ~/ceteris-app\x07');
const OSC_1337_CWD = Buffer.from('\x1b]1337;CurrentDir=C:\\proj\\ceteris\x07');

// ──────────────────────────────────────────────────────────────────
// 不变量测试
// ──────────────────────────────────────────────────────────────────

describe('Osc1337Parser — fixture-driven invariants', () => {
  it('真实 banner 字节流(含 UTF-8 尾字节 0x9D)passthrough 1:1 还原非 OSC 部分', () => {
    // 这是核心回归测试:本次 OSC-4 bug 的最小复现 fixture。
    // 一段含 ╝ (E2 95 9D) 的 banner 文本 + 真实 ANSI 颜色 + OSC 标题剥离,
    // parser 必须把 ╝ 整个字符当普通字节透传,不能在 0x9D 处误进 OSC 解析。
    const { input, expectedPassthrough } = buildFixture([
      { label: 'sgr-pink-on', bytes: SGR_RGB_PINK, stripped: false },
      { label: 'box-top-left', bytes: BOX_TOP_LEFT, stripped: false },
      { label: 'box-horiz', bytes: BOX_HORIZ, stripped: false },
      // ╝ 是 OSC-4 误判的关键字符 — 第三字节 0x9D
      {
        label: 'box-double-up-left (UTF-8 trailing 0x9D)',
        bytes: UTF8_TRAILING_0X9D.boxDoubleUpLeft,
        stripped: false,
      },
      { label: 'box-horiz-2', bytes: BOX_HORIZ, stripped: false },
      { label: 'box-top-right', bytes: BOX_TOP_RIGHT, stripped: false },
      { label: 'osc-title', bytes: OSC_TITLE_CLAUDE, stripped: true },
      { label: 'text-welcome', bytes: Buffer.from('Welcome back!'), stripped: false },
      { label: 'sgr-reset', bytes: SGR_RESET, stripped: false },
      { label: 'osc-cwd', bytes: OSC_1337_CWD, stripped: true },
      { label: 'prompt', bytes: Buffer.from('\r\nPS C:\\proj\\ceteris> '), stripped: false },
    ]);

    const parser = new Osc1337Parser();
    const out = feed(parser, [input]);
    expect(out.equals(expectedPassthrough)).toBe(true);
    // stash 不该留任何东西 — 一次完整 parse 后干净
    expect(parser.stashedBytes).toBe(0);
  });

  it('同一 fixture 在任意切点跨 chunk 到达 → 累计 passthrough 仍 1:1', () => {
    // PTY 实际 onData 可能在任意字节切开,parser 必须无状态地累计 stash
    // 而不把跨 chunk 的 OSC 漏识别也不把普通字节当 OSC 吃掉。
    const { input, expectedPassthrough } = buildFixture([
      { label: 'sgr-red', bytes: SGR_RED, stripped: false },
      { label: 'text', bytes: Buffer.from('hello '), stripped: false },
      {
        label: 'cyrillic-i-grave (UTF-8 trailing 0x9D)',
        bytes: UTF8_TRAILING_0X9D.cyrillicIGrave,
        stripped: false,
      },
      { label: 'osc-title', bytes: OSC_TITLE_CLAUDE, stripped: true },
      { label: 'tail', bytes: Buffer.from(' done\r\n'), stripped: false },
    ]);

    // 在多个不同位置切:包括 UTF-8 字符中间、OSC 序列中间、ESC 之后
    const splitPoints = [3, 7, 10, 14, 20, 25, 30];
    const chunks = splitAt(input, splitPoints);
    const parser = new Osc1337Parser();
    const out = feed(parser, chunks);
    expect(out.equals(expectedPassthrough)).toBe(true);
    expect(parser.stashedBytes).toBe(0);
  });

  it('stash overflow(>16KB 未终止的 OSC)整段透传 — 不静默丢内容', () => {
    // OSC-3 回归修复(2026-05-14):overflow 时改回 passthrough(原 51ab975
    // 静默 drop 的方向是错的)。哪怕是合法的 ESC ] 开头的超长流,也宁可
    // 渲染字面 ANSI 乱码,也别让用户内容凭空消失。
    const parser = new Osc1337Parser();
    const giant = Buffer.concat([
      Buffer.from('\x1b]1337;'),
      Buffer.from('x'.repeat(20_000)),
    ]);
    const r = parser.parse(giant);
    expect(r.passthrough.length).toBeGreaterThanOrEqual(20_000);
    expect(parser.stashedBytes).toBe(0);
  });

  it('passthrough 字节计数恒等于 (输入字节 - 已识别 OSC 字节)', () => {
    // 不变量的"字节守恒"形式,对所有 fixture 都该成立。
    const fixtures = [
      buildFixture([
        { label: 'pure-text', bytes: Buffer.from('hello world\r\n'), stripped: false },
      ]),
      buildFixture([
        { label: 'osc-only', bytes: OSC_TITLE_CLAUDE, stripped: true },
      ]),
      buildFixture([
        { label: 'box-double', bytes: UTF8_TRAILING_0X9D.boxDoubleUpLeft, stripped: false },
        { label: 'arabic', bytes: UTF8_TRAILING_0X9D.arabicGhain, stripped: false },
        { label: 'cyrillic', bytes: UTF8_TRAILING_0X9D.cyrillicIGrave, stripped: false },
      ]),
      buildFixture([
        { label: 'sgr', bytes: SGR_RGB_PINK, stripped: false },
        { label: 'osc-cwd', bytes: OSC_1337_CWD, stripped: true },
        { label: 'box', bytes: UTF8_TRAILING_0X9D.boxDoubleUpLeft, stripped: false },
        { label: 'reset', bytes: SGR_RESET, stripped: false },
      ]),
    ];

    for (const { input, expectedPassthrough } of fixtures) {
      const parser = new Osc1337Parser();
      const out = feed(parser, [input]);
      expect(out.length).toBe(expectedPassthrough.length);
      expect(out.equals(expectedPassthrough)).toBe(true);
    }
  });

  it('SGR + 多种 OSC + 普通文本混合流 → 已识别 OSC 全部剥离,其余透传', () => {
    // 综合场景:vim / less / Claude Code 真实启动序列的简化版本。
    const { input, expectedPassthrough } = buildFixture([
      { label: 'enter-alt-screen', bytes: Buffer.from('\x1b[?1049h'), stripped: false },
      { label: 'clear-screen', bytes: Buffer.from('\x1b[2J'), stripped: false },
      { label: 'home-cursor', bytes: Buffer.from('\x1b[H'), stripped: false },
      { label: 'osc-cwd', bytes: OSC_1337_CWD, stripped: true },
      { label: 'sgr-on', bytes: SGR_RGB_PINK, stripped: false },
      { label: 'box-top-left', bytes: BOX_TOP_LEFT, stripped: false },
      { label: 'box-horiz', bytes: BOX_HORIZ.subarray(), stripped: false },
      { label: 'box-double', bytes: UTF8_TRAILING_0X9D.boxDoubleUpLeft, stripped: false },
      { label: 'box-vert', bytes: BOX_VERT, stripped: false },
      { label: 'sgr-reset', bytes: SGR_RESET, stripped: false },
      { label: 'osc-title', bytes: OSC_TITLE_CLAUDE, stripped: true },
      { label: 'text', bytes: Buffer.from(' running…\r\n'), stripped: false },
      { label: 'leave-alt-screen', bytes: Buffer.from('\x1b[?1049l'), stripped: false },
    ]);
    const parser = new Osc1337Parser();
    const out = feed(parser, [input]);
    expect(out.equals(expectedPassthrough)).toBe(true);
    expect(parser.stashedBytes).toBe(0);
  });
});
