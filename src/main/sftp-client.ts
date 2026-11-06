/**
 * @file src/main/sftp-client.ts
 * @purpose 通过系统 ssh 的 sftp 子系统浏览远端目录、读取文件。每个 SSH profile 一条连接。
 *
 * @关键设计:
 * - 用系统 ssh 而不是 npm 库:ssh_config、agent、ProxyJump、known_hosts 的行为与
 *   终端完全一致,也不增加依赖。协议本身在 sftp-protocol.ts。
 * - 常驻连接:文件树会轮询,每次都握手既慢又吵。请求按 id 对应,可以并发,
 *   所以读大文件时不会挡住列目录。
 * - 连接失败要缓存:没有这层,文件树的轮询会反复登录失败,可能触发服务器的
 *   fail2ban 把用户封掉。认证和主机密钥失败不会自己好,不自动重试,等用户主动操作
 *   (fresh) 或改 profile。网络失败隔一段时间重试。
 * - 服务器不可信:长度、数量、文件名都按恶意输入处理,读超限的数据直接失败,
 *   stderr 只留末尾。
 * - BatchMode=yes:后台进程没有地方输入密码,必须立刻失败而不是挂住。
 *   保存了密码时才关掉。
 * - A saved password goes through SSH_ASKPASS where the platform offers it. On Windows
 *   sshpass runs ssh on a console, which corrupts the binary SFTP stream: the login succeeds
 *   and the connection then drops. Askpass leaves ssh on plain pipes.
 *
 * @对应文档章节: 软件定义书.md 14.6
 *
 * @不要在这里做的事:
 * - 不要提供写入、删除、改名 (远端文件树是只读的,OPEN 只用 FXF_READ)
 *
 * @常见问题排查:
 * - 文件树显示认证失败 → 这个 profile 能否免密登录?密码登录需要 askpass 或 sshpass
 * - 显示主机密钥失败 → 先在终端连一次,接受并保存主机密钥
 * - 日志有 bad packet length → 远端 .bashrc 往 stdout 打印了内容,破坏了 SFTP 流
 * - 显示连接失败但终端能连 → 看 main.log 里 [Sftp] 那行 ssh 的 stderr
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { ASKPASS_PASSWORD_ENV } from './platform/askpass';
import { createHash } from 'node:crypto';
import {
  FILE_TREE_MAX_ENTRIES,
  sortEntries,
  type FileTreeEntry,
  type ListDirResponse,
  type SftpFailure,
} from '@shared/file-tree';
import { expandHome, joinRemotePath } from '@shared/remote-path';
import { logger } from './logger';
import {
  classifyConnectFailure,
  encodePacket,
  entryTypeOf,
  FX_STATUS,
  FXF_READ,
  FXP,
  isDirectoryAttrs,
  isRegularFileAttrs,
  SFTP_VERSION,
  SftpFramer,
  SftpReader,
  str,
  u32,
  u64,
  type SftpAttrs,
  type SftpEntryType,
} from './sftp-protocol';

const CONNECT_TIMEOUT_MS = 20_000;
const REQUEST_TIMEOUT_MS = 30_000;
const IDLE_CLOSE_MS = 5 * 60_000;
const NETWORK_FAILURE_CACHE_MS = 30_000;
/** 恶意服务器可以用不断的扩展数据撑爆 stderr。判断失败原因只需要末尾。 */
const MAX_STDERR_CHARS = 8 * 1024;
/** sshpass 的退出码,它自己不写 stderr,只能靠这个判断。6 未知主机,7 主机密钥变了。 */
const SSHPASS_WRONG_PASSWORD = 5;
const SSHPASS_HOST_KEY_CODES: readonly number[] = [6, 7];
/** 服务器可以每次只回一行,不能让一个目录读上很久。 */
const DIR_READ_DEADLINE_MS = 30_000;
/** 同理,服务器每轮只回 1 字节时读取永远不会触发单个请求的超时。 */
const RANGE_READ_DEADLINE_MS = 120_000;
/** 单个目录最多读多少条。超大目录再多也显示不了,还会占内存。 */
const MAX_DIR_ROWS = 50_000;
/** 单个目录最多解析多少个符号链接,超出的按文件显示。 */
const MAX_LINK_PROBES = 64;
/** OpenSSH 的 sftp 客户端默认也是这个块大小和并发,所有服务器都接受。 */
const READ_BLOCK_BYTES = 32 * 1024;
const READ_PARALLEL = 16;

