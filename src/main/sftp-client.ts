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
 * - 登录提示走 askpass 中继(有 AskpassServer 和平台助手时):ssh 以 BatchMode=no 启动,
 *   要密码、Duo 验证码或主机密钥确认时 exec 助手,助手经命名管道把提示交回这里。
 *   askpass-policy 决定:保存的密码自动填一次;用户操作发起的连接弹窗问用户;后台轮询
 *   发起的连接直接断开并记为 login-required,等用户点重试。这样后台进程永远不会凭空弹窗,
 *   也不会因为反复失败登录被服务器封掉。
 * - 没有中继的平台保持原样:BatchMode=yes 立刻失败而不是挂住,保存了密码时用 sshpass。
 *   Windows 上 sshpass 会把 ssh 放到控制台上,破坏二进制的 SFTP 流,所以 Windows 必须走中继。
 *   Windows 的助手是 csc.exe 现编的小 exe,见 platform/askpass-helper-source.ts。
 * - 需要过用户提示才连上的连接不做空闲关闭:每次重连都是一次 Duo 推送。
 *
 * @对应文档章节: 软件定义书.md 14.6、14.9
 *
 * @不要在这里做的事:
 * - 不要提供写入、删除、改名 (远端文件树是只读的,OPEN 只用 FXF_READ)
 * - 不要在轮询路径上传 interactive:true,那会让服务器的提示在用户没操作时弹出来
 *
 * @常见问题排查:
 * - 文件树显示"需要登录" → 后台连接遇到了提示,点重试会以交互方式重连并弹窗
 * - 文件树显示认证失败 → 密码错了,或者服务器拒绝了这种登录方式
 * - 显示主机密钥失败 → 先在终端连一次,接受并保存主机密钥(有中继时会直接弹 yes/no)
 * - 日志有 bad packet length → 远端 .bashrc 往 stdout 打印了内容,破坏了 SFTP 流
 * - 显示连接失败但终端能连 → 看 main.log 里 [Sftp] 那行 ssh 的 stderr
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { ASKPASS_PIPE_ENV, ASKPASS_TOKEN_ENV, type AskpassHelper } from './platform/askpass';
import { classifyPrompt, decideAnswer } from './askpass-policy';
import type { AskpassServer } from './askpass-server';
import type { PromptRequest } from './askpass-prompts';
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
/** 用户回答一条提示之后给 ssh 的时间:Duo 推送要等手机,服务器那边还可能再问一轮。 */
const AUTH_CONTINUE_TIMEOUT_MS = 120_000;
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
  /** 显示给用户的名字,弹登录提示时当标题。ssh_config 条目可能没有 */
  name?: string;
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

/**
 * 组装 ssh 参数。连接选项与 buildSshLaunchParams 保持一致。
 *
 * @param allowPrompts true 表示有人能回答 ssh 的提示(askpass 中继或 sshpass),关掉 BatchMode
 */
