/**
 * @file src/main/askpass-server.test.ts
 * @purpose 用真实的命名管道 / unix socket 测服务器和助手客户端的往返。不启动 ssh。
 */
import { connect, type Socket } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AskpassServer } from './askpass-server';
import {
  ASKPASS_MAX_REQUEST_BYTES,
  decodeAskpassReply,
  encodeAskpassRequest,
  type AskpassReply,
} from './platform/askpass';

vi.mock('./logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const servers: AskpassServer[] = [];

function createServer(): AskpassServer {
  const server = new AskpassServer();
  servers.push(server);
  return server;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.stop()));
});

/**
 * 助手程序的 Node 版:按 askpass.ts 的约定连上管道、发一行、等一行。真正的助手是 C#
 * (askpass-helper-source.ts),这里用同样的步骤验证服务器那一端。
 */
function relayPrompt(
  pipePath: string,
  token: string,
  prompt: string,
  hint: string | null,
): Promise<string | null> {
  return new Promise((resolve) => {
    let buffered = '';
    let done = false;
    const socket: Socket = connect(pipePath);
    const finish = (reply: AskpassReply | null): void => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(reply && 'answer' in reply ? reply.answer : null);
    };
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(encodeAskpassRequest({ v: 1, token, prompt, hint })));
    socket.on('data', (chunk: string) => {
      buffered += chunk;
      const newline = buffered.indexOf('\n');
      if (newline >= 0) finish(decodeAskpassReply(buffered.slice(0, newline)));
    });
    socket.on('error', () => finish(null));
    socket.on('close', () => finish(null));
  });
}

describe('AskpassServer + relayPrompt', () => {
  it('登记的令牌拿到处理函数的答案,提示和 hint 原样送达', async () => {
    const server = createServer();
    const path = await server.start();
    expect(server.pipePath).toBe(path);
    const handler = vi.fn().mockResolvedValue('hunter2');
    const token = server.register(handler);
    const prompt = '(me@hpc) Passcode or option (1-3):\n 1. Duo Push "x" & y';
    expect(await relayPrompt(path, token, prompt, 'confirm')).toBe('hunter2');
    expect(handler).toHaveBeenCalledWith(prompt, 'confirm');
  });

  it('处理函数返回 null 时助手拿到取消', async () => {
    const server = createServer();
    const path = await server.start();
    const token = server.register(async () => null);
    expect(await relayPrompt(path, token, 'p', null)).toBeNull();
  });

  it('没登记的令牌和注销后的令牌都取消', async () => {
    const server = createServer();
    const path = await server.start();
    expect(await relayPrompt(path, 'nope', 'p', null)).toBeNull();
    const token = server.register(async () => 'x');
    server.unregister(token);
    expect(await relayPrompt(path, token, 'p', null)).toBeNull();
  });

  it('处理函数抛错时取消,服务器继续工作', async () => {
    const server = createServer();
    const path = await server.start();
    const bad = server.register(async () => {
      throw new Error('boom');
    });
    expect(await relayPrompt(path, bad, 'p', null)).toBeNull();
    const good = server.register(async () => 'ok');
    expect(await relayPrompt(path, good, 'p', null)).toBe('ok');
  });

  it('格式不对的请求取消', async () => {
    const server = createServer();
    const path = await server.start();
    const reply = await new Promise<string>((resolve) => {
      const socket = connect(path);
      let data = '';
      socket.setEncoding('utf8');
      socket.on('connect', () => socket.write('garbage\n'));
      socket.on('data', (chunk: string) => (data += chunk));
      socket.on('close', () => resolve(data));
    });
    expect(JSON.parse(reply.trim())).toEqual({ cancel: true });
  });

  it('超长请求不等换行就取消,不调处理函数,服务器继续工作', async () => {
    const server = createServer();
    const path = await server.start();
    const handler = vi.fn().mockResolvedValue('x');
    const token = server.register(handler);
    // 提示文本由服务器控制;没有换行的超长请求不能让 main 一直攒着
    const reply = await new Promise<string>((resolve) => {
      const socket = connect(path);
      let data = '';
      socket.setEncoding('utf8');
      socket.on('connect', () => socket.write('x'.repeat(ASKPASS_MAX_REQUEST_BYTES + 1)));
      socket.on('data', (chunk: string) => (data += chunk));
      socket.on('error', () => undefined);
      socket.on('close', () => resolve(data));
    });
    expect(JSON.parse(reply.trim())).toEqual({ cancel: true });
    expect(handler).not.toHaveBeenCalled();
    expect(await relayPrompt(path, token, 'p', null)).toBe('x');
  });

  it('stop 断开还在等答案的助手,答案迟到也不出错', async () => {
    const server = createServer();
    const path = await server.start();
    let release: ((answer: string) => void) | null = null;
    const token = server.register(() => new Promise((resolve) => (release = resolve)));
    const relayed = relayPrompt(path, token, 'p', null);
    await vi.waitFor(() => expect(release).not.toBeNull());
    await server.stop();
    expect(await relayed).toBeNull();
    release!('too late');
    await new Promise((resolve) => setImmediate(resolve));
  });

  it('两次 start 返回同一路径;stop 后连不上', async () => {
    const server = createServer();
    const path = await server.start();
    expect(await server.start()).toBe(path);
    await server.stop();
    expect(server.pipePath).toBeNull();
    expect(await relayPrompt(path, 't', 'p', null)).toBeNull();
  });

  it('并发的两条提示互不串台', async () => {
    const server = createServer();
    const path = await server.start();
    const a = server.register(async (prompt) => `A:${prompt}`);
    const b = server.register(async (prompt) => `B:${prompt}`);
    const [ra, rb] = await Promise.all([
      relayPrompt(path, a, '1', null),
      relayPrompt(path, b, '2', null),
    ]);
    expect(ra).toBe('A:1');
    expect(rb).toBe('B:2');
  });
});
