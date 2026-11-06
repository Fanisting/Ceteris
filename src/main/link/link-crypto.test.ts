/**
 * @file src/main/link/link-crypto.test.ts
 * @purpose 验证认证密钥交换与帧加密。这是 Marina Link 唯一的安全边界,
 *   所以测试重点不是 happy path,而是**攻击者应当失败的每一条路径**。
 *
 * @核心断言:
 * 1. 两端 token 相同 → 派生出相同密钥 → 往返成功
 * 2. 两端 token 不同(哪怕差一个字符)→ 解密失败
 * 3. 密文被改一个 bit → 解密失败(GCM 完整性)
 * 4. 帧被重放 / 乱序 → 解密失败(计数器 nonce)
 * 5. 两个方向的密钥不同 → 拿错方向的通道解不开
 * 6. 每条连接的密钥都不同(前向保密的前提)
 */
import { describe, expect, it } from 'vitest';
import {
  createCipherPair,
  deriveSessionKeys,
  generateEphemeralKeyPair,
  generateHandshakeNonce,
  generateLinkToken,
  importRawPublicKey,
  LinkCipherStream,
  timingSafeEqualString,
} from './link-crypto';
import { LINK_TOKEN_BYTES } from '@shared/link-protocol';

/**
 * 翻转 buffer 中某个字节的最低位,模拟传输被篡改。
 *
 * 用 readUInt8/writeUInt8 而不是 `buf[i] ^= 1`:tsconfig 开了
 * noUncheckedIndexedAccess,下标访问的类型是 number | undefined。
 */
function flipBit(buf: Buffer, index: number): void {
  buf.writeUInt8(buf.readUInt8(index) ^ 0x01, index);
}

/**
 * 模拟一次完整握手,返回两端各自的收发通道。
 *
 * clientToken / serverToken 分开传是为了能构造"token 不匹配"的场景。
 */
function performHandshake(clientToken: string, serverToken: string) {
  const clientKp = generateEphemeralKeyPair();
  const serverKp = generateEphemeralKeyPair();
  const clientNonce = generateHandshakeNonce();
  const serverNonce = generateHandshakeNonce();

  const common = {
    clientPublicKeyRaw: clientKp.publicKeyRaw,
    serverPublicKeyRaw: serverKp.publicKeyRaw,
    clientNonce,
    serverNonce,
  };

  const clientKeys = deriveSessionKeys({
    ...common,
    ownPrivateKey: clientKp.privateKey,
    peerPublicKeyRaw: serverKp.publicKeyRaw,
    token: clientToken,
  });
  const serverKeys = deriveSessionKeys({
    ...common,
    ownPrivateKey: serverKp.privateKey,
    peerPublicKeyRaw: clientKp.publicKeyRaw,
    token: serverToken,
  });

  return {
    client: createCipherPair(clientKeys, 'client'),
    server: createCipherPair(serverKeys, 'server'),
    clientKeys,
    serverKeys,
  };
}

describe('generateLinkToken', () => {
  it('产生 base64url(无 + / =),长度对应 32 字节熵', () => {
    const token = generateLinkToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(token, 'base64url').length).toBe(LINK_TOKEN_BYTES);
  });

  it('每次都不同', () => {
    const tokens = new Set(Array.from({ length: 50 }, () => generateLinkToken()));
    expect(tokens.size).toBe(50);
  });
});

describe('X25519 公钥编解码', () => {
  it('生成的 raw 公钥是 32 字节', () => {
    expect(generateEphemeralKeyPair().publicKeyRaw.length).toBe(32);
  });

  it('raw 公钥可被重新导入', () => {
    const kp = generateEphemeralKeyPair();
    expect(() => importRawPublicKey(kp.publicKeyRaw)).not.toThrow();
  });

  it('长度不对的公钥被拒绝(对端不是 Ceteris 或 base64 被截断)', () => {
    expect(() => importRawPublicKey(Buffer.alloc(31))).toThrow(/公钥长度非法/);
    expect(() => importRawPublicKey(Buffer.alloc(33))).toThrow(/公钥长度非法/);
    expect(() => importRawPublicKey(Buffer.alloc(0))).toThrow(/公钥长度非法/);
  });
});

