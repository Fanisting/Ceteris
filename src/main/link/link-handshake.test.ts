/**
 * @file src/main/link/link-handshake.test.ts
 * @purpose 在真实 TCP 环回连接上跑一遍完整握手,验证协议层的时序。
 *
 * @为什么单测 link-crypto + frame-codec 还不够:
 * 那两个文件各自被单测覆盖得很好,但它们**接缝处**的时序才是真正容易错的
 * 地方,而且这类 bug 只在真实 socket 上暴露:
 *   - 明文帧与密文帧的切换点必须两端一致(早一帧晚一帧都会解密失败)
 *   - raiseLimit 的调用时机必须两端一致(否则大帧在一端被拒)
 *   - hello / hello-ack 的公钥与 nonce 必须按 client→server 顺序进 HKDF,
 *     两端各自"以为"的顺序若不同,派生出的密钥就不同
 *
 * 这个测试不 import LinkServer / LinkClient(它们依赖 electron),而是用同一批
 * 底层原语手写两端,精确复刻 link-server.ts / link-client.ts 的握手序列。
 * 如果哪天有人改了握手顺序却只改了一边,这里会红。
 */
import { createServer, connect, type Server, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { LINK_PROTOCOL_VERSION, type LinkHello, type LinkHelloAck } from '@shared/link-protocol';
import { encodeFrame, FrameDecoder } from './frame-codec';
import {
  createCipherPair,
  deriveSessionKeys,
  generateEphemeralKeyPair,
  generateHandshakeNonce,
  generateLinkToken,
  type LinkCipherStream,
} from './link-crypto';

let activeServer: Server | null = null;
const activeSockets: Socket[] = [];

afterEach(async () => {
  for (const s of activeSockets) {
    if (!s.destroyed) s.destroy();
  }
  activeSockets.length = 0;
  const server = activeServer;
  activeServer = null;
  if (server) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

/** 一端握手完成后的产物。 */
interface Endpoint {
  socket: Socket;
  decoder: FrameDecoder;
  send: LinkCipherStream;
  recv: LinkCipherStream;
}

/**
 * 起一个只做握手的最小 Host,复刻 link-server.ts 的时序:
 * 收 hello → 派生密钥 → 回 hello-ack → raiseLimit → 之后全是密文。
 */
function startHost(token: string): Promise<{ port: number; ready: Promise<Endpoint> }> {
  return new Promise((resolveStart) => {
    let resolveReady: (e: Endpoint) => void;
    let rejectReady: (e: Error) => void;
    const ready = new Promise<Endpoint>((res, rej) => {
      resolveReady = res;
      rejectReady = rej;
    });

    const server = createServer((socket) => {
      activeSockets.push(socket);
      const decoder = new FrameDecoder();
      const keyPair = generateEphemeralKeyPair();
      const serverNonce = generateHandshakeNonce();
      let established: { send: LinkCipherStream; recv: LinkCipherStream } | null = null;

      // 关键:握手完成后必须把这个监听器摘掉。decoder 是有状态的流式解码器,
      // 若它和后续 readNextMessage 装的监听器同时在跑,同一段 chunk 会被
      // push 两次,解码器内部缓冲随即错位。这个坑在小消息上不会暴露(每次
      // 双份 push 恰好各产出一帧,看起来是对的),只有当一条消息跨多个 TCP
      // 分片时才会炸 —— 正是"本地测不出来、真实网络必炸"的那类 bug。
      const onHandshakeData = (chunk: Buffer): void => {
        let frames: Buffer[];
        try {
          frames = decoder.push(chunk);
        } catch (err) {
          rejectReady(err as Error);
          return;
        }
        for (const frame of frames) {
          if (established) continue;
          const msg = JSON.parse(frame.toString('utf8')) as LinkHello;
          const clientPublicKeyRaw = Buffer.from(msg.clientPublicKey, 'base64');
          const clientNonce = Buffer.from(msg.clientNonce, 'base64');

          const keys = deriveSessionKeys({
            ownPrivateKey: keyPair.privateKey,
            peerPublicKeyRaw: clientPublicKeyRaw,
            clientPublicKeyRaw,
            serverPublicKeyRaw: keyPair.publicKeyRaw,
            clientNonce,
            serverNonce,
            token,
          });
          established = createCipherPair(keys, 'server');

          const ack: LinkHelloAck = {
            type: 'hello-ack',
            linkVersion: LINK_PROTOCOL_VERSION,
            serverPublicKey: keyPair.publicKeyRaw.toString('base64'),
            serverNonce: serverNonce.toString('base64'),
          };
          socket.write(encodeFrame(Buffer.from(JSON.stringify(ack), 'utf8')));
          decoder.raiseLimit();
          socket.off('data', onHandshakeData);
          resolveReady({ socket, decoder, ...established });
        }
      };
      socket.on('data', onHandshakeData);
    });

    server.listen(0, '127.0.0.1', () => {
      activeServer = server;
      const addr = server.address();
      const port = addr && typeof addr === 'object' ? addr.port : 0;
      resolveStart({ port, ready });
    });
  });
}

/**
 * 起一个只做握手的最小 Client,复刻 link-client.ts 的时序:
 * 发 hello → 收 hello-ack → 派生密钥 → raiseLimit → 之后全是密文。
 */
function startClient(port: number, token: string): Promise<Endpoint> {
  return new Promise((resolve, reject) => {
    const keyPair = generateEphemeralKeyPair();
    const clientNonce = generateHandshakeNonce();
    const decoder = new FrameDecoder();
    const socket = connect({ host: '127.0.0.1', port });
    activeSockets.push(socket);

    socket.on('error', reject);
    socket.on('connect', () => {
      const hello: LinkHello = {
        type: 'hello',
        linkVersion: LINK_PROTOCOL_VERSION,
        clientPublicKey: keyPair.publicKeyRaw.toString('base64'),
        clientNonce: clientNonce.toString('base64'),
      };
      socket.write(encodeFrame(Buffer.from(JSON.stringify(hello), 'utf8')));
    });

    // 同 startHost:握手完成即摘掉监听器,避免与 readNextMessage 共用 decoder。
    const onHandshakeData = (chunk: Buffer): void => {
      let frames: Buffer[];
      try {
        frames = decoder.push(chunk);
      } catch (err) {
        reject(err as Error);
        return;
      }
      for (const frame of frames) {
        const msg = JSON.parse(frame.toString('utf8')) as LinkHelloAck;
        const serverPublicKeyRaw = Buffer.from(msg.serverPublicKey, 'base64');
        const keys = deriveSessionKeys({
          ownPrivateKey: keyPair.privateKey,
          peerPublicKeyRaw: serverPublicKeyRaw,
          clientPublicKeyRaw: keyPair.publicKeyRaw,
          serverPublicKeyRaw,
          clientNonce,
          serverNonce: Buffer.from(msg.serverNonce, 'base64'),
          token,
        });
        const pair = createCipherPair(keys, 'client');
        decoder.raiseLimit();
        socket.off('data', onHandshakeData);
        resolve({ socket, decoder, ...pair });
        return;
      }
    };
    socket.on('data', onHandshakeData);
  });
}

/** 从一端读出下一个解密后的消息。 */
function readNextMessage<T>(ep: Endpoint): Promise<T> {
  return new Promise((resolve, reject) => {
    const onData = (chunk: Buffer): void => {
      let frames: Buffer[];
      try {
        frames = ep.decoder.push(chunk);
      } catch (err) {
        ep.socket.off('data', onData);
        reject(err as Error);
        return;
      }
      for (const frame of frames) {
        try {
          const plaintext = ep.recv.decrypt(frame);
          ep.socket.off('data', onData);
          resolve(JSON.parse(plaintext.toString('utf8')) as T);
          return;
        } catch (err) {
          ep.socket.off('data', onData);
          reject(err as Error);
          return;
        }
      }
    };
    ep.socket.on('data', onData);
  });
}

/** 往一端写一个加密消息。 */
function writeMessage(ep: Endpoint, msg: unknown): void {
  ep.socket.write(encodeFrame(ep.send.encrypt(Buffer.from(JSON.stringify(msg), 'utf8'))));
}

describe('Marina Link 握手(真实 TCP)', () => {
  it('token 一致时,双方派生出可互通的会话密钥', async () => {
    const token = generateLinkToken();
    const host = await startHost(token);
    const client = await startClient(host.port, token);
    const server = await host.ready;

    // client → server
    writeMessage(client, { type: 'auth', clientName: 'laptop', ipcProtocolVersion: 1 });
    const authMsg = await readNextMessage<{ type: string; clientName: string }>(server);
    expect(authMsg.type).toBe('auth');
    expect(authMsg.clientName).toBe('laptop');

    // server → client
    writeMessage(server, { type: 'auth-ok', hostName: 'desktop', virtualWindowNumber: 3 });
    const okMsg = await readNextMessage<{ type: string; hostName: string }>(client);
    expect(okMsg.type).toBe('auth-ok');
    expect(okMsg.hostName).toBe('desktop');
  });

  it('token 不一致时,第一个加密帧就解不开(这就是认证)', async () => {
    const host = await startHost('host-token');
    const client = await startClient(host.port, 'client-token-different');
    const server = await host.ready;

    writeMessage(client, { type: 'auth', clientName: 'attacker' });
    await expect(readNextMessage(server)).rejects.toThrow(/帧认证失败/);
  });

  it('握手后可以传超过握手上限的大帧(raiseLimit 两端都生效)', async () => {
    const token = generateLinkToken();
    const host = await startHost(token);
    const client = await startClient(host.port, token);
    const server = await host.ready;

    // 远超 LINK_MAX_HANDSHAKE_BYTES(4 KiB),模拟一次 scrollback 响应
    const bigPayload = 'x'.repeat(200_000);
    writeMessage(client, { type: 'cmd', channel: 'cmd:session:send-input', data: bigPayload });
    const received = await readNextMessage<{ data: string }>(server);
    expect(received.data).toHaveLength(200_000);
  });

  it('连续多条消息保序且全部可解', async () => {
    const token = generateLinkToken();
    const host = await startHost(token);
    const client = await startClient(host.port, token);
    const server = await host.ready;

    for (let i = 0; i < 20; i++) {
      writeMessage(client, { type: 'cmd', id: i });
      const msg = await readNextMessage<{ id: number }>(server);
      expect(msg.id).toBe(i);
    }
  });

  it('两条独立连接派生出不同密钥(前向保密)', async () => {
    const token = generateLinkToken();
    const hostA = await startHost(token);
    const clientA = await startClient(hostA.port, token);
    const serverA = await hostA.ready;

    // A 连接上加密的帧,拿到 B 连接的解密通道里必然失败
    const frameFromA = clientA.send.encrypt(Buffer.from('secret'));
    expect(() => serverA.recv.decrypt(Buffer.from(frameFromA))).not.toThrow();

    const frameFromA2 = clientA.send.encrypt(Buffer.from('secret2'));
    const hostB = await startHost(token);
    const clientB = await startClient(hostB.port, token);
    const serverB = await hostB.ready;
    void clientB;
    expect(() => serverB.recv.decrypt(Buffer.from(frameFromA2))).toThrow(/帧认证失败/);
  });
});
