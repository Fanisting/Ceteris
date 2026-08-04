/**
 * @file src/main/link/frame-codec.test.ts
 * @purpose 验证 TCP 分帧的正确性,重点是 AGENTS.md 5.6 要求的"会出错"场景:
 *   极端分片、粘包、超长长度前缀、边界值。
 *
 * @为什么这些用例重要:
 * 分帧 bug 的特点是本地开发环境几乎测不出来 —— 环回接口通常一次 data 事件
 * 就给到完整帧。只有在真实网络(MTU 分片)或高吞吐(PTY 刷屏时多帧粘连)
 * 下才暴露,而那时表现是"终端偶尔乱码/卡死",极难归因。所以这里用逐字节
 * 投喂来强制走遍所有中间状态。
 */
import { describe, expect, it } from 'vitest';
import { encodeFrame, FrameDecodeError, FrameDecoder } from './frame-codec';
import { LINK_MAX_FRAME_BYTES, LINK_MAX_HANDSHAKE_BYTES } from '@shared/link-protocol';

/** 把若干载荷编码后拼成一段连续字节,模拟粘包。 */
function encodeAll(payloads: Buffer[]): Buffer {
  return Buffer.concat(payloads.map(encodeFrame));
}

describe('encodeFrame', () => {
  it('长度前缀是 uint32 BE,且不含前缀自身', () => {
    const frame = encodeFrame(Buffer.from('hello'));
    expect(frame.length).toBe(4 + 5);
    expect(frame.readUInt32BE(0)).toBe(5);
    expect(frame.subarray(4).toString()).toBe('hello');
  });

  it('空载荷合法(长度 0)', () => {
    const frame = encodeFrame(Buffer.alloc(0));
    expect(frame.length).toBe(4);
    expect(frame.readUInt32BE(0)).toBe(0);
  });

  it('超过 LINK_MAX_FRAME_BYTES 抛错', () => {
    const oversized = Buffer.alloc(LINK_MAX_FRAME_BYTES + 1);
    expect(() => encodeFrame(oversized)).toThrow(/超过上限/);
  });
});

describe('FrameDecoder 基本解码', () => {
  it('一次给到一个完整帧', () => {
    const d = new FrameDecoder();
    const frames = d.push(encodeFrame(Buffer.from('abc')));
    expect(frames).toHaveLength(1);
    expect(frames[0]!.toString()).toBe('abc');
    expect(d.pendingBytes).toBe(0);
  });

  it('粘包:一次给到三个帧,全部解出且保序', () => {
    const d = new FrameDecoder();
    const frames = d.push(
      encodeAll([Buffer.from('one'), Buffer.from('two'), Buffer.from('three')]),
    );
    expect(frames.map((f) => f.toString())).toEqual(['one', 'two', 'three']);
    expect(d.pendingBytes).toBe(0);
  });

  it('空载荷帧能被解出(不会被当成"没有帧")', () => {
    const d = new FrameDecoder();
    const frames = d.push(encodeAll([Buffer.alloc(0), Buffer.from('x')]));
    expect(frames).toHaveLength(2);
    expect(frames[0]!.length).toBe(0);
    expect(frames[1]!.toString()).toBe('x');
  });
});

describe('FrameDecoder 分片', () => {
  it('逐字节投喂:只有最后一个字节到达时才吐出帧', () => {
    const d = new FrameDecoder();
    const wire = encodeFrame(Buffer.from('payload'));
    const collected: Buffer[] = [];
    for (let i = 0; i < wire.length; i++) {
      collected.push(...d.push(wire.subarray(i, i + 1)));
    }
    expect(collected).toHaveLength(1);
    expect(collected[0]!.toString()).toBe('payload');
  });

  it('长度前缀被切成两半也能正确重组', () => {
    const d = new FrameDecoder();
    const wire = encodeFrame(Buffer.from('split-prefix'));
    expect(d.push(wire.subarray(0, 2))).toHaveLength(0);
    expect(d.push(wire.subarray(2, 6))).toHaveLength(0);
    const frames = d.push(wire.subarray(6));
    expect(frames).toHaveLength(1);
    expect(frames[0]!.toString()).toBe('split-prefix');
  });

  it('多帧被任意切分后,顺序与内容完全保持', () => {
    const payloads = Array.from({ length: 20 }, (_, i) =>
      Buffer.from(`frame-${i}-${'x'.repeat(i * 7)}`),
    );
    const wire = encodeAll(payloads);
    const d = new FrameDecoder();
    const collected: Buffer[] = [];
    // 用一个不整除的步长切,保证切点会落在长度前缀中间、载荷中间等各种位置
    const step = 13;
    for (let i = 0; i < wire.length; i += step) {
      collected.push(...d.push(wire.subarray(i, Math.min(i + step, wire.length))));
    }
    expect(collected.map((f) => f.toString())).toEqual(payloads.map((p) => p.toString()));
    expect(d.pendingBytes).toBe(0);
  });

  it('半个帧留在 buffer 里,pendingBytes 反映残余', () => {
    const d = new FrameDecoder();
    const wire = encodeFrame(Buffer.from('incomplete'));
    d.push(wire.subarray(0, 8));
    expect(d.pendingBytes).toBe(8);
  });
});