export function buildSftpArgs(profile: SftpProfile, allowPrompts: boolean): string[] {
  const hasPassword = profile.authType === 'password' && Boolean(profile.password);
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
    `BatchMode=${allowPrompts ? 'no' : 'yes'}`,
    // A wrong saved password must count as one failure, not three against the account.
    // 没有保存密码时保留默认的 3 次,用户敲错 Duo 验证码还有机会再来。
    ...(allowPrompts && hasPassword ? ['-o', 'NumberOfPasswordPrompts=1'] : []),
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

  /** ssh 到目前为止的 stderr 末尾。登录提示的说明文字(比如 Duo 的菜单)在这里。 */
  get stderrText(): string {
    return this.stderr;
  }

  /** 完成 INIT / VERSION 握手。 */
  handshake(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.handshakeWaiter = { resolve, reject, timer: this.handshakeTimer(CONNECT_TIMEOUT_MS) };
      this.proc.stdin.write(encodePacket(FXP.INIT, [u32(SFTP_VERSION)]));
    });
  }

  /** 正在等用户回答提示:握手计时暂停,否则 Duo 还没推到手机上连接就超时了。 */
  suspendHandshakeTimer(): void {
    if (this.handshakeWaiter) clearTimeout(this.handshakeWaiter.timer);
  }

  /** 提示已回答,重新计时。 */
  resumeHandshakeTimer(ms: number): void {
    if (!this.handshakeWaiter || this.handshaken) return;
    clearTimeout(this.handshakeWaiter.timer);
    this.handshakeWaiter.timer = this.handshakeTimer(ms);
  }

  private handshakeTimer(ms: number): ReturnType<typeof setTimeout> {
    return setTimeout(() => {
      this.fail(new SftpError('connect', `no reply in ${ms}ms`));
    }, ms);
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

  /** 按连接失败结束。登录提示不能回答时 SftpPool 也会调它,在发出凭据前断开。 */
  fail(err: SftpError): void {
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

/** askpass 中继需要的三样东西。没有它时密码登录退回 sshpass。 */
export interface SftpAskpassDeps {
  /** 平台的助手程序,没有则 null */
  helper: () => AskpassHelper | null;
  /** 已 start 的服务器。pipePath 为 null 时不用中继 */
  server: Pick<AskpassServer, 'pipePath' | 'register' | 'unregister'>;
  /** 把提示送到窗口并等答案 */
  promptUser: (request: PromptRequest) => Promise<string | null>;
}

/** 调用方对一次请求的说明。 */
export interface SftpRequestOptions {
  /** 用户主动操作:跳过失败缓存立即重连 */
  fresh?: boolean | undefined;
  /** 用户能看到结果:允许登录时弹提示。轮询不要设置 */
  interactive?: boolean | undefined;
  /** 发起请求的窗口,提示弹在这里 */
  windowId?: string | undefined;
}

export interface SftpPoolDeps {
  /** 返回带明文密码的 profile,不存在时返回 null */
  getProfile: (profileId: string) => SftpProfile | null;
  resolveExecutable: (name: string, env: Record<string, string>) => string | null;
  askpass?: SftpAskpassDeps;
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
  /** 允许弹提示。用户操作发起的请求会把它升级成 true */
  interactive: boolean;
  /** 最近一个交互请求来自哪个窗口 */
  windowId: string | null;
  /** 保存的密码已经自动填过一次 */
  passwordUsed: boolean;
  /** 登录过程中问过用户。这种连接不做空闲关闭 */
  prompted: boolean;
  /** askpass 中继的令牌,连接结束时注销 */
  askpassToken: string | null;
  /** 连接结束时中止还在等用户的提示 */
  abort: AbortController;
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
  async list(
    profileId: string,
    dir: string,
    options: SftpRequestOptions = {},
  ): Promise<ListDirResponse> {
    try {
      const { connection, home } = await this.acquire(profileId, options);
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
   * @param options.maxSize 文件超过这个大小时不读内容,chunk 为空
   * @returns 读到的字节、文件总大小和修改时间
   * @throws SftpError 连接失败
   * @throws SftpPathError 文件不存在或没有权限
   */
  async readChunk(
    profileId: string,
    path: string,
    offset: number,
    length: number,
    options: SftpRequestOptions & { maxSize?: number } = {},
  ): Promise<{ chunk: Buffer; size: number; mtimeMs: number | null }> {
    const { connection, home } = await this.acquire(profileId, options);
    const target = expandHome(path, home);
    const attrs = await connection.stat(target);
    const { size, mtimeMs } = attrs;
    if (size === null) throw new SftpPathError('unknown');
    if (!isRegularFileAttrs(attrs)) throw new SftpPathError('not-found');
    if (offset >= size || (options.maxSize !== undefined && size > options.maxSize)) {
      return { chunk: Buffer.alloc(0), size, mtimeMs };
    }
    return { chunk: await connection.readRange(target, offset, length), size, mtimeMs };
  }

  /**
   * 查普通文件的大小和修改时间,PDF 自动刷新用。
   *
   * @throws SftpError 连接失败
   * @throws SftpPathError 不存在、不是普通文件或没有权限
   */
  async stat(
    profileId: string,
    path: string,
    options: SftpRequestOptions = {},
  ): Promise<{ size: number; mtimeMs: number | null }> {
    const { connection, home } = await this.acquire(profileId, options);
    const attrs = await connection.stat(expandHome(path, home));
    if (attrs.size === null) throw new SftpPathError('unknown');
    if (!isRegularFileAttrs(attrs)) throw new SftpPathError('not-found');
    return { size: attrs.size, mtimeMs: attrs.mtimeMs };
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

  /**
   * 取现有连接,没有就新建。同一 profile 不会并行建两条连接。
   *
   * 用户操作(interactive)会把一条还在握手的后台连接升级成允许弹窗,提示到达时按
   * 升级后的状态处理。
   */
  private async acquire(
    profileId: string,
    options: SftpRequestOptions,
  ): Promise<{ connection: SftpConnection; home: string }> {
    if (options.fresh) this.failures.delete(profileId);
    const profile = this.deps.getProfile(profileId);
    if (!profile) throw new SftpError('connect', `profile not found: ${profileId}`);
    const fingerprint = fingerprintOf(profile);

    let entry = this.entries.get(profileId);
    if (entry && entry.fingerprint !== fingerprint) {
      this.drop(profileId);
      entry = undefined;
    }
    entry ??= this.connect(profileId, profile, fingerprint);
    if (options.interactive) {
      entry.interactive = true;
      if (options.windowId) entry.windowId = options.windowId;
    }
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
    const relay = this.askpassRelay();
    // 没有中继的平台退回 sshpass,只有保存了密码才有意义
    const sshpass = password && !relay ? this.deps.resolveExecutable('sshpass', env) : null;
    const args = buildSftpArgs(profile, relay !== null || sshpass !== null);
    // connection 和 home 在下面马上赋值;先建 entry 是因为提示处理函数要引用它
    const entry = {
      fingerprint,
      idleTimer: null,
      interactive: false,
      windowId: null,
      passwordUsed: false,
      prompted: false,
      askpassToken: null,
      abort: new AbortController(),
    } as PoolEntry;
    // 用户环境里可能有 Git 自带的 SSH_ASKPASS 之类,不能让它接到我们的提示
    delete env['SSH_ASKPASS'];
    delete env['SSH_ASKPASS_REQUIRE'];
    if (relay) {
      entry.askpassToken = relay.server.register((prompt, hint) =>
        this.handlePrompt(profileId, entry, profile, prompt, hint),
      );
      Object.assign(env, relay.helper.env);
      env['SSH_ASKPASS'] = relay.helper.command;
      env['SSH_ASKPASS_REQUIRE'] = 'force';
      env[ASKPASS_PIPE_ENV] = relay.pipePath;
      env[ASKPASS_TOKEN_ENV] = entry.askpassToken;
    }
    if (sshpass) env['SSHPASS'] = password as string;
    logger.info(
      'Sftp',
      `connect: ${profile.username}@${profile.host}:${profile.port} ` +
        `auth=${relay ? 'askpass-relay' : sshpass ? 'sshpass' : 'batch'}`,
    );
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
    entry.connection = connection;
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
    entry.home = home;
    this.entries.set(profileId, entry);
    return entry;
  }

  /** 中继可用的条件:平台有助手,服务器已在监听。 */
  private askpassRelay(): {
    helper: AskpassHelper;
    pipePath: string;
    server: SftpAskpassDeps['server'];
  } | null {
    const askpass = this.deps.askpass;
    if (!askpass) return null;
    const pipePath = askpass.server.pipePath;
    const helper = pipePath ? askpass.helper() : null;
    return helper && pipePath ? { helper, pipePath, server: askpass.server } : null;
  }

  /**
   * ssh 的一条登录提示。决策规则见 askpass-policy.ts。
   *
   * @returns 答案;null 让助手退出 1,ssh 这次登录失败
   */
  private async handlePrompt(
    profileId: string,
    entry: PoolEntry,
    profile: SftpProfile,
    prompt: string,
    hint: string | null,
  ): Promise<string | null> {
    const kind = classifyPrompt(prompt, hint);
    const decision = decideAnswer(kind, {
      savedPassword: profile.authType === 'password' ? profile.password : undefined,
      passwordUsed: entry.passwordUsed,
      interactive: entry.interactive,
    });
    logger.info('Sftp', `prompt from ${profile.host}: kind=${kind} action=${decision.action}`);
    if (decision.action === 'answer') {
      entry.passwordUsed = true;
      return decision.value;
    }
    if (decision.action === 'deny') {
      // 在发出任何凭据之前断开:这不算一次失败登录,但要等用户操作才会再试
      entry.connection.fail(
        new SftpError('login-required', `background connection got prompt "${prompt}"`),
      );
      return null;
    }
    entry.prompted = true;
    // 已经排好的空闲关闭也要撤掉,否则还是会在 5 分钟后断开
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }
    entry.connection.suspendHandshakeTimer();
    const answer = await this.deps.askpass!.promptUser({
      windowId: entry.windowId,
      signal: entry.abort.signal,
      payload: {
        profileId,
        profileName: profile.name ?? `${profile.username}@${profile.host}`,
        host: profile.host,
        username: profile.username,
        kind: decision.input,
        prompt,
        detail: entry.connection.stderrText.trim(),
      },
    });
    if (answer === null) {
      entry.connection.fail(new SftpError('login-required', 'user cancelled the prompt'));
      return null;
    }
    entry.connection.resumeHandshakeTimer(AUTH_CONTINUE_TIMEOUT_MS);
    return answer;
  }

  private remember(profileId: string, fingerprint: string, err: SftpError): SftpError {
    // 这几种不会自己好。no-sftp 虽然不是失败登录,但每次重试都是一次成功登录;
    // login-required 要等用户主动操作,轮询重试只会反复断开
    const permanent = ['auth', 'host-key', 'no-sftp', 'login-required'].includes(err.reason);
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
    // 用户为这条连接回答过 Duo 或密码,关掉它就意味着下次再问一遍
    if (entry.prompted) return;
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
    if (entry.askpassToken) this.deps.askpass?.server.unregister(entry.askpassToken);
    entry.abort.abort();
    entry.connection.close();
  }
}
