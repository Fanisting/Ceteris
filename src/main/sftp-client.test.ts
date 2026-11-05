/**
 * @file src/main/sftp-client.test.ts
 * @purpose 用内存里的假 SFTP 服务器测试连接管理与协议交互:失败缓存、重连、并发、
 *   分块读取。不启动真实进程 (AGENTS.md 9.3)。
 */
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildSftpArgs, SftpError, SftpPathError, SftpPool, type SftpProfile } from './sftp-client';
import {
  encodePacket,
  FX_STATUS,
  FXP,
  SftpFramer,
  SftpReader,
  str,
  u32,
  u64,
} from './sftp-protocol';

vi.mock('./logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const PROFILE: SftpProfile = {
  id: 'p1',
  host: 'example.test',
  port: 2222,
  username: 'me',
  authType: 'agent',
};

const DIR = 0o040755;
const FILE = 0o100644;
const LINK = 0o120777;

interface FakeNode {
  mode: number;
  content?: Buffer;
  /** 符号链接的目标路径 */
  target?: string;
}

function attrs(node: FakeNode): Buffer {
  return Buffer.concat([u32(0x1 | 0x4), u64(node.content?.length ?? 0), u32(node.mode)]);
}

/** 内存里的 SFTP 服务器,说真实的二进制协议。 */
class FakeServer extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  requests: number[] = [];
  /** 读文件时每次最多返回多少字节,用来模拟短读 */
  maxRead = Infinity;
  /** 为 true 时 READ 不回复,模拟慢下载 */
  holdReads = false;
  /** 为 true 时 READDIR 一直回 count=0 */
  emptyBatches = false;
  /** 大于 0 时 READ 返回这么多字节,不管请求多少 */
  oversizeRead = 0;
  private readonly framer = new SftpFramer();
  private readonly handles = new Map<string, { path: string; sent: boolean }>();
  private nextHandle = 1;

  constructor(private readonly fsTree: Record<string, FakeNode>) {
    super();
    this.stdin.on('data', (chunk: Buffer) => {
      for (const packet of this.framer.push(chunk)) this.handle(packet);
    });
  }

  kill(): boolean {
    this.killed = true;
    return true;
  }

  private reply(type: number, parts: Buffer[]): void {
    this.stdout.write(encodePacket(type, parts));
  }

  private status(id: number, code: number): void {
    this.reply(FXP.STATUS, [u32(id), u32(code), str('msg'), str('')]);
  }

  private resolve(path: string): FakeNode | undefined {
    const node = this.fsTree[path];
    return node?.target ? this.fsTree[node.target] : node;
  }

  private handle(packet: Buffer): void {
    const type = packet[0] as number;
    const reader = new SftpReader(packet.subarray(1));
    if (type === FXP.INIT) {
      this.reply(FXP.VERSION, [u32(3)]);
      return;
    }
    const id = reader.u32();
    this.requests.push(type);
    if (type === FXP.REALPATH) {
      this.reply(FXP.NAME, [u32(id), u32(1), str('/home/me'), str(''), u32(0)]);
    } else if (type === FXP.STAT) {
      const node = this.resolve(reader.str());
      if (node) this.reply(FXP.ATTRS, [u32(id), attrs(node)]);
      else this.status(id, FX_STATUS.NO_SUCH_FILE);
    } else if (type === FXP.OPENDIR || type === FXP.OPEN) {
      const path = reader.str();
      const node = this.fsTree[path];
      if (!node) {
        this.status(id, FX_STATUS.NO_SUCH_FILE);
      } else if (path === '/denied') {
        this.status(id, FX_STATUS.PERMISSION_DENIED);
      } else {
        const handle = `h${this.nextHandle}`;
        this.nextHandle += 1;
        this.handles.set(handle, { path, sent: false });
        this.reply(FXP.HANDLE, [u32(id), str(handle)]);
      }
    } else if (type === FXP.READDIR) {
      this.readdir(id, reader.str());
    } else if (type === FXP.READ) {
      if (this.holdReads) return;
      const state = this.handles.get(reader.str());
      const offset = reader.u64();
      const length = Math.min(reader.u32(), this.maxRead);
      if (this.oversizeRead > 0) {
        this.reply(FXP.DATA, [u32(id), str(Buffer.alloc(this.oversizeRead))]);
        return;
      }
      const content = this.fsTree[state?.path ?? '']?.content ?? Buffer.alloc(0);
      if (offset >= content.length) this.status(id, FX_STATUS.EOF);
      else this.reply(FXP.DATA, [u32(id), str(content.subarray(offset, offset + length))]);
    } else if (type === FXP.CLOSE) {
      this.status(id, FX_STATUS.OK);
    }
  }

  private readdir(id: number, handle: string): void {
    const state = this.handles.get(handle);
    if (this.emptyBatches) {
      this.reply(FXP.NAME, [u32(id), u32(0)]);
      return;
    }
    if (!state || state.sent) {
      this.status(id, FX_STATUS.EOF);
      return;
    }
    state.sent = true;
    const prefix = state.path === '/' ? '/' : `${state.path}/`;
    const names = Object.keys(this.fsTree).filter(
      (p) => p.startsWith(prefix) && !p.slice(prefix.length).includes('/') && p !== state.path,
    );
    const rows = [
      Buffer.concat([str('.'), str(''), attrs({ mode: DIR })]),
      Buffer.concat([str('..'), str(''), attrs({ mode: DIR })]),
      ...names.map((p) =>
        Buffer.concat([str(p.slice(prefix.length)), str(''), attrs(this.fsTree[p] as FakeNode)]),
      ),
    ];
    this.reply(FXP.NAME, [u32(id), u32(rows.length), ...rows]);
  }
}

