/**
 * @file src/main/sftp-protocol.ts
 * @purpose SFTP 第 3 版线路格式的编解码,以及 ssh 报错的分类。纯逻辑,不碰进程。
 *
 * @关键设计:
 * - 为什么不解析 sftp 命令行程序的输出:Windows 版 sftp.exe 在 stdout 是管道时全缓冲,
 *   进程不退出就读不到任何输出,常驻不了;它还会吞掉 ssh 的报错,只留下
 *   "Connection closed"。这两点都是联调真实程序测出来的。
 * - 走二进制协议同时去掉了命令行带来的问题:路径是长度前缀的字节串,不需要引用和转义,
 *   没有 glob,远端文件名也不可能变成 sftp 的 ! 本机命令。
 *
 * @对应文档章节: 软件定义书.md 14.6
 *
 * @不要在这里做的事:
 * - 不要在这里管请求和响应的对应关系 (那是 sftp-client.ts 的职责)
 *
 * @协议参考: draft-ietf-secsh-filexfer-02 (OpenSSH 实现的版本)
 */
import type { SftpFailure } from '@shared/file-tree';

export const SFTP_VERSION = 3;

export const FXP = {
  INIT: 1,
  VERSION: 2,
  OPEN: 3,
  CLOSE: 4,
  READ: 5,
  OPENDIR: 11,
  READDIR: 12,
  REALPATH: 16,
  STAT: 17,
  STATUS: 101,
  HANDLE: 102,
  DATA: 103,
  NAME: 104,
  ATTRS: 105,
} as const;

export const FX_STATUS = { OK: 0, EOF: 1, NO_SUCH_FILE: 2, PERMISSION_DENIED: 3 } as const;

export const FXF_READ = 1;

const ATTR_SIZE = 0x1;
const ATTR_UIDGID = 0x2;
const ATTR_PERMISSIONS = 0x4;
const ATTR_ACMODTIME = 0x8;
const ATTR_EXTENDED = 0x80000000;

const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;

/**
 * 单个包的上限。READDIR 约几百 KiB,读文件时每块 32 KiB,4 MiB 足够宽松。
 * 超过说明流已经错位,最常见的原因是远端的 .bashrc 往 stdout 打印了内容。
 */
export const MAX_PACKET_BYTES = 4 * 1024 * 1024;

export type SftpEntryType = 'file' | 'dir' | 'link';

export interface SftpAttrs {
  size: number | null;
  permissions: number | null;
  /** 修改时间 (ms)。协议第 3 版只有秒精度;服务器省略 ACMODTIME 时为 null */
  mtimeMs: number | null;
}

export function u32(value: number): Buffer {
  const out = Buffer.alloc(4);
  out.writeUInt32BE(value >>> 0, 0);
  return out;
}

export function u64(value: number): Buffer {
  const out = Buffer.alloc(8);
  out.writeBigUInt64BE(BigInt(value), 0);
  return out;
}

export function str(value: string | Buffer): Buffer {
  const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
  return Buffer.concat([u32(bytes.length), bytes]);
}

/** 拼一个完整的包:长度 + 类型 + 内容。 */
export function encodePacket(type: number, parts: readonly Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  return Buffer.concat([u32(body.length + 1), Buffer.from([type]), body]);
}

/** 顺序读取包内容。越界抛错,调用方把它当协议错误处理。 */
export class SftpReader {
  private offset = 0;

  constructor(private readonly data: Buffer) {}

  private take(length: number): Buffer {
    const end = this.offset + length;
    if (length < 0 || end > this.data.length) {
      throw new Error(`[SftpProtocol] truncated packet: need ${end}, have ${this.data.length}`);
    }
    const slice = this.data.subarray(this.offset, end);
    this.offset = end;
    return slice;
  }

  u32(): number {
    return this.take(4).readUInt32BE(0);
  }

  u64(): number {
    return Number(this.take(8).readBigUInt64BE(0));
  }

  bytes(): Buffer {
    return this.take(this.u32());
  }

  str(): string {
    return this.bytes().toString('utf8');
  }

  attrs(): SftpAttrs {
    const flags = this.u32();
    const size = flags & ATTR_SIZE ? this.u64() : null;
    if (flags & ATTR_UIDGID) this.take(8);
    const permissions = flags & ATTR_PERMISSIONS ? this.u32() : null;
    let mtimeMs: number | null = null;
    if (flags & ATTR_ACMODTIME) {
      this.u32(); // atime,不用
      mtimeMs = this.u32() * 1000;
    }
    if (flags & ATTR_EXTENDED) {
      for (let count = this.u32(); count > 0; count -= 1) {
        this.bytes();
        this.bytes();
      }
    }
    return { size, permissions, mtimeMs };
  }
}

/** 把字节流切成包。TCP 风格的流,一个 chunk 里可能有半个或好几个包。 */
export class SftpFramer {
  private buffered: Buffer = Buffer.alloc(0);

  /**
   * @returns 收齐的包,每个以类型字节开头
   * @throws Error 长度字段不合理,说明流已经错位
   */
  push(chunk: Buffer): Buffer[] {
    this.buffered = this.buffered.length ? Buffer.concat([this.buffered, chunk]) : chunk;
    const packets: Buffer[] = [];
    while (this.buffered.length >= 4) {
      const length = this.buffered.readUInt32BE(0);
      if (length < 1 || length > MAX_PACKET_BYTES) {
        throw new Error(
          `[SftpProtocol] bad packet length ${length}. ` +
            'Possible causes: the remote shell startup file prints to stdout, ' +
            'or the server is not speaking SFTP.',
        );
      }
      if (this.buffered.length < length + 4) break;
      packets.push(this.buffered.subarray(4, length + 4));
      this.buffered = this.buffered.subarray(length + 4);
    }
    return packets;
  }
}

/**
 * 由权限位判断类型。服务器没给权限位,或者给了但不含类型位时,退回 longname 的
 * 第一个字符。
 */
export function entryTypeOf(attrs: SftpAttrs, longname: string): SftpEntryType {
  const kind = (attrs.permissions ?? 0) & S_IFMT;
  if (kind !== 0) {
    if (kind === S_IFDIR) return 'dir';
    return kind === S_IFLNK ? 'link' : 'file';
  }
  if (longname.startsWith('d')) return 'dir';
  return longname.startsWith('l') ? 'link' : 'file';
}

export function isDirectoryAttrs(attrs: SftpAttrs): boolean {
  return attrs.permissions !== null && (attrs.permissions & S_IFMT) === S_IFDIR;
}

/** 服务器没给类型位时按普通文件算,后面还有 %PDF- 文件头这一关。 */
export function isRegularFileAttrs(attrs: SftpAttrs): boolean {
  const kind = (attrs.permissions ?? 0) & S_IFMT;
  return kind === 0 || kind === S_IFREG;
}

/**
 * 根据 ssh 的 stderr 判断连接为什么失败。
 *
 * 文案是 OpenSSH 的固定输出,不随系统语言变化。host key 必须先判断:
 * 同一次失败里也可能带 Permission denied 字样。
 */
export function classifyConnectFailure(stderr: string): SftpFailure {
  const text = stderr.toLowerCase();
  if (text.includes('host key') || text.includes('host identification')) return 'host-key';
  if (text.includes('permission denied') || text.includes('too many authentication')) return 'auth';
  if (text.includes('subsystem request failed')) return 'no-sftp';
  return 'connect';
}
