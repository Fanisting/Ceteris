/**
 * @file src/main/logger.ts
 * @purpose 主进程持久化日志 (M1-D) — 无新依赖,纯 Node fs。
 *
 *   写入 `%APPDATA%/Ceteris/logs/<channel>-YYYY-MM-DD.log`,按日切;同时镜像到
 *   console (dev / 启动期诊断)。
 *
 *   两个 channel:
 *   - `main` — 通用主进程日志,info/warn/error 走这里,**会** mirror console
 *   - `llm`  — LLM 排障日志(prompt / raw response / verdict 等),独立文件,
 *     **不** mirror console(单条 tail+raw res 几 KB,刷屏 dev 控制台无价值)
 *
 *   分通道动机(2026-05-16):AI 状态复核每次约 2-3KB,5MB main 日志撑不到 1k 次
 *   就被 BETA-031 设置变更、IPC 调用等普通条目挤出去,排"为什么某次判 idle"
 *   要翻好几个 .N.log 文件才能凑齐 prompt+res。拆开后:main 看应用主线;
 *   llm 看 AI 全量,各 5MB×7 天容量独立,互不干扰。
 *
 *   尊重 settings.advanced.logLevel:
 *   - 'INFO' (默认):info / warn / error 落盘
 *   - 'DEBUG':debug / info / warn / error 全落盘
 *
 *   超过 5MB 强制按日内序号切;保留最近 7 天文件,启动时清理。
 *
 *   AGENTS.md 9.1:测试**不许**用真实数据目录 — 暴露 `_resetForTest()` 让单测
 *   注入 tmp 目录;在 setLogDir 之前所有调用先缓存到内存,setLogDir 后 flush。
 */
import { promises as fs, createWriteStream, type WriteStream } from 'node:fs';
import { join } from 'node:path';

type Level = 'debug' | 'info' | 'warn' | 'error';
type Channel = 'main' | 'llm' | 'ime';

const LEVEL_ORDER: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

interface PendingEntry {
  level: Level;
  module: string;
  message: string;
  ts: number;
  extra: unknown[];
}

interface ChannelState {
  filePrefix: string;
  stream: WriteStream | null;
  currentDate: string;
  currentSerial: number;
  writtenBytes: number;
  /** setLogDir 之前的日志先存内存,绑定后 flush */
  pending: PendingEntry[];
}

let logDir: string | null = null;
let minLevel: Level = 'info';
const LOG_FILE_SIZE_LIMIT = 5 * 1024 * 1024; // 5 MB
const LOG_FILE_KEEP_DAYS = 7;
const PENDING_LIMIT = 500;

function makeChannelState(filePrefix: string): ChannelState {
  return {
    filePrefix,
    stream: null,
    currentDate: '',
    currentSerial: 0,
    writtenBytes: 0,
    pending: [],
  };
}

const channels: Record<Channel, ChannelState> = {
  main: makeChannelState('main'),
  llm: makeChannelState('llm'),
  ime: makeChannelState('ime'),
};