export interface SftpProfile {
  id: string;
  host: string;
  port: number;
  username: string;
  authType: 'agent' | 'keyFile' | 'password';
  keyFilePath?: string;
  proxyJump?: string[];
  /** 已解密的明文密码,只用于交给 askpass 或 sshpass */
  password?: string;
}

export type SftpPathFailure = 'not-found' | 'denied' | 'unknown';

/** 连接层面的失败。 */
export class SftpError extends Error {
  constructor(
    public readonly reason: SftpFailure,
    detail: string,
  ) {
    super(`[Sftp] ${reason}: ${detail}`);
  }
}

/** 路径层面的失败:连接本身是好的。 */
export class SftpPathError extends Error {
  constructor(public readonly reason: SftpPathFailure) {
    super(`[Sftp] path failure: ${reason}`);
  }
}

/** 把异常换成 renderer 用的失败原因。 */
export function failureFrom(err: unknown, operation: string): SftpFailure | SftpPathFailure {
  if (err instanceof SftpError || err instanceof SftpPathError) return err.reason;
  logger.warn('Sftp', `${operation} failed`, err);
  return 'unknown';
}

/** 组装 ssh 参数。连接选项与 buildSshLaunchParams 保持一致。 */
export function buildSftpArgs(profile: SftpProfile, hasPassword: boolean): string[] {
  const args = [
    '-T',
    '-s',
    '-p',
    String(profile.port),
    '-o',
    'ConnectTimeout=10',
    '-o',
    'ServerAliveInterval=30',
    '-o',
    `BatchMode=${hasPassword ? 'no' : 'yes'}`,
    // A wrong saved password must count as one failure, not three against the account.
    ...(hasPassword ? ['-o', 'NumberOfPasswordPrompts=1'] : []),
  ];
  if (profile.authType === 'keyFile' && profile.keyFilePath) {
    args.push('-i', profile.keyFilePath);
  }
  const hops = (profile.proxyJump ?? []).map((s) => s.trim()).filter((s) => s.length > 0);
  if (hops.length > 0) args.push('-J', hops.join(','));
  // -- 防止以 - 开头的用户名被 ssh 当成选项
  args.push('--', `${profile.username}@${profile.host}`, 'sftp');
  return args;
}

