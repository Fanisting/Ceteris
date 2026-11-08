/**
 * @file src/main/dev-debug-port.test.ts
 * @purpose devDebugPort: the default port, an override, turning it off, and bad values.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_DEV_DEBUG_PORT, devDebugPort } from './dev-debug-port';

describe('devDebugPort', () => {
  it('没有设置时用 9222', () => {
    expect(devDebugPort({})).toBe(DEFAULT_DEV_DEBUG_PORT);
  });

  it('CETERIS_DEV_DEBUG_PORT 指定别的端口', () => {
    expect(devDebugPort({ CETERIS_DEV_DEBUG_PORT: ' 9333 ' })).toBe(9333);
  });

  it('off 时不开端口', () => {
    expect(devDebugPort({ CETERIS_DEV_DEBUG_PORT: 'OFF' })).toBeNull();
  });

  it.each(['abc', '80', '70000', '9222.5'])('"%s" 不是可用端口,报错而不是悄悄用 9222', (raw) => {
    expect(() => devDebugPort({ CETERIS_DEV_DEBUG_PORT: raw })).toThrow(/1024 to 65535/);
  });
});