describe('deriveSessionKeys', () => {
  it('token 一致时两端派生出完全相同的双向密钥', () => {
    const token = generateLinkToken();
    const { clientKeys, serverKeys } = performHandshake(token, token);
    expect(clientKeys.clientToServer.equals(serverKeys.clientToServer)).toBe(true);
    expect(clientKeys.serverToClient.equals(serverKeys.serverToClient)).toBe(true);
  });

  it('两个方向的密钥彼此不同(防止 nonce 空间共用)', () => {
    const token = generateLinkToken();
    const { clientKeys } = performHandshake(token, token);
    expect(clientKeys.clientToServer.equals(clientKeys.serverToClient)).toBe(false);
  });

  it('token 不同 → 派生出不同密钥', () => {
    const { clientKeys, serverKeys } = performHandshake('token-aaa', 'token-bbb');
    expect(clientKeys.clientToServer.equals(serverKeys.clientToServer)).toBe(false);
  });

  it('token 只差一个字符也会派生出完全不同的密钥', () => {
    const base = generateLinkToken();
    const tweaked = `${base.slice(0, -1)}${base.endsWith('A') ? 'B' : 'A'}`;
    const { clientKeys, serverKeys } = performHandshake(base, tweaked);
    expect(clientKeys.clientToServer.equals(serverKeys.clientToServer)).toBe(false);
  });

  it('每条连接的密钥都不同(临时密钥 → 前向保密)', () => {
    const token = generateLinkToken();
    const a = performHandshake(token, token);
    const b = performHandshake(token, token);
    expect(a.clientKeys.clientToServer.equals(b.clientKeys.clientToServer)).toBe(false);
  });

  it('空 token 被拒绝', () => {
    const kp = generateEphemeralKeyPair();
    const peer = generateEphemeralKeyPair();
    expect(() =>
      deriveSessionKeys({
        ownPrivateKey: kp.privateKey,
        peerPublicKeyRaw: peer.publicKeyRaw,
        clientPublicKeyRaw: kp.publicKeyRaw,
        serverPublicKeyRaw: peer.publicKeyRaw,
        clientNonce: generateHandshakeNonce(),
        serverNonce: generateHandshakeNonce(),
        token: '',
      }),
    ).toThrow(/token 为空/);
  });

  it('握手随机数不同 → 密钥不同(即使公钥对相同)', () => {
    const token = generateLinkToken();
    const clientKp = generateEphemeralKeyPair();
    const serverKp = generateEphemeralKeyPair();
    const build = (clientNonce: Buffer, serverNonce: Buffer) =>
      deriveSessionKeys({
        ownPrivateKey: clientKp.privateKey,
        peerPublicKeyRaw: serverKp.publicKeyRaw,
        clientPublicKeyRaw: clientKp.publicKeyRaw,
        serverPublicKeyRaw: serverKp.publicKeyRaw,
        clientNonce,
        serverNonce,
        token,
      });
    const k1 = build(generateHandshakeNonce(), generateHandshakeNonce());
    const k2 = build(generateHandshakeNonce(), generateHandshakeNonce());
    expect(k1.clientToServer.equals(k2.clientToServer)).toBe(false);
  });
});

describe('LinkCipherStream 往返', () => {
  it('client 加密的帧能被 server 解开', () => {
    const token = generateLinkToken();
    const { client, server } = performHandshake(token, token);
    const plaintext = Buffer.from(JSON.stringify({ type: 'auth', clientName: 'laptop' }));
    expect(server.recv.decrypt(client.send.encrypt(plaintext)).equals(plaintext)).toBe(true);
  });

  it('server 加密的帧能被 client 解开', () => {
    const token = generateLinkToken();
    const { client, server } = performHandshake(token, token);
    const plaintext = Buffer.from(JSON.stringify({ type: 'auth-ok', hostName: 'desktop' }));
    expect(client.recv.decrypt(server.send.encrypt(plaintext)).equals(plaintext)).toBe(true);
  });

  it('连续多帧按序往返', () => {
    const token = generateLinkToken();
    const { client, server } = performHandshake(token, token);
    for (let i = 0; i < 200; i++) {
      const msg = Buffer.from(`frame-${i}`);
      expect(server.recv.decrypt(client.send.encrypt(msg)).toString()).toBe(`frame-${i}`);
    }
    expect(client.send.frameCount).toBe(200);
    expect(server.recv.frameCount).toBe(200);
  });

  it('空载荷帧也能往返', () => {
    const token = generateLinkToken();
    const { client, server } = performHandshake(token, token);
    expect(server.recv.decrypt(client.send.encrypt(Buffer.alloc(0))).length).toBe(0);
  });

  it('大帧(1 MiB)往返无损', () => {
    const token = generateLinkToken();
    const { client, server } = performHandshake(token, token);
    const big = Buffer.alloc(1024 * 1024, 0x5a);
    expect(server.recv.decrypt(client.send.encrypt(big)).equals(big)).toBe(true);
  });
});

