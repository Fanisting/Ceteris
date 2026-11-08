/**
 * @file src/main/dev-debug-port.test.ts
 * @purpose devDebugPort: any free port by default, an override, turning it off, and bad
 *   values. parseDevToolsActivePort: reading back the port Chromium opened.
 */
import { describe, expect, it } from 'vitest';
import { devDebugPort, parseDevToolsActivePort } from './dev-debug-port';

describe('devDebugPort', () => {
  it('没有设置时让 Chromium 挑任意空闲端口,几个 dev 副本不会抢同一个', () => {
    expect(devDebugPort({})).toBe(0);
  });

  it('CETERIS_DEV_DEBUG_PORT 指定固定端口', () => {
    expect(devDebugPort({ CETERIS_DEV_DEBUG_PORT: ' 9333 ' })).toBe(9333);
  });

  it('off 时不开端口', () => {
    expect(devDebugPort({ CETERIS_DEV_DEBUG_PORT: 'OFF' })).toBeNull();
  });

  it.each(['abc', '80', '70000', '9222.5'])('"%s" 不是可用端口,报错而不是悄悄换端口', (raw) => {
    expect(() => devDebugPort({ CETERIS_DEV_DEBUG_PORT: raw })).toThrow(/1024 to 65535/);
  });
});

describe('parseDevToolsActivePort', () => {
  it('第一行是端口,第二行是浏览器 target 路径', () => {
    expect(parseDevToolsActivePort('53917\r\n/devtools/browser/abc\r\n')).toBe(53917);
  });

  it.each(['', '\n/devtools/browser/abc', 'port\n', '0\n', '70000\n'])(
    '内容 %j 不是可用端口时返回 null',
    (text) => {
      expect(parseDevToolsActivePort(text)).toBeNull();
    },
  );
});
