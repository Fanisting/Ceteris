/**
 * @file src/main/link/link-message-codec.test.ts
 * @purpose ADR-056 Link 消息压缩的编解码规则。
 */
import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { LINK_DEFLATE_MIN_BYTES, LINK_MAX_FRAME_BYTES } from '@shared/link-protocol';
import { decodeLinkMessage, encodeLinkMessage, peerHasFeature } from './link-message-codec';

/** 一条重复很多的大事件(不是终端输出,终端输出单独测)。 */
function bigOutput(): unknown {
  const line = '\x1b[38;5;245m│\x1b[0m some transcript line that repeats a lot\r\n';
  return {
    type: 'evt',
    channel: 'evt:path:changed',
    envelope: { payload: { text: line.repeat(400) } },
  };
}

describe('encodeLinkMessage', () => {
  it('outputs plain JSON when the peer did not declare deflate', () => {
    const out = encodeLinkMessage(bigOutput(), { deflate: false });
    expect(out[0]).toBe('{'.charCodeAt(0));
  });

  it('compresses a large repetitive message and marks it', () => {
    const msg = bigOutput();
    const out = encodeLinkMessage(msg, { deflate: true });
    expect(out[0]).toBe(0x01);
    expect(out.length).toBeLessThan(Buffer.byteLength(JSON.stringify(msg)) / 5);
  });

  it('leaves messages under the minimum size as JSON', () => {
    const msg = { type: 'ping', t: 1 };
    expect(Buffer.byteLength(JSON.stringify(msg))).toBeLessThan(LINK_DEFLATE_MIN_BYTES);
    expect(encodeLinkMessage(msg, { deflate: true })[0]).toBe('{'.charCodeAt(0));
  });

  it('falls back to JSON when deflate does not make it smaller', () => {
    // 随机字节的 hex:够长,但 deflate 后不会比原文小到值得
    const random = Array.from({ length: 2000 }, () =>
      Math.floor(Math.random() * 2 ** 32).toString(36),
    ).join('');
    const out = encodeLinkMessage({ type: 'probe-data', id: 1, data: random }, { deflate: true });
    // 要么压缩了且确实更小,要么退回 JSON;不能出现"标了压缩却更大"
    const json = Buffer.byteLength(JSON.stringify({ type: 'probe-data', id: 1, data: random }));
    if (out[0] === 0x01) expect(out.length).toBeLessThan(json);
    else expect(out.length).toBe(json);
  });
});

describe('decodeLinkMessage', () => {
  it('round-trips both plain and compressed messages', () => {
    const msg = bigOutput();
    expect(decodeLinkMessage(encodeLinkMessage(msg, { deflate: false }))).toEqual(msg);
    expect(decodeLinkMessage(encodeLinkMessage(msg, { deflate: true }))).toEqual(msg);
  });

  it('rejects compressed data that inflates past the frame limit', () => {
    const bomb = Buffer.concat([
      Buffer.from([0x01]),
      deflateRawSync(Buffer.alloc(LINK_MAX_FRAME_BYTES + 1024, 0x20)),
    ]);
    expect(() => decodeLinkMessage(bomb)).toThrow(/解压 Link 消息失败/);
  });

  it('rejects corrupt compressed data', () => {
    expect(() => decodeLinkMessage(Buffer.from([0x01, 0xff, 0x00, 0x13]))).toThrow(
      /解压 Link 消息失败/,
    );
  });
});

describe('terminal output events', () => {
  /** omp 整屏重画的样子:清屏、清回滚,然后整段对话带颜色重来一遍。 */
  function outputEvent(): { type: string; channel: string; envelope: unknown } {
    const ESC = String.fromCharCode(27);
    const screen =
      `${ESC}[2J${ESC}[3J${ESC}[H` +
      Array.from(
        { length: 200 },
        (_, i) =>
          `${ESC}[38;5;245m│${ESC}[0m step ${i}: read file src/part-${(i * 7919) % 1000}.ts 文字\r\n`,
      ).join('');
    return {
      type: 'evt',
      channel: 'evt:session:output',
      envelope: {
        eventId: 'e1',
        timestamp: 1,
        payload: { sessionId: 's1', data: Buffer.from(screen, 'utf8').toString('base64'), seq: 9 },
      },
    };
  }

  it('restores the exact base64 payload after compression', () => {
    const msg = outputEvent();
    expect(decodeLinkMessage(encodeLinkMessage(msg, { deflate: true }))).toEqual(msg);
  });

  it('compresses output better than deflating the base64 directly', () => {
    const msg = outputEvent();
    const viaLatin1 = encodeLinkMessage(msg, { deflate: true }).length;
    const direct = deflateRawSync(Buffer.from(JSON.stringify(msg), 'utf8')).length + 1;
    expect(viaLatin1).toBeLessThan(direct);
  });

  it('compresses the base64 form when the latin1 form would pass the frame limit', () => {
    // 全是 ESC:latin1 JSON 里每个字节变成 6 个字符的转义,6 倍膨胀
    const data = Buffer.alloc(Math.ceil(LINK_MAX_FRAME_BYTES / 5), 27).toString('base64');
    const msg = {
      type: 'evt',
      channel: 'evt:session:output',
      envelope: { payload: { sessionId: 's1', data, seq: 1 } },
    };
    const out = encodeLinkMessage(msg, { deflate: true });
    expect(decodeLinkMessage(out)).toEqual(msg);
  });

  it('does not change the caller object', () => {
    const msg = outputEvent();
    const before = JSON.stringify(msg);
    encodeLinkMessage(msg, { deflate: true });
    expect(JSON.stringify(msg)).toBe(before);
  });
});

describe('peerHasFeature', () => {
  it('is true only for an array that lists the feature', () => {
    expect(peerHasFeature(['deflate', 'probe'], 'deflate')).toBe(true);
    expect(peerHasFeature(['probe'], 'deflate')).toBe(false);
    expect(peerHasFeature(undefined, 'deflate')).toBe(false);
    expect(peerHasFeature('deflate', 'deflate')).toBe(false);
  });
});