function todayStr(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function fileName(prefix: string, date: string, serial: number): string {
  return serial === 0 ? `${prefix}-${date}.log` : `${prefix}-${date}.${serial}.log`;
}

async function ensureStream(ch: ChannelState): Promise<void> {
  if (!logDir) return;
  const date = todayStr();
  if (date !== ch.currentDate) {
    ch.stream?.end();
    ch.stream = null;
    ch.currentDate = date;
    ch.currentSerial = 0;
    ch.writtenBytes = 0;
  }
  if (ch.writtenBytes >= LOG_FILE_SIZE_LIMIT && ch.stream) {
    ch.stream.end();
    ch.stream = null;
    ch.currentSerial += 1;
    ch.writtenBytes = 0;
  }
  if (!ch.stream) {
    try {
      await fs.mkdir(logDir, { recursive: true });
    } catch {
      /* ignore */
    }
    const fp = join(logDir, fileName(ch.filePrefix, date, ch.currentSerial));
    try {
      const stat = await fs.stat(fp);
      ch.writtenBytes = stat.size;
    } catch {
      ch.writtenBytes = 0;
    }
    ch.stream = createWriteStream(fp, { flags: 'a', encoding: 'utf8' });
  }
}

function format(entry: PendingEntry): string {
  const iso = new Date(entry.ts).toISOString();
  const head = `${iso} [${entry.level.toUpperCase()}] [${entry.module}] ${entry.message}`;
  if (entry.extra.length === 0) return head + '\n';
  // 简化 extra 序列化:Error → stack;对象 → JSON
  const parts = entry.extra.map((x) => {
    if (x instanceof Error) {
      return `${x.name}: ${x.message}\n${x.stack ?? ''}`;
    }
    if (typeof x === 'object' && x !== null) {
      try {
        return JSON.stringify(x);
      } catch {
        return String(x);
      }
    }
    return String(x);
  });
  return `${head} ${parts.join(' ')}\n`;
}

async function write(
  channel: Channel,
  entry: PendingEntry,
  mirrorConsole: boolean,
): Promise<void> {
  if (LEVEL_ORDER[entry.level] < LEVEL_ORDER[minLevel]) return;
  // console 镜像:main 通道始终 mirror(dev / 启动期诊断需要);
  // llm 通道明确不 mirror(条目过大,会刷屏 dev console)。
  if (mirrorConsole) {
    const text = format(entry).trimEnd();
    const consoleLog =
      entry.level === 'error'
        ? console.error
        : entry.level === 'warn'
          ? console.warn
          : console.log;
    consoleLog(text);
  }

  const ch = channels[channel];
  if (!logDir) {
    if (ch.pending.length < PENDING_LIMIT) ch.pending.push(entry);
    return;
  }
  await ensureStream(ch);
  if (!ch.stream) return;
  const line = format(entry);
  ch.stream.write(line);
  ch.writtenBytes += Buffer.byteLength(line, 'utf8');
}

function log(
  channel: Channel,
  level: Level,
  module: string,
  message: string,
  ...extra: unknown[]
): void {
  // RES-2:write 内部 await ensureStream() 可能因 fs.mkdir 失败抛错
  // (磁盘满 / 权限 / 路径过长)。原先 `void write(...)` 会把 rejected
  // Promise 抛丢,故障静默。这里捕获并直接 console.error,至少 dev /
  // 启动期能看到一条诊断信息。
  const mirrorConsole = channel === 'main';
  void write(
    channel,
    { level, module, message, ts: Date.now(), extra },
    mirrorConsole,
  ).catch((err) => {
    try {
      console.error('[logger] write failed:', err);
    } catch {
      /* ignore — console 也坏了就只能放弃 */
    }
  });
}

export const logger = {
  debug: (module: string, message: string, ...extra: unknown[]): void =>
    log('main', 'debug', module, message, ...extra),
  info: (module: string, message: string, ...extra: unknown[]): void =>
    log('main', 'info', module, message, ...extra),
  warn: (module: string, message: string, ...extra: unknown[]): void =>
    log('main', 'warn', module, message, ...extra),
  error: (module: string, message: string, ...extra: unknown[]): void =>
    log('main', 'error', module, message, ...extra),

  /**
   * LLM 排障日志 — 写 `llm-YYYY-MM-DD.log`,不进主日志,不 mirror console。
   * 永远 info 级(LLM 调用整条 prompt+res 就是排障证据,不分等级)。
   * 用途:AI 状态复核 prompt/raw response/verdict、testConnection 详情等。
   */
  llm: (module: string, message: string, ...extra: unknown[]): void =>
    log('llm', 'info', module, message, ...extra),

  /**
   * IME-1 探针 dump — 写 `ime-YYYY-MM-DD.log`,不进主日志,不 mirror console。
   * 永远 info 级(LEAK 报警 + 前置 EV 序列就是排障证据)。
   * 用途:renderer 端 ring buffer 在 onData 触发疑似 LEAK 时通过 IPC 落到这里,
   * 不依赖 DevTools 打开。观察期结束移除探针时,本通道一并退役。
   * 详见 src/shared/ime-probe-ring.ts / docs/issues/ime-1-*.md。
   */
  ime: (module: string, message: string, ...extra: unknown[]): void =>
    log('ime', 'info', module, message, ...extra),

  /** 绑定日志目录;调用之前的日志会缓存到内存,绑定后批量 flush。 */
  async setLogDir(dir: string): Promise<void> {
    logDir = dir;
    // 两个通道都建流并 flush 各自的 pending
    for (const ch of Object.values(channels)) {
      await ensureStream(ch);
      const flushed = ch.pending.splice(0, ch.pending.length);
      for (const e of flushed) {
        if (LEVEL_ORDER[e.level] < LEVEL_ORDER[minLevel]) continue;
        const line = format(e);
        ch.stream?.write(line);
        ch.writtenBytes += Buffer.byteLength(line, 'utf8');
      }
    }
    // 启动时清理 > LOG_FILE_KEEP_DAYS 的旧文件(best effort)
    void this.purgeOld().catch(() => {});
  },

  setLevel(level: Level): void {
    minLevel = level;
  },

  async flush(): Promise<void> {
    // RES-1:setImmediate 只是让出一个事件循环 tick,与 fs flush 无关 —
    // WriteStream 内部 buffer 可能还有几行未落盘。这里写一个空字符串并
    // 等 write 的 callback,callback 在 buffer flush 到 OS 后触发。
    // 不 end() stream(否则下次写需要重建)。错误吞掉:flush 在 quit
    // 路径调用,即便落盘失败也不能阻塞退出。
    await Promise.all(
      Object.values(channels).map((ch) => {
        const s = ch.stream;
        if (!s) return Promise.resolve();
        return new Promise<void>((resolve) => {
          try {
            s.write('', () => resolve());
          } catch {
            resolve();
          }
        });
      }),
    );
  },

  async purgeOld(): Promise<void> {
    if (!logDir) return;
    const cutoff = Date.now() - LOG_FILE_KEEP_DAYS * 24 * 3600 * 1000;
    const prefixes = Object.values(channels).map((c) => c.filePrefix);
    try {
      const entries = await fs.readdir(logDir);
      for (const name of entries) {
        if (!name.endsWith('.log')) continue;
        // 只清理已注册通道的文件,避免误删用户/其它工具丢进来的同名文件
        if (!prefixes.some((p) => name.startsWith(`${p}-`))) continue;
        const fp = join(logDir, name);
        try {
          const st = await fs.stat(fp);
          if (st.mtimeMs < cutoff) {
            await fs.unlink(fp);
          }
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* logDir 不存在等 */
    }
  },

  _resetForTest(): void {
    for (const ch of Object.values(channels)) {
      ch.stream?.end();
      ch.stream = null;
      ch.currentDate = '';
      ch.currentSerial = 0;
      ch.writtenBytes = 0;
      ch.pending.length = 0;
    }
    logDir = null;
    minLevel = 'info';
  },
};
