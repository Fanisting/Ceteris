/**
 * @file src/main/sftp-protocol.test.ts
 * @purpose 守护 SFTP v3 线路格式:分帧、属性解析、ssh 报错分类。
 */
import { describe, expect, it } from 'vitest';
import {
  classifyConnectFailure,
  encodePacket,
  entryTypeOf,
  FXP,
  isDirectoryAttrs,
  isRegularFileAttrs,
  MAX_PACKET_BYTES,
  SftpFramer,
  SftpReader,
  str,
  u32,
  u64,
} from './sftp-protocol';

describe('编码', () => {
  it('包的长度字段不含自身', () => {
    const packet = encodePacket(FXP.INIT, [u32(3)]);
    expect([...packet]).toEqual([0, 0, 0, 5, 1, 0, 0, 0, 3]);
  });

  it('字符串按 UTF-8 字节计长度,不是字符数', () => {
    expect(str('目录').readUInt32BE(0)).toBe(6);
  });

  it('u64 能表示超过 4 GiB 的偏移', () => {
    expect(new SftpReader(u64(5_000_000_000)).u64()).toBe(5_000_000_000);
  });
});

describe('SftpFramer', () => {
  const packet = encodePacket(FXP.VERSION, [u32(3)]);

  it('一个 chunk 里有多个包', () => {
    const packets = new SftpFramer().push(Buffer.concat([packet, packet]));
    expect(packets).toHaveLength(2);
    expect(packets[0]?.[0]).toBe(FXP.VERSION);
  });

  it('一个包被拆到多个 chunk,逐字节也能拼起来', () => {
    const framer = new SftpFramer();
    const packets = [...packet].flatMap((byte) => framer.push(Buffer.from([byte])));
    expect(packets).toHaveLength(1);
  });

  it('包后面的半个包留到下一次', () => {
    const framer = new SftpFramer();
    expect(framer.push(Buffer.concat([packet, packet.subarray(0, 3)]))).toHaveLength(1);
    expect(framer.push(packet.subarray(3))).toHaveLength(1);
  });

  it('远端 .bashrc 打印的文字被识别成错位,而不是等一个巨大的包', () => {
    expect(() => new SftpFramer().push(Buffer.from('Welcome to my server\n'))).toThrow(
      /bad packet length/,
    );
  });

  it('拒绝超限和零长度', () => {
    expect(() => new SftpFramer().push(u32(MAX_PACKET_BYTES + 1))).toThrow();
    expect(() => new SftpFramer().push(u32(0))).toThrow();
  });
});

describe('SftpReader', () => {
  it('解析带全部可选字段的属性', () => {
    const attrs = Buffer.concat([
      u32(0x1 | 0x2 | 0x4 | 0x8 | 0x80000000),
      u64(1234),
      u32(1000),
      u32(1000),
      u32(0o100644),
      u32(1),
      u32(2),
      u32(1),
      str('ext'),
      str('value'),
    ]);
    const reader = new SftpReader(Buffer.concat([attrs, u32(99)]));
    // atime=1 mtime=2:mtime 换算成毫秒,atime 丢弃
    expect(reader.attrs()).toEqual({ size: 1234, permissions: 0o100644, mtimeMs: 2000 });
    expect(reader.u32()).toBe(99);
  });

  it('缺字段时返回 null', () => {
    expect(new SftpReader(u32(0)).attrs()).toEqual({
      size: null,
      permissions: null,
      mtimeMs: null,
    });
  });

  it('只有 ACMODTIME 时也能对上后面的字段', () => {
    const reader = new SftpReader(Buffer.concat([u32(0x8), u32(7), u32(1_700_000_000), u32(5)]));
    expect(reader.attrs()).toEqual({ size: null, permissions: null, mtimeMs: 1_700_000_000_000 });
    expect(reader.u32()).toBe(5);
  });

  it('截断的包抛错,不返回半截数据', () => {
    expect(() => new SftpReader(u32(100)).str()).toThrow(/truncated/);
  });
});

describe('类型判断', () => {
  const attrs = (permissions: number | null) => ({ size: null, permissions, mtimeMs: null });

  it('按权限位判断', () => {
    expect(entryTypeOf(attrs(0o040755), '')).toBe('dir');
    expect(entryTypeOf(attrs(0o120777), '')).toBe('link');
    expect(entryTypeOf(attrs(0o100644), '')).toBe('file');
  });

  it('没有权限位时看 longname', () => {
    expect(entryTypeOf(attrs(null), 'drwxr-xr-x 2 a b')).toBe('dir');
    expect(entryTypeOf(attrs(null), 'lrwxrwxrwx 2 a b')).toBe('link');
    expect(entryTypeOf(attrs(null), '-rw-r--r-- 2 a b')).toBe('file');
  });

  it('权限位不含类型位时也看 longname', () => {
    expect(entryTypeOf(attrs(0o755), 'drwxr-xr-x 2 a b')).toBe('dir');
  });

  it('isRegularFileAttrs', () => {
    expect(isRegularFileAttrs(attrs(0o100644))).toBe(true);
    expect(isRegularFileAttrs(attrs(0o040755))).toBe(false);
    expect(isRegularFileAttrs(attrs(0o010644))).toBe(false);
    expect(isRegularFileAttrs(attrs(null))).toBe(true);
  });

  it('isDirectoryAttrs', () => {
    expect(isDirectoryAttrs(attrs(0o040755))).toBe(true);
    expect(isDirectoryAttrs(attrs(0o100644))).toBe(false);
    expect(isDirectoryAttrs(attrs(null))).toBe(false);
  });
});

describe('classifyConnectFailure', () => {
  it.each([
    ['xuhang@h: Permission denied (publickey).', 'auth'],
    ['Host key verification failed.', 'host-key'],
    ['WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! Permission denied', 'host-key'],
    ['subsystem request failed on channel 0', 'no-sftp'],
    ['ssh: connect to host h port 22: Connection refused', 'connect'],
    ['', 'connect'],
  ])('%s', (stderr, expected) => {
    expect(classifyConnectFailure(stderr)).toBe(expected);
  });
});
