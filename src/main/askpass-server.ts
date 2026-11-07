/**
 * @file src/main/askpass-server.ts
 * @purpose main 进程里接收 askpass 助手请求的命名管道服务器。每条 SFTP 连接注册一个令牌和
 *   一个处理函数;助手连上来报令牌和提示,服务器把处理函数的结果回给它。
 *
 * @关键设计:
 * - 整个应用一个服务器,管道名含 pid 和随机数:同机的稳定版和测试版各有自己的管道,
 *   别的进程也猜不到名字。令牌另外再随机,没注册的令牌一律回取消。
 * - 协议见 platform/askpass.ts。一条连接一个请求,处理完就关,助手不会留着。
 * - 处理函数可能等用户很久(Duo 推送),这里不设短超时,由 sftp-client 的握手计时和
 *   PromptBroker 的超时负责;连接本身 10 分钟没结果才强制关,防止泄漏。
 * - 非 Windows 用 tmpdir 下的 unix socket,主要是让 vitest 在 macOS CI 上也能跑。
 *
 * @对应文档章节: 软件定义书.md 14.9
 *
 * @不要在这里做的事:
 * - 不要在这里判断提示的种类或决定答案(那是 askpass-policy.ts 和 sftp-client.ts 的事)
 *
 * @常见问题排查:
 * - 日志 "unknown token" → ssh 进程还活着但连接已被 Ceteris 放弃,属正常;频繁出现则看
 *   sftp-client 是否过早 unregister
 * - 助手一直等不到回复 → 看 main.log 里 [Askpass] 的 handler 是否抛错
 */
import { randomBytes } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ASKPASS_MAX_REQUEST_BYTES,
  decodeAskpassRequest,
  encodeAskpassReply,
  type AskpassReply,
} from './platform/askpass';
import { logger } from './logger';

/** 一条助手连接最长存活时间。正常情况下 PromptBroker 早就超时了。 */
const CONNECTION_DEADLINE_MS = 10 * 60_000;

/**
 * 回答一条提示。返回 null 表示取消,ssh 这次登录失败。
 *
 * @param prompt ssh 的提示文本
 * @param hint SSH_ASKPASS_PROMPT 的值
 */
export type AskpassHandler = (prompt: string, hint: string | null) => Promise<string | null>;

export class AskpassServer {
  private server: Server | null = null;
  private readonly handlers = new Map<string, AskpassHandler>();
  private readonly sockets = new Set<Socket>();
  private path: string | null = null;

  constructor(private readonly platform: NodeJS.Platform = process.platform) {}

  /** 管道路径。start 之前和 stop 之后为 null。 */
  get pipePath(): string | null {
    return this.path;
  }

  /** 开始监听。重复调用返回同一个路径。 */
  async start(): Promise<string> {
    if (this.path) return this.path;
    const id = `${process.pid}-${randomBytes(8).toString('hex')}`;
    const path =
      this.platform === 'win32'
        ? `\\\\.\\pipe\\ceteris-askpass-${id}`
        : join(tmpdir(), `ceteris-askpass-${id}.sock`);
    const server = createServer((socket) => this.serve(socket));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(path, () => {
        server.off('error', reject);
        resolve();
      });
    });
    server.on('error', (err) => logger.error('Askpass', 'server error', err));
    this.server = server;
    this.path = path;
    logger.info('Askpass', `listening on ${path}`);
    return path;
  }

  /**
   * 为一条 ssh 连接登记处理函数。
   *
   * @returns 令牌,放进那条 ssh 的 CETERIS_ASKPASS_TOKEN
   */
  register(handler: AskpassHandler): string {
    const token = randomBytes(16).toString('hex');
    this.handlers.set(token, handler);
    return token;
  }

  /** ssh 连接结束后注销。之后拿这个令牌来的请求一律取消。 */
  unregister(token: string): void {
    this.handlers.delete(token);
  }

  /** 停止监听并断开所有助手。应用退出时调用。 */
  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.path = null;
    this.handlers.clear();
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private serve(socket: Socket): void {
    this.sockets.add(socket);
    socket.setEncoding('utf8');
    let buffered = '';
    let handled = false;
    const deadline = setTimeout(() => socket.destroy(), CONNECTION_DEADLINE_MS);
    deadline.unref?.();
    const finish = (reply: AskpassReply): void => {
      if (socket.destroyed) return;
      socket.end(encodeAskpassReply(reply));
    };
    socket.on('data', (chunk: string) => {
      if (handled) return;
      buffered += chunk;
      if (buffered.length > ASKPASS_MAX_REQUEST_BYTES) {
        handled = true;
        logger.warn('Askpass', 'request too large, cancelling');
        finish({ cancel: true });
        return;
      }
      const newline = buffered.indexOf('\n');
      if (newline < 0) return;
      handled = true;
      void this.handleRequest(buffered.slice(0, newline)).then(finish);
    });
    socket.on('error', (err) => logger.warn('Askpass', 'helper socket error', err));
    socket.on('close', () => {
      clearTimeout(deadline);
      this.sockets.delete(socket);
    });
  }

  private async handleRequest(line: string): Promise<AskpassReply> {
    const request = decodeAskpassRequest(line);
    if (!request) {
      logger.warn('Askpass', 'malformed request, cancelling');
      return { cancel: true };
    }
    const handler = this.handlers.get(request.token);
    if (!handler) {
      logger.warn('Askpass', 'unknown token, cancelling');
      return { cancel: true };
    }
    try {
      const answer = await handler(request.prompt, request.hint);
      return answer === null ? { cancel: true } : { answer };
    } catch (err) {
      logger.error('Askpass', `handler failed for prompt "${request.prompt}"`, err);
      return { cancel: true };
    }
  }
}