const TREE: Record<string, FakeNode> = {
  '/home/me': { mode: DIR },
  '/home/me/src': { mode: DIR },
  '/home/me/目录 a': { mode: DIR },
  '/home/me/普通 文件.txt': { mode: FILE, content: Buffer.from('hello') },
  '/home/me/we[ird]*.pdf': { mode: FILE, content: Buffer.from('%PDF-') },
  '/home/me/linkdir': { mode: LINK, target: '/home/me/src' },
  '/home/me/linkfile': { mode: LINK, target: '/home/me/普通 文件.txt' },
  '/home/me/broken': { mode: LINK, target: '/nope' },
  '/denied': { mode: DIR },
};

function asChild(fake: FakeServer): ChildProcessWithoutNullStreams {
  return fake as unknown as ChildProcessWithoutNullStreams;
}

function createPool(fakes: () => FakeServer, profile: SftpProfile | null = PROFILE) {
  const spawned: Array<{ file: string; args: string[]; env: Record<string, string> }> = [];
  let clock = 1000;
  const pool = new SftpPool({
    getProfile: () => profile,
    resolveExecutable: (name) => (name === 'ssh' ? '/bin/ssh' : null),
    spawnProcess: (file, args, env) => {
      spawned.push({ file, args, env });
      return asChild(fakes());
    },
    now: () => clock,
  });
  return { pool, spawned, advance: (ms: number) => (clock += ms) };
}

/** 没有建立起 sftp 的进程:真实的 ssh 在这种情况下不会回任何包。 */
function silentServer(): FakeServer {
  const fake = new FakeServer({});
  fake.stdin.removeAllListeners('data');
  return fake;
}