describe('FrameDecoder 上限保护', () => {
  it('握手阶段默认上限是 LINK_MAX_HANDSHAKE_BYTES', () => {
    const d = new FrameDecoder();
    const header = Buffer.alloc(4);
    header.writeUInt32BE(LINK_MAX_HANDSHAKE_BYTES + 1, 0);
    expect(() => d.push(header)).toThrow(FrameDecodeError);
  });

  it('恰好等于上限的帧被接受', () => {
    const d = new FrameDecoder();
    const header = Buffer.alloc(4);
    header.writeUInt32BE(LINK_MAX_HANDSHAKE_BYTES, 0);
    // 只喂前缀,不喂载荷:不该抛错,只是没有完整帧
    expect(d.push(header)).toHaveLength(0);
  });

  it('raiseLimit 之后能接受更大的帧', () => {
    const d = new FrameDecoder();
    const big = Buffer.alloc(LINK_MAX_HANDSHAKE_BYTES + 100, 0x41);
    d.raiseLimit();
    const frames = d.push(encodeFrame(big));
    expect(frames).toHaveLength(1);
    expect(frames[0]!.length).toBe(big.length);
  });

  it('误连 HTTP 服务时给出 frame-too-large 而不是静默卡死', () => {
    // "GET " 的 ASCII 是 0x47455420 = 1,196,314,144,远超上限
    const d = new FrameDecoder();
    try {
      d.push(Buffer.from('GET / HTTP/1.1\r\n\r\n'));
      throw new Error('应当抛错但没有');
    } catch (err) {
      expect(err).toBeInstanceOf(FrameDecodeError);
      expect((err as FrameDecodeError).code).toBe('frame-too-large');
    }
  });

  it('抛错后 decoder 不再被信任(调用方应断连),但不会崩溃', () => {
    const d = new FrameDecoder();
    d.raiseLimit();
    const header = Buffer.alloc(4);
    header.writeUInt32BE(LINK_MAX_FRAME_BYTES + 1, 0);
    expect(() => d.push(header)).toThrow(FrameDecodeError);
  });
});

describe('FrameDecoder 与真实负载形态', () => {
  it('base64 编码的 PTY 字节流(典型 evt:session:output)往返无损', () => {
    const ptyBytes = Buffer.from('[32m$ npm test[0m\r\n通过 42 个用例\r\n');
    const message = JSON.stringify({
      type: 'evt',
      channel: 'evt:session:output',
      envelope: { payload: { data: ptyBytes.toString('base64'), seq: 7 } },
    });
    const d = new FrameDecoder();
    d.raiseLimit();
    const frames = d.push(encodeFrame(Buffer.from(message, 'utf8')));
    expect(frames).toHaveLength(1);
    const parsed = JSON.parse(frames[0]!.toString('utf8')) as {
      envelope: { payload: { data: string } };
    };
    expect(Buffer.from(parsed.envelope.payload.data, 'base64').toString()).toBe(
      ptyBytes.toString(),
    );
  });

  it('1 MiB 的 scrollback 响应可以通过(raiseLimit 后)', () => {
    const d = new FrameDecoder();
    d.raiseLimit();
    const payload = Buffer.alloc(1024 * 1024, 0x2e);
    const frames = d.push(encodeFrame(payload));
    expect(frames).toHaveLength(1);
    expect(frames[0]!.length).toBe(payload.length);
  });
});