interface Pending {
  resolve: (reply: { type: number; reader: SftpReader }) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface HandshakeWaiter {
  resolve: () => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface SftpDirRow {
  name: string;
  type: SftpEntryType;
}

/** 一条 sftp 连接。进程退出时所有等待中的请求都失败。 */
export class SftpConnection {
  private readonly framer = new SftpFramer();
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private stderr = '';
  private closedReason: SftpError | null = null;
  private handshakeWaiter: HandshakeWaiter | null = null;
  private handshaken = false;
  private closedByUs = false;

  constructor(
    private readonly proc: ChildProcessWithoutNullStreams,
    private readonly onClose: () => void,
    private readonly viaSshpass = false,
  ) {
    proc.stdout.on('data', (chunk: Buffer) => this.handleData(chunk));
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-MAX_STDERR_CHARS);
    });
    proc.stdin.on('error', () => undefined);
    proc.on('error', (err) => {
      const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
      this.fail(new SftpError(missing ? 'no-client' : 'connect', err.message));
    });
    proc.on('close', (code) => {
      this.fail(new SftpError(this.exitReason(code), `exit=${code} stderr=${this.stderr.trim()}`));
    });
  }

  /** 还有请求在进行中。 */
  get busy(): boolean {
    return this.pending.size > 0;
  }

  /** 是 Ceteris 自己关的,不是连接出了问题。 */
  get wasClosedByUs(): boolean {
    return this.closedByUs;
  }

  /** 完成 INIT / VERSION 握手。 */
  handshake(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(new SftpError('connect', `no reply in ${CONNECT_TIMEOUT_MS}ms`));
      }, CONNECT_TIMEOUT_MS);
      this.handshakeWaiter = { resolve, reject, timer };
      this.proc.stdin.write(encodePacket(FXP.INIT, [u32(SFTP_VERSION)]));
    });
  }

  /** 解析路径,. 得到登录目录。 */
  async realpath(path: string): Promise<string> {
    const { type, reader } = await this.request(FXP.REALPATH, [str(path)]);
    expectType(type, FXP.NAME, reader);
    reader.u32();
    return reader.str();
  }

  /** 查询路径属性,跟随符号链接。 */
  async stat(path: string): Promise<SftpAttrs> {
    const { type, reader } = await this.request(FXP.STAT, [str(path)]);
    expectType(type, FXP.ATTRS, reader);
    return reader.attrs();
  }

  /** 读目录,不含 . 和 ..。 */
  async readDirectory(path: string): Promise<SftpDirRow[]> {
    const handle = await this.openHandle(FXP.OPENDIR, [str(path)]);
    const rows: SftpDirRow[] = [];
    const deadline = Date.now() + DIR_READ_DEADLINE_MS;
    try {
      while (rows.length < MAX_DIR_ROWS) {
        if (Date.now() > deadline) throw new SftpPathError('unknown');
        const { type, reader } = await this.request(FXP.READDIR, [str(handle)]);
        if (type === FXP.STATUS && isEof(reader)) break;
        expectType(type, FXP.NAME, reader);
        let count = reader.u32();
        if (count === 0) break;
        for (; count > 0; count -= 1) {
          const name = reader.str();
          const longname = reader.str();
          const attrs = reader.attrs();
          if (isUsableName(name)) rows.push({ name, type: entryTypeOf(attrs, longname) });
        }
      }
    } finally {
      await this.closeHandle(handle);
    }
    return rows;
  }

  /**
   * 读文件的一段。
   *
   * @returns 实际读到的字节,到文件末尾时可能比 length 短
   */
  async readRange(path: string, offset: number, length: number): Promise<Buffer> {
    const handle = await this.openHandle(FXP.OPEN, [str(path), u32(FXF_READ), u32(0)]);
    try {
      return await this.readHandle(handle, offset, length);
    } finally {
      await this.closeHandle(handle);
    }
  }

  /** 结束进程。等待中的请求按连接失败处理。 */
  close(): void {
    if (!this.closedReason) this.closedByUs = true;
    this.fail(new SftpError('connect', 'connection closed'));
  }

  /** 服务器可以返回比请求少的字节,所以每轮只取连续的部分,剩下的下一轮再要。 */
  private async readHandle(handle: Buffer, offset: number, length: number): Promise<Buffer> {
    const parts: Buffer[] = [];
    const end = offset + length;
    const deadline = Date.now() + RANGE_READ_DEADLINE_MS;
    let position = offset;
    while (position < end) {
      if (Date.now() > deadline) throw new SftpPathError('unknown');
      const requests: Array<{ size: number; result: Promise<Buffer> }> = [];
      for (let i = 0; i < READ_PARALLEL; i += 1) {
        const start = position + i * READ_BLOCK_BYTES;
        if (start >= end) break;
        const size = Math.min(READ_BLOCK_BYTES, end - start);
        requests.push({ size, result: this.readBlock(handle, start, size) });
      }
      const blocks = await Promise.all(requests.map((r) => r.result));
      let contiguous = true;
      blocks.forEach((block, i) => {
        if (!contiguous) return;
        parts.push(block);
        position += block.length;
        contiguous = block.length === requests[i]?.size;
      });
      if ((blocks[0]?.length ?? 0) === 0) break;
    }
    return Buffer.concat(parts);
  }

  private async readBlock(handle: Buffer, offset: number, size: number): Promise<Buffer> {
    const { type, reader } = await this.request(FXP.READ, [str(handle), u64(offset), u32(size)]);
    if (type === FXP.STATUS && isEof(reader)) return Buffer.alloc(0);
    expectType(type, FXP.DATA, reader);
    const data = reader.bytes();
    // 比请求多的数据会撑破上层按块大小算好的上限,比如 Link 的单帧限制
    if (data.length > size) throw new SftpPathError('unknown');
    return Buffer.from(data);
  }

  private async openHandle(type: number, parts: readonly Buffer[]): Promise<Buffer> {
    const reply = await this.request(type, parts);
    expectType(reply.type, FXP.HANDLE, reply.reader);
    return Buffer.from(reply.reader.bytes());
  }

  /** 关闭句柄失败不影响已读到的结果,连接断开时 fail 会处理其余请求。 */
  private async closeHandle(handle: Buffer): Promise<void> {
    await this.request(FXP.CLOSE, [str(handle)]).catch(() => undefined);
  }

  private request(
    type: number,
    parts: readonly Buffer[],
  ): Promise<{ type: number; reader: SftpReader }> {
    if (this.closedReason) return Promise.reject(this.closedReason);
    return new Promise((resolve, reject) => {
      const id = this.nextId;
      this.nextId += 1;
      const timer = setTimeout(() => {
        this.fail(new SftpError('connect', `request ${type} timed out`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin.write(encodePacket(type, [u32(id), ...parts]));
    });
  }

  private handleData(chunk: Buffer): void {
    try {
      for (const packet of this.framer.push(chunk)) this.handlePacket(packet);
    } catch (err) {
      this.fail(new SftpError('connect', err instanceof Error ? err.message : String(err)));
    }
  }

  private handlePacket(packet: Buffer): void {
    const type = packet[0] as number;
    const reader = new SftpReader(packet.subarray(1));
    if (!this.handshaken) {
      this.finishHandshake(type, reader);
      return;
    }
    const id = reader.u32();
    const waiting = this.pending.get(id);
    if (!waiting) return;
    this.pending.delete(id);
    clearTimeout(waiting.timer);
    waiting.resolve({ type, reader });
  }

  private finishHandshake(type: number, reader: SftpReader): void {
    const version = type === FXP.VERSION ? reader.u32() : 0;
    if (version < SFTP_VERSION) {
      this.fail(new SftpError('connect', `bad handshake: type=${type} version=${version}`));
      return;
    }
    this.handshaken = true;
    const waiter = this.handshakeWaiter;
    this.handshakeWaiter = null;
    if (waiter) clearTimeout(waiter.timer);
    waiter?.resolve();
  }

  /** 握手之后的断开只是掉线:这时 stderr 里只可能是登录横幅之类的旧内容。 */
  private exitReason(code: number | null): SftpFailure {
    if (this.handshaken) return 'connect';
    if (this.viaSshpass && code === SSHPASS_WRONG_PASSWORD) return 'auth';
    if (this.viaSshpass && code !== null && SSHPASS_HOST_KEY_CODES.includes(code)) {
      return 'host-key';
    }
    return classifyConnectFailure(this.stderr);
  }

  private fail(err: SftpError): void {
    if (this.closedReason) return;
    this.closedReason = err;
    if (this.handshakeWaiter) {
      clearTimeout(this.handshakeWaiter.timer);
      this.handshakeWaiter.reject(err);
      this.handshakeWaiter = null;
    }
    for (const waiting of this.pending.values()) {
      clearTimeout(waiting.timer);
      waiting.reject(err);
    }
    this.pending.clear();
    this.proc.kill();
    this.onClose();
  }
}

/**
 * 过滤远端给的文件名。空名字拼出来的路径等于父目录,展开时会无限递归。
 * 这些名字在正常文件系统里都不存在。
 */
function isUsableName(name: string): boolean {
  return name !== '' && name !== '.' && name !== '..' && !/[/\0]/.test(name);
}

function isEof(reader: SftpReader): boolean {
  const code = reader.u32();
  if (code === FX_STATUS.EOF) return true;
  throw statusError(code);
}

function statusError(code: number): SftpPathError {
  if (code === FX_STATUS.NO_SUCH_FILE) return new SftpPathError('not-found');
  return new SftpPathError(code === FX_STATUS.PERMISSION_DENIED ? 'denied' : 'unknown');
}

function expectType(actual: number, expected: number, reader: SftpReader): void {
  if (actual === expected) return;
  if (actual === FXP.STATUS) throw statusError(reader.u32());
  throw new Error(`[Sftp] unexpected reply type ${actual}, wanted ${expected}`);
}

export interface SftpPoolDeps {
  /** 返回带明文密码的 profile,不存在时返回 null */
  getProfile: (profileId: string) => SftpProfile | null;
  resolveExecutable: (name: string, env: Record<string, string>) => string | null;
  /** Path of a helper for SSH_ASKPASS, or null where the platform has none. */
  prepareAskpass?: () => string | null;
  /** 测试注入点 */
  spawnProcess?: (
    file: string,
    args: string[],
    env: Record<string, string>,
  ) => ChildProcessWithoutNullStreams;
  now?: () => number;
}

interface PoolEntry {
  fingerprint: string;
  connection: SftpConnection;
  /** 握手完成后得到登录目录。失败时 reject */
  home: Promise<string>;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

function defaultSpawn(
  file: string,
  args: string[],
  env: Record<string, string>,
): ChildProcessWithoutNullStreams {
  return spawn(file, args, { env, stdio: 'pipe', windowsHide: true });
}

/** 只用来判断 profile 是否变过。存哈希,明文密码才不会留在长期存活的 Map 里。 */
function fingerprintOf(profile: SftpProfile): string {
  const fields = JSON.stringify([
    profile.host,
    profile.port,
    profile.username,
    profile.authType,
    profile.keyFilePath,
    profile.proxyJump,
    profile.password,
  ]);
  return createHash('sha256').update(fields).digest('hex');
}

/** 管理每个 profile 的 sftp 连接。 */
export class SftpPool {
  private readonly entries = new Map<string, PoolEntry>();
  private readonly failures = new Map<
    string,
    { reason: SftpFailure; until: number; fingerprint: string }
  >();
  private readonly spawnProcess: NonNullable<SftpPoolDeps['spawnProcess']>;
  private readonly now: () => number;

  constructor(private readonly deps: SftpPoolDeps) {
    this.spawnProcess = deps.spawnProcess ?? defaultSpawn;
    this.now = deps.now ?? Date.now;
  }

  /**
   * 列出一层远端目录。
   *
   * @param dir 绝对路径,或以 ~ 开头的路径
   * @param fresh true 表示用户主动操作,跳过失败缓存立即重连
   * @returns 与本地文件树相同的结构,path 是展开 ~ 后的目录
   */
  async list(profileId: string, dir: string, fresh = false): Promise<ListDirResponse> {
    try {
      if (fresh) this.failures.delete(profileId);
      const { connection, home } = await this.acquire(profileId);
      const target = expandHome(dir, home);
      const rows = await connection.readDirectory(target);
      const linkedDirs = await this.resolveLinks(connection, target, rows);
      const entries: FileTreeEntry[] = rows.map((row) => ({
        name: row.name,
        path: joinRemotePath(target, row.name),
        isDirectory: row.type === 'dir' || linkedDirs.has(row.name),
      }));
      const sorted = sortEntries(entries);
      return {
        ok: true,
        path: target,
        entries: sorted.slice(0, FILE_TREE_MAX_ENTRIES),
        truncated: sorted.length > FILE_TREE_MAX_ENTRIES,
      };
    } catch (err) {
      return { ok: false, reason: failureFrom(err, `list "${dir}"`) };
    }
  }

  /**
   * 读远端文件的一段。
   *
   * @param options.fresh 用户主动操作,跳过失败缓存
   * @param options.maxSize 文件超过这个大小时不读内容,chunk 为空
   * @returns 读到的字节和文件总大小
   * @throws SftpError 连接失败
   * @throws SftpPathError 文件不存在或没有权限
   */
  async readChunk(
    profileId: string,
    path: string,
    offset: number,
    length: number,
    options: { fresh?: boolean; maxSize?: number } = {},
  ): Promise<{ chunk: Buffer; size: number }> {
    if (options.fresh) this.failures.delete(profileId);
    const { connection, home } = await this.acquire(profileId);
    const target = expandHome(path, home);
    const attrs = await connection.stat(target);
    const { size } = attrs;
    if (size === null) throw new SftpPathError('unknown');
    if (!isRegularFileAttrs(attrs)) throw new SftpPathError('not-found');
    if (offset >= size || (options.maxSize !== undefined && size > options.maxSize)) {
      return { chunk: Buffer.alloc(0), size };
    }
    return { chunk: await connection.readRange(target, offset, length), size };
  }

  /** 关闭所有连接。应用退出时调用。 */
  shutdown(): void {
    for (const id of [...this.entries.keys()]) this.drop(id);
  }

  /** READDIR 给的是链接本身的属性,要用 STAT 才知道它指向什么。断链按文件显示。 */
  private async resolveLinks(
    connection: SftpConnection,
    target: string,
    rows: readonly SftpDirRow[],
  ): Promise<ReadonlySet<string>> {
    const links = rows.filter((r) => r.type === 'link').slice(0, MAX_LINK_PROBES);
    const results = await Promise.all(
      links.map(async (link) => {
        const attrs = await connection
          .stat(joinRemotePath(target, link.name))
          .catch((err: unknown) => {
            if (err instanceof SftpError) throw err;
            return null;
          });
        return attrs !== null && isDirectoryAttrs(attrs) ? link.name : null;
      }),
    );
    return new Set(results.filter((name): name is string => name !== null));
  }

  /** 取现有连接,没有就新建。同一 profile 不会并行建两条连接。 */
  private async acquire(profileId: string): Promise<{ connection: SftpConnection; home: string }> {
    const profile = this.deps.getProfile(profileId);
    if (!profile) throw new SftpError('connect', `profile not found: ${profileId}`);
    const fingerprint = fingerprintOf(profile);

    let entry = this.entries.get(profileId);
    if (entry && entry.fingerprint !== fingerprint) {
      this.drop(profileId);
      entry = undefined;
    }
    entry ??= this.connect(profileId, profile, fingerprint);
    const home = await entry.home;
    this.touch(entry, profileId);
    return { connection: entry.connection, home };
  }

  private connect(profileId: string, profile: SftpProfile, fingerprint: string): PoolEntry {
    const failure = this.failures.get(profileId);
    if (failure && failure.fingerprint === fingerprint && failure.until > this.now()) {
      throw new SftpError(failure.reason, 'recent failure, not retrying yet');
    }
    this.failures.delete(profileId);

    const env = { ...process.env } as Record<string, string>;
    const ssh = this.deps.resolveExecutable('ssh', env);
    if (!ssh) {
      throw this.remember(profileId, fingerprint, new SftpError('no-client', 'ssh not on PATH'));
    }
    const password = profile.authType === 'password' ? profile.password : undefined;
    const askpass = password ? (this.deps.prepareAskpass?.() ?? null) : null;
    const sshpass = password && !askpass ? this.deps.resolveExecutable('sshpass', env) : null;
    const args = buildSftpArgs(profile, askpass !== null || sshpass !== null);
    if (askpass) {
      env['SSH_ASKPASS'] = askpass;
      env['SSH_ASKPASS_REQUIRE'] = 'force';
      env[ASKPASS_PASSWORD_ENV] = password as string;
    }
    if (sshpass) env['SSHPASS'] = password as string;
    logger.info('Sftp', `connect: ${profile.username}@${profile.host}:${profile.port}`);
    const proc = sshpass
      ? this.spawnProcess(sshpass, ['-e', ssh, ...args], env)
      : this.spawnProcess(ssh, args, env);

    const connection: SftpConnection = new SftpConnection(
      proc,
      () => {
        if (this.entries.get(profileId)?.connection === connection) this.drop(profileId);
      },
      sshpass !== null,
    );
    const home = connection.handshake().then(() => connection.realpath('.'));
    home.catch((err: unknown) => {
      const error = err instanceof SftpError ? err : new SftpError('connect', String(err));
      // 自己关掉的连接 (比如 profile 改了) 不算失败,否则下一次请求会被缓存挡住
      if (!connection.wasClosedByUs) this.remember(profileId, fingerprint, error);
      logger.warn('Sftp', `connect failed: ${profile.host}: ${error.message}`);
      // 进程还活着但 realpath 失败时 onClose 不会触发,这里要主动移除,否则这条
      // 坏连接会一直留在 entries 里,后续请求拿到的都是同一个 rejected promise
      if (this.entries.get(profileId)?.connection === connection) this.drop(profileId);
    });
    const entry: PoolEntry = { fingerprint, connection, home, idleTimer: null };
    this.entries.set(profileId, entry);
    return entry;
  }

  private remember(profileId: string, fingerprint: string, err: SftpError): SftpError {
    // 这三种不会自己好。no-sftp 虽然不是失败登录,但每次重试都是一次成功登录
    const permanent = ['auth', 'host-key', 'no-sftp'].includes(err.reason);
    this.failures.set(profileId, {
      reason: err.reason,
      until: permanent ? Infinity : this.now() + NETWORK_FAILURE_CACHE_MS,
      fingerprint,
    });
    return err;
  }

  private touch(entry: PoolEntry, profileId: string): void {
    if (this.entries.get(profileId) !== entry) return;
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => {
      if (this.entries.get(profileId) !== entry) return;
      if (entry.connection.busy) this.touch(entry, profileId);
      else this.drop(profileId);
    }, IDLE_CLOSE_MS);
    entry.idleTimer.unref?.();
  }

  private drop(profileId: string): void {
    const entry = this.entries.get(profileId);
    if (!entry) return;
    this.entries.delete(profileId);
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.connection.close();
  }
}