function failingServer(stderr: string): FakeServer {
  const fake = silentServer();
  setTimeout(() => {
    fake.stderr.write(stderr);
    setTimeout(() => fake.emit('close', 255), 5);
  }, 1);
  return fake;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('buildSftpArgs', () => {
  it('请求 sftp 子系统,默认 BatchMode=yes', () => {
    const args = buildSftpArgs(PROFILE, false);
    expect(args).toContain('BatchMode=yes');
    expect(args).toContain('-s');
    expect(args.slice(-3)).toEqual(['--', 'me@example.test', 'sftp']);
    expect(args.slice(args.indexOf('-p'), args.indexOf('-p') + 2)).toEqual(['-p', '2222']);
  });

  it('带上密钥和多跳板', () => {
    const args = buildSftpArgs(
      { ...PROFILE, authType: 'keyFile', keyFilePath: '/k', proxyJump: ['a', ' ', 'b'] },
      false,
    );
    expect(args.slice(args.indexOf('-i'), args.indexOf('-i') + 2)).toEqual(['-i', '/k']);
    expect(args.slice(args.indexOf('-J'), args.indexOf('-J') + 2)).toEqual(['-J', 'a,b']);
  });

  it('agent 登录不带 -i', () => {
    expect(buildSftpArgs({ ...PROFILE, keyFilePath: '/k' }, false)).not.toContain('-i');
  });

  it('用 sshpass 时才关 BatchMode', () => {
    expect(buildSftpArgs(PROFILE, true)).toContain('BatchMode=no');
  });
});

describe('SftpPool.list', () => {
  it('展开 ~,文件夹在前,链接按目标类型,断链按文件', async () => {
    const { pool } = createPool(() => new FakeServer(TREE));
    const res = await pool.list('p1', '~');
    pool.shutdown();
    if (!res.ok) throw new Error(res.reason);
    expect(res.path).toBe('/home/me');
    expect(res.truncated).toBe(false);
    const isDirectory = Object.fromEntries(res.entries.map((e) => [e.name, e.isDirectory]));
    expect(isDirectory).toEqual({
      linkdir: true,
      src: true,
      '目录 a': true,
      broken: false,
      linkfile: false,
      'we[ird]*.pdf': false,
      '普通 文件.txt': false,
    });
    const flags = res.entries.map((e) => e.isDirectory);
    expect(flags).toEqual([...flags].sort((a, b) => Number(b) - Number(a)));
    expect(res.entries.find((e) => e.name === '目录 a')?.path).toBe('/home/me/目录 a');
  });

  it('不存在的目录报 not-found', async () => {
    const { pool } = createPool(() => new FakeServer(TREE));
    expect(await pool.list('p1', '/nope')).toEqual({ ok: false, reason: 'not-found' });
    pool.shutdown();
  });

  it('没有权限的目录报 denied', async () => {
    const { pool } = createPool(() => new FakeServer(TREE));
    expect(await pool.list('p1', '/denied')).toEqual({ ok: false, reason: 'denied' });
    pool.shutdown();
  });

  it('多次请求复用同一个进程', async () => {
    const { pool, spawned } = createPool(() => new FakeServer(TREE));
    await Promise.all([pool.list('p1', '~'), pool.list('p1', '/home/me/src')]);
    await pool.list('p1', '~');
    pool.shutdown();
    expect(spawned).toHaveLength(1);
  });

  it('并发请求不串台', async () => {
    const { pool } = createPool(() => new FakeServer(TREE));
    const [home, src] = await Promise.all([pool.list('p1', '~'), pool.list('p1', '/home/me/src')]);
    pool.shutdown();
    expect(home.ok && home.path).toBe('/home/me');
    expect(src.ok && src.entries).toEqual([]);
  });

  it('慢下载不挡住列目录', async () => {
    const fake = new FakeServer(TREE);
    const { pool } = createPool(() => fake);
    await pool.list('p1', '~');
    fake.holdReads = true;
    const download = pool.readChunk('p1', '/home/me/普通 文件.txt', 0, 5).catch(() => null);
    const res = await pool.list('p1', '/home/me/src');
    expect(res.ok).toBe(true);
    pool.shutdown();
    await download;
  });

  it('没有写入类请求:远端文件树是只读的', async () => {
    const fake = new FakeServer(TREE);
    const { pool } = createPool(() => fake);
    await pool.list('p1', '~');
    await pool.readChunk('p1', '/home/me/普通 文件.txt', 0, 5);
    pool.shutdown();
    const readOnly: number[] = [
      FXP.OPEN,
      FXP.CLOSE,
      FXP.READ,
      FXP.OPENDIR,
      FXP.READDIR,
      FXP.REALPATH,
      FXP.STAT,
    ];
    expect(fake.requests.filter((t) => !readOnly.includes(t))).toEqual([]);
  });

  it('profile 不存在时不启动进程', async () => {
    const { pool, spawned } = createPool(() => new FakeServer(TREE), null);
    expect(await pool.list('gone', '~')).toEqual({ ok: false, reason: 'connect' });
    expect(spawned).toHaveLength(0);
  });
});

describe('恶意服务器', () => {
  it('READDIR 回空批次时当作结束,不空转', async () => {
    const fake = new FakeServer(TREE);
    fake.emptyBatches = true;
    const { pool } = createPool(() => fake);
    expect(await pool.list('p1', '~')).toMatchObject({ ok: true, entries: [] });
    pool.shutdown();
    expect(fake.requests.filter((t) => t === FXP.READDIR)).toHaveLength(1);
  });

  it('丢弃空文件名和含路径分隔符的文件名', async () => {
    const { pool } = createPool(
      () =>
        new FakeServer({
          '/home/me': { mode: DIR },
          '/home/me/': { mode: FILE },
          '/home/me/ok.txt': { mode: FILE },
        }),
    );
    const res = await pool.list('p1', '~');
    pool.shutdown();
    expect(res.ok && res.entries.map((e) => e.name)).toEqual(['ok.txt']);
  });

  it('DATA 比请求的多时失败,否则会撑破 Link 的帧上限', async () => {
    const fake = new FakeServer({
      ...TREE,
      '/home/me/a.pdf': { mode: FILE, content: Buffer.alloc(100) },
    });
    fake.oversizeRead = 1_000_000;
    const { pool } = createPool(() => fake);
    await expect(pool.readChunk('p1', '/home/me/a.pdf', 0, 100)).rejects.toBeInstanceOf(
      SftpPathError,
    );
    pool.shutdown();
  });
});

describe('SftpPool.readChunk', () => {
  it('超过 maxSize 时不读内容', async () => {
    const fake = new FakeServer(TREE);
    const { pool } = createPool(() => fake);
    const res = await pool.readChunk('p1', '/home/me/普通 文件.txt', 0, 5, { maxSize: 2 });
    pool.shutdown();
    expect(res).toEqual({ chunk: Buffer.alloc(0), size: 5 });
    expect(fake.requests).not.toContain(FXP.OPEN);
  });

  it('目录不能当文件读', async () => {
    const { pool } = createPool(() => new FakeServer(TREE));
    await expect(pool.readChunk('p1', '/home/me/src', 0, 5)).rejects.toBeInstanceOf(SftpPathError);
    pool.shutdown();
  });

  it('fresh 跳过失败缓存:点击 PDF 是用户操作', async () => {
    const { pool, spawned } = createPool(() => failingServer('Permission denied\n'));
    await pool.list('p1', '~');
    await pool.readChunk('p1', '/x.pdf', 0, 5, { fresh: true }).catch(() => null);
    expect(spawned).toHaveLength(2);
  });

  it('跨多个块读完整内容', async () => {
    const content = Buffer.alloc(100_000);
    content.forEach((_, i) => content.writeUInt8(i % 251, i));
    const fake = new FakeServer({ ...TREE, '/home/me/a.pdf': { mode: FILE, content } });
    const { pool } = createPool(() => fake);
    const res = await pool.readChunk('p1', '/home/me/a.pdf', 0, content.length);
    pool.shutdown();
    expect(res.size).toBe(content.length);
    expect(res.chunk.equals(content)).toBe(true);
  });

  it('服务器短读时不丢字节,也不乱序', async () => {
    const content = Buffer.alloc(100_000);
    content.forEach((_, i) => content.writeUInt8(i % 251, i));
    const fake = new FakeServer({ ...TREE, '/home/me/a.pdf': { mode: FILE, content } });
    fake.maxRead = 10_000;
    const { pool } = createPool(() => fake);
    const res = await pool.readChunk('p1', '/home/me/a.pdf', 0, content.length);
    pool.shutdown();
    expect(res.chunk.equals(content)).toBe(true);
  });

  it('从中间偏移开始读', async () => {
    const { pool } = createPool(() => new FakeServer(TREE));
    const res = await pool.readChunk('p1', '/home/me/普通 文件.txt', 2, 100);
    pool.shutdown();
    expect(res.chunk.toString()).toBe('llo');
  });

  it('偏移在文件末尾时返回空,不发 OPEN', async () => {
    const fake = new FakeServer(TREE);
    const { pool } = createPool(() => fake);
    const res = await pool.readChunk('p1', '/home/me/普通 文件.txt', 5, 100);
    pool.shutdown();
    expect(res.chunk.length).toBe(0);
    expect(fake.requests).not.toContain(FXP.OPEN);
  });

  it('文件不存在时抛路径失败', async () => {
    const { pool } = createPool(() => new FakeServer(TREE));
    await expect(pool.readChunk('p1', '/home/me/no.pdf', 0, 5)).rejects.toBeInstanceOf(
      SftpPathError,
    );
    pool.shutdown();
  });
});

describe('连接失败', () => {
  it('认证失败映射成 auth', async () => {
    const { pool } = createPool(() => failingServer('me@h: Permission denied (publickey).\n'));
    expect(await pool.list('p1', '~')).toEqual({ ok: false, reason: 'auth' });
  });

  it('主机密钥未信任映射成 host-key', async () => {
    const { pool } = createPool(() => failingServer('Host key verification failed.\n'));
    expect(await pool.list('p1', '~')).toEqual({ ok: false, reason: 'host-key' });
  });

  it('认证失败后轮询永远不再登录,否则会触发 fail2ban', async () => {
    const { pool, spawned, advance } = createPool(() => failingServer('Permission denied\n'));
    await pool.list('p1', '~');
    expect(await pool.list('p1', '~')).toEqual({ ok: false, reason: 'auth' });
    advance(24 * 60 * 60_000);
    await pool.list('p1', '~');
    expect(spawned).toHaveLength(1);
  });

  it('sshpass 密码错误 (退出码 5,没有 stderr) 映射成 auth', async () => {
    const spawned: string[] = [];
    const pool = new SftpPool({
      getProfile: () => ({ ...PROFILE, authType: 'password', password: 'x' }),
      resolveExecutable: (name) => `/bin/${name}`,
      spawnProcess: (file) => {
        spawned.push(file);
        const fake = silentServer();
        setTimeout(() => fake.emit('close', 5), 1);
        return asChild(fake);
      },
    });
    expect(await pool.list('p1', '~')).toEqual({ ok: false, reason: 'auth' });
    await pool.list('p1', '~');
    expect(spawned).toHaveLength(1);
  });

  it('sshpass 主机密钥问题 (退出码 6) 映射成 host-key', async () => {
    const pool = new SftpPool({
      getProfile: () => ({ ...PROFILE, authType: 'password', password: 'x' }),
      resolveExecutable: (name) => `/bin/${name}`,
      spawnProcess: () => {
        const fake = silentServer();
        setTimeout(() => fake.emit('close', 6), 1);
        return asChild(fake);
      },
    });
    expect(await pool.list('p1', '~')).toEqual({ ok: false, reason: 'host-key' });
  });

  it('服务器没有 sftp 子系统时不重试,每次重试都是一次成功登录', async () => {
    const { pool, spawned, advance } = createPool(() =>
      failingServer('subsystem request failed on channel 0\n'),
    );
    await pool.list('p1', '~');
    advance(24 * 60 * 60_000);
    await pool.list('p1', '~');
    expect(spawned).toHaveLength(1);
  });

  it('握手前收到 id 为 0 的非 VERSION 包时失败,不挂住', async () => {
    const { pool } = createPool(() => {
      const fake = silentServer();
      setTimeout(() => {
        fake.stdout.write(encodePacket(FXP.STATUS, [u32(0), u32(0), str(''), str('')]));
      }, 1);
      return fake;
    });
    expect(await pool.list('p1', '~')).toEqual({ ok: false, reason: 'connect' });
  });

  it('服务器版本低于 3 时失败', async () => {
    const { pool } = createPool(() => {
      const fake = silentServer();
      setTimeout(() => fake.stdout.write(encodePacket(FXP.VERSION, [u32(2)])), 1);
      return fake;
    });
    expect(await pool.list('p1', '~')).toEqual({ ok: false, reason: 'connect' });
  });

  it('握手之后的掉线是 connect,不被旧的 stderr 误判成认证失败', async () => {
    const fakes: FakeServer[] = [];
    const { pool } = createPool(() => {
      const fake = new FakeServer(TREE);
      fakes.push(fake);
      return fake;
    });
    await pool.list('p1', '~');
    fakes[0]?.stderr.write('Banner: Permission denied to strangers\n');
    await new Promise((resolve) => setTimeout(resolve, 5));
    fakes[0]!.holdReads = true;
    const reading = pool.readChunk('p1', '/home/me/普通 文件.txt', 0, 5);
    await new Promise((resolve) => setTimeout(resolve, 5));
    fakes[0]?.emit('close', 255);
    await expect(reading).rejects.toMatchObject({ reason: 'connect' });
  });

  it('网络失败 30 秒后可重试', async () => {
    const { pool, spawned, advance } = createPool(() => failingServer('Connection refused\n'));
    await pool.list('p1', '~');
    advance(31_000);
    await pool.list('p1', '~');
    expect(spawned).toHaveLength(2);
  });

  it('fresh 跳过缓存:用户主动打开选择框时立即重试', async () => {
    const { pool, spawned } = createPool(() => failingServer('Permission denied\n'));
    await pool.list('p1', '~');
    await pool.list('p1', '~', true);
    expect(spawned).toHaveLength(2);
  });

  it('改了 profile 后立即重试', async () => {
    let profile = PROFILE;
    let spawnCount = 0;
    const pool = new SftpPool({
      getProfile: () => profile,
      resolveExecutable: () => '/bin/ssh',
      spawnProcess: () => {
        spawnCount += 1;
        return asChild(failingServer('Permission denied\n'));
      },
    });
    await pool.list('p1', '~');
    profile = { ...PROFILE, port: 22 };
    await pool.list('p1', '~');
    expect(spawnCount).toBe(2);
  });

  it('找不到 ssh 时报 no-client', async () => {
    const pool = new SftpPool({ getProfile: () => PROFILE, resolveExecutable: () => null });
    expect(await pool.list('p1', '~')).toEqual({ ok: false, reason: 'no-client' });
  });

  it('进程启动失败 (ENOENT) 报 no-client', async () => {
    const { pool } = createPool(() => {
      const fake = silentServer();
      setTimeout(() => fake.emit('error', Object.assign(new Error('x'), { code: 'ENOENT' })), 1);
      return fake;
    });
    expect(await pool.list('p1', '~')).toEqual({ ok: false, reason: 'no-client' });
  });

  it('远端 shell 往 stdout 打印内容时报连接失败,不挂住', async () => {
    const { pool } = createPool(() => {
      const fake = silentServer();
      setTimeout(() => fake.stdout.write('Welcome to my server\n'), 1);
      return fake;
    });
    expect(await pool.list('p1', '~')).toEqual({ ok: false, reason: 'connect' });
  });

  it('连接断开后下一次请求重新连接', async () => {
    const fakes: FakeServer[] = [];
    const { pool, spawned } = createPool(() => {
      const fake = new FakeServer(TREE);
      fakes.push(fake);
      return fake;
    });
    await pool.list('p1', '~');
    fakes[0]?.emit('close', 255);
    const res = await pool.list('p1', '~');
    pool.shutdown();
    expect(res.ok).toBe(true);
    expect(spawned).toHaveLength(2);
  });

  it('shutdown 让进行中的请求失败并结束进程', async () => {
    const fake = new FakeServer(TREE);
    const { pool } = createPool(() => fake);
    await pool.list('p1', '~');
    fake.holdReads = true;
    const reading = pool.readChunk('p1', '/home/me/普通 文件.txt', 0, 5);
    await new Promise((resolve) => setTimeout(resolve, 10));
    pool.shutdown();
    await expect(reading).rejects.toBeInstanceOf(SftpError);
    expect(fake.killed).toBe(true);
  });
});

describe('密码登录', () => {
  it('有 sshpass 时用环境变量传密码,不进命令行', async () => {
    const spawned: Array<{ file: string; args: string[]; env: Record<string, string> }> = [];
    const pool = new SftpPool({
      getProfile: () => ({ ...PROFILE, authType: 'password', password: 'hunter2' }),
      resolveExecutable: (name) => `/bin/${name}`,
      spawnProcess: (file, args, env) => {
        spawned.push({ file, args, env });
        return asChild(new FakeServer(TREE));
      },
    });
    await pool.list('p1', '~');
    pool.shutdown();
    expect(spawned[0]?.file).toBe('/bin/sshpass');
    expect(spawned[0]?.args.slice(0, 2)).toEqual(['-e', '/bin/ssh']);
    expect(spawned[0]?.args.join(' ')).not.toContain('hunter2');
    expect(spawned[0]?.env['SSHPASS']).toBe('hunter2');
  });
});

describe('握手之后失败', () => {
  it('realpath 被拒时移除这条连接,下次重新连接', async () => {
    let refuse = true;
    const spawned: FakeServer[] = [];
    const { pool, advance } = createPool(() => {
      const fake = new FakeServer(TREE);
      if (refuse) {
        // 把 REALPATH 的 NAME 回复换成 STATUS,模拟握手成功但 realpath 被拒
        const original = fake.stdout.write.bind(fake.stdout);
        fake.stdout.write = ((chunk: Buffer) => {
          if (chunk[4] !== FXP.NAME) return original(chunk);
          const id = chunk.readUInt32BE(5);
          return original(
            encodePacket(FXP.STATUS, [u32(id), u32(FX_STATUS.PERMISSION_DENIED), str(''), str('')]),
          );
        }) as typeof fake.stdout.write;
      }
      spawned.push(fake);
      return fake;
    });
    expect(await pool.list('p1', '~')).toEqual({ ok: false, reason: 'denied' });
    refuse = false;
    advance(31_000);
    const res = await pool.list('p1', '~');
    pool.shutdown();
    expect(res.ok).toBe(true);
    expect(spawned).toHaveLength(2);
    expect(spawned[0]?.killed).toBe(true);
  });
});