describe('LinkCipherStream 攻击面', () => {
  it('token 不匹配 → 第一个加密帧就解不开(这就是认证机制本身)', () => {
    const { client, server } = performHandshake('right-token', 'wrong-token');
    const frame = client.send.encrypt(Buffer.from('hello'));
    expect(() => server.recv.decrypt(frame)).toThrow(/帧认证失败/);
  });

  it('密文被改一个 bit → 解密失败', () => {
    const token = generateLinkToken();
    const { client, server } = performHandshake(token, token);
    const frame = client.send.encrypt(Buffer.from('tamper-me-please'));
    flipBit(frame, 0);
    expect(() => server.recv.decrypt(frame)).toThrow(/帧认证失败/);
  });

  it('认证标签被改 → 解密失败', () => {
    const token = generateLinkToken();
    const { client, server } = performHandshake(token, token);
    const frame = client.send.encrypt(Buffer.from('tag-tamper'));
    flipBit(frame, frame.length - 1);
    expect(() => server.recv.decrypt(frame)).toThrow(/帧认证失败/);
  });

  it('重放同一帧 → 第二次失败(计数器 nonce)', () => {
    const token = generateLinkToken();
    const { client, server } = performHandshake(token, token);
    const frame = client.send.encrypt(Buffer.from('replay-me'));
    expect(server.recv.decrypt(frame).toString()).toBe('replay-me');
    expect(() => server.recv.decrypt(frame)).toThrow(/帧认证失败/);
  });

  it('乱序投递 → 失败(TCP 保序,乱序意味着有人在中间捣乱)', () => {
    const token = generateLinkToken();
    const { client, server } = performHandshake(token, token);
    const f1 = client.send.encrypt(Buffer.from('first'));
    const f2 = client.send.encrypt(Buffer.from('second'));
    expect(() => server.recv.decrypt(f2)).toThrow(/帧认证失败/);
    // 计数器未推进,按正确顺序仍可继续
    expect(server.recv.decrypt(f1).toString()).toBe('first');
    expect(server.recv.decrypt(f2).toString()).toBe('second');
  });

  it('跳过一帧 → 失败(检测到丢帧)', () => {
    const token = generateLinkToken();
    const { client, server } = performHandshake(token, token);
    client.send.encrypt(Buffer.from('dropped'));
    const f2 = client.send.encrypt(Buffer.from('arrived'));
    expect(() => server.recv.decrypt(f2)).toThrow(/帧认证失败/);
  });

  it('拿错方向的通道解不开(c2s 密文喂给 c2s 解密通道)', () => {
    const token = generateLinkToken();
    const { client, server } = performHandshake(token, token);
    const frame = client.send.encrypt(Buffer.from('wrong-direction'));
    // server.send 是 s2c 方向,不该能解开 c2s 的密文
    expect(() => server.send.decrypt(frame)).toThrow(/帧认证失败/);
  });

  it('比认证标签还短的帧被拒绝', () => {
    const token = generateLinkToken();
    const { server } = performHandshake(token, token);
    expect(() => server.recv.decrypt(Buffer.alloc(8))).toThrow(/小于认证标签长度/);
  });

  it('密文与明文不同(确实加密了,没有明文直传)', () => {
    const token = generateLinkToken();
    const { client } = performHandshake(token, token);
    const plaintext = Buffer.from('this-must-not-appear-on-the-wire');
    const frame = client.send.encrypt(plaintext);
    expect(frame.includes(plaintext)).toBe(false);
  });

  it('相同明文加密两次得到不同密文(nonce 递增)', () => {
    const token = generateLinkToken();
    const { client } = performHandshake(token, token);
    const p = Buffer.from('same-input');
    expect(client.send.encrypt(p).equals(client.send.encrypt(p))).toBe(false);
  });
});

describe('LinkCipherStream 构造校验', () => {
  it('密钥长度不是 32 字节时抛错', () => {
    expect(() => new LinkCipherStream(Buffer.alloc(16), 'c2s')).toThrow(/密钥长度非法/);
  });
});

describe('timingSafeEqualString', () => {
  it('相同字符串返回 true', () => {
    expect(timingSafeEqualString('abc123', 'abc123')).toBe(true);
  });

  it('不同内容返回 false', () => {
    expect(timingSafeEqualString('abc123', 'abc124')).toBe(false);
  });

  it('长度不同返回 false 而不抛错', () => {
    expect(timingSafeEqualString('short', 'much-longer')).toBe(false);
  });

  it('空字符串相等', () => {
    expect(timingSafeEqualString('', '')).toBe(true);
  });

  it('多字节字符正确处理', () => {
    expect(timingSafeEqualString('令牌', '令牌')).toBe(true);
    expect(timingSafeEqualString('令牌', '令排')).toBe(false);
  });
});
