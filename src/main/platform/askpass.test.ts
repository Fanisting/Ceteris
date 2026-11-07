/**
 * @file src/main/platform/askpass.test.ts
 * @purpose askpass 管道消息格式的编解码测试:提示里什么字符都可能有,必须原样往返。
 */
import { describe, expect, it } from 'vitest';
import {
  ASKPASS_MAX_REQUEST_BYTES,
  decodeAskpassReply,
  decodeAskpassRequest,
  encodeAskpassReply,
  encodeAskpassRequest,
} from './askpass';

describe('askpass 请求', () => {
  it('多行、引号、百分号和 & 都原样往返,一行结尾', () => {
    const prompt =
      'Duo two-factor login for me\n\n 1. Duo Push\n"quoted" %PATH% & calc\nPasscode: ';
    const line = encodeAskpassRequest({ v: 1, token: 'abc', prompt, hint: null });
    expect(line.endsWith('\n')).toBe(true);
    expect(line.slice(0, -1)).not.toContain('\n');
    expect(decodeAskpassRequest(line.slice(0, -1))).toEqual({
      v: 1,
      token: 'abc',
      prompt,
      hint: null,
    });
  });

  it('带 hint', () => {
    const line = encodeAskpassRequest({ v: 1, token: 't', prompt: 'ok?', hint: 'confirm' });
    expect(decodeAskpassRequest(line.trim())?.hint).toBe('confirm');
  });

  it('格式不对返回 null', () => {
    expect(decodeAskpassRequest('not json')).toBeNull();
    expect(decodeAskpassRequest('{"v":2,"token":"t","prompt":"p"}')).toBeNull();
    expect(decodeAskpassRequest('{"v":1,"token":"","prompt":"p"}')).toBeNull();
    expect(decodeAskpassRequest('{"v":1,"token":"t"}')).toBeNull();
    expect(decodeAskpassRequest('{"v":1,"token":"t","prompt":"p","hint":5}')).toBeNull();
  });

  it('超长请求拒绝', () => {
    const prompt = 'x'.repeat(ASKPASS_MAX_REQUEST_BYTES);
    const line = encodeAskpassRequest({ v: 1, token: 't', prompt, hint: null });
    expect(decodeAskpassRequest(line.trim())).toBeNull();
  });
});

describe('askpass 回复', () => {
  it('答案往返,包括空串', () => {
    expect(decodeAskpassReply(encodeAskpassReply({ answer: 'hunter2' }).trim())).toEqual({
      answer: 'hunter2',
    });
    expect(decodeAskpassReply(encodeAskpassReply({ answer: '' }).trim())).toEqual({ answer: '' });
  });

  it('取消', () => {
    expect(decodeAskpassReply(encodeAskpassReply({ cancel: true }).trim())).toEqual({
      cancel: true,
    });
  });

  it('格式不对返回 null', () => {
    expect(decodeAskpassReply('{}')).toBeNull();
    expect(decodeAskpassReply('{"answer":1}')).toBeNull();
    expect(decodeAskpassReply('')).toBeNull();
  });
});
