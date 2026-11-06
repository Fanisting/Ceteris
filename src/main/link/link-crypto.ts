/**
 * @file src/main/link/link-crypto.ts
 * @purpose Marina Link 的认证密钥交换与帧加密。提供:临时 X25519 密钥对、
 *   把预共享 token 绑进 HKDF 的会话密钥派生、AES-256-GCM 的逐帧加解密。
 *
 * @关键设计:
 * - **token 永不上线路**。它作为 IKM 的一部分参与 HKDF,只有同时掌握
 *   token 的两端才能派生出相同的会话密钥。因此"能解开对方的第一个加密帧"
 *   本身就是认证通过的充分证明,不需要再单独传一个口令去比对。
 *   这样做的收益:被动窃听者拿不到任何可离线爆破的验证材料。
 * - **前向保密**。每条连接用一对全新的临时 X25519 密钥;即使 token 日后
 *   泄露,也无法解密之前录下的流量。
 * - **双向独立密钥**。c2s 与 s2c 用 HKDF 输出的不同半段,避免两个方向
 *   共用 (key, nonce) 空间造成灾难性的 nonce 复用。
 * - **序号由接收方自己维护**,不从帧里读。因此重放、乱序、丢帧都表现为
 *   GCM 认证失败 → 断开连接。TCP 已保证有序,所以正常流量不受影响。
 *
 * @对应文档章节: docs/marina-link-protocol.md 第 3 章(握手与密钥派生)
 *
 * @不要在这里做的事:
 * - 不要在这里读 settings / 碰 socket(纯函数 + 一个会话对象,便于单测)
 * - 不要把失败原因细分后抛给对端(任何解密失败都只能是"断开",细分会给
 *   攻击者提供 oracle)
 *
 * @常见问题排查:
 * - 两端都配了 token 却连不上 → 十有八九是 token 抄漏了字符;派生失败的
 *   表现就是 authenticateFrame 抛 'decrypt-failed',日志里能看到。
 * - 升级后突然连不上 → 检查 LINK_PROTOCOL_VERSION 是否变了,它进了 HKDF
 *   的 info 串,版本不同必然派生出不同密钥。
 */
import {
  createCipheriv,
  createDecipheriv,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
  type KeyObject,
} from 'node:crypto';
import {
  LINK_AUTH_TAG_BYTES,
  LINK_HANDSHAKE_NONCE_BYTES,
  LINK_PROTOCOL_VERSION,
  LINK_TOKEN_BYTES,
} from '@shared/link-protocol';

/**
 * X25519 公钥的 SPKI DER 前缀(12 字节)。
 *
 * node 的 KeyObject 只吐 SPKI/DER,不给 raw 32 字节;而线路上传 44 字节的
 * DER 既浪费又给了对端一个可以塞畸形 ASN.1 的入口。所以我们线路上只传
 * raw 32 字节,导入时把这段固定前缀拼回去。
 *
 * 结构:SEQUENCE{ SEQUENCE{ OID 1.3.101.110 }, BIT STRING(33, 0 unused) }
 *   30 2a  30 05  06 03 2b 65 6e  03 21 00
 */
const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');

/** X25519 raw 公钥字节数。 */
const X25519_RAW_PUBLIC_KEY_BYTES = 32;

/** AES-256-GCM 的密钥字节数。 */
const AES_KEY_BYTES = 32;

/** GCM nonce(IV)字节数。12 字节是 GCM 的推荐值(避免额外的 GHASH 折叠)。 */
const GCM_NONCE_BYTES = 12;

/**
 * 单向密钥的使用上限。超过即拒绝继续加密。
 *
 * 2^48 远低于 GCM 在 96-bit 随机 nonce 下的安全上限,而我们用的是确定性
 * 计数器 nonce,理论上可以用到 2^64。设这么低纯粹是防御性的:真实连接
 * 一辈子也发不到 2.8e14 帧,一旦触及必然是代码 bug(计数器被重置或复用),
 * 此时宁可断开也不能冒 nonce 复用的风险 —— GCM 下 nonce 复用会直接泄露
 * 认证密钥。
 */
const MAX_FRAMES_PER_KEY = 2 ** 48;

/**
 * 一对临时 X25519 密钥,连接级别,用完即弃。
 */
export interface LinkEphemeralKeyPair {
  privateKey: KeyObject;
  /** raw 32 字节公钥,直接进握手 JSON(base64) */
  publicKeyRaw: Buffer;
}

/**
 * 生成本次连接使用的临时 X25519 密钥对。
 *
 * @returns 私钥 KeyObject 与 raw 公钥字节
 */
export function generateEphemeralKeyPair(): LinkEphemeralKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  // SPKI DER 尾部 32 字节即 raw 公钥;前 12 字节是上面那段固定前缀。
  const publicKeyRaw = Buffer.from(spki.subarray(X25519_SPKI_PREFIX.length));
  if (publicKeyRaw.length !== X25519_RAW_PUBLIC_KEY_BYTES) {
    throw new Error(
      `[LinkCrypto] generateEphemeralKeyPair: 导出的 raw 公钥长度异常 ` +
        `(got ${publicKeyRaw.length}, expect ${X25519_RAW_PUBLIC_KEY_BYTES})。` +
        `可能原因:(1) node 版本的 X25519 SPKI 编码与预期不同;` +
        `(2) generateKeyPairSync 返回了非 X25519 曲线。` +
        `建议:确认 node >= 20 且未被 polyfill 覆盖 crypto。`,
    );
  }
  return { privateKey, publicKeyRaw };
}

/**
 * 把线路上收到的 raw 32 字节公钥导入成 node 可用的 KeyObject。
 *
 * @param raw 对端的 raw X25519 公钥
 * @throws Error 长度不对或 ASN.1 导入失败(对端实现错误或恶意构造)
 */
export function importRawPublicKey(raw: Buffer): KeyObject {
  if (raw.length !== X25519_RAW_PUBLIC_KEY_BYTES) {
    throw new Error(
      `[LinkCrypto] importRawPublicKey: 公钥长度非法 ` +
        `(got ${raw.length}, expect ${X25519_RAW_PUBLIC_KEY_BYTES})。` +
        `可能原因:(1) 对端不是 Ceteris Link;(2) 握手 JSON 的 base64 被截断。` +
        `建议:确认目标端口上跑的确实是 Ceteris 的 Link Host。`,
    );
  }
  const der = Buffer.concat([X25519_SPKI_PREFIX, raw]);
  return createPublicKey({ key: der, format: 'der', type: 'spki' });
}

/**
 * 生成一个新的预共享 token(Host 首次开启 Link 时调用)。
 *
 * 用 base64url 而非 base64:token 要让用户手抄 / 贴进设置框,base64url
 * 不含 `+` `/` `=`,双击可整体选中,粘进命令行也不需要转义。
 *
 * @returns 43 字符的 base64url 字符串(32 字节熵)
 */
export function generateLinkToken(): string {
  return randomBytes(LINK_TOKEN_BYTES).toString('base64url');
}

/**
 * 生成握手随机数。
 */
export function generateHandshakeNonce(): Buffer {
  return randomBytes(LINK_HANDSHAKE_NONCE_BYTES);
}

/**
 * 常量时间比较两个字符串。
 *
 * 用于比 token 指纹一类的场合。长度不同直接返回 false 是可以接受的信息
 * 泄露(长度本来就不是秘密),但内容比较必须常量时间,否则攻击者可以
 * 按字节爆破。
 */
export function timingSafeEqualString(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * 派生会话密钥所需的全部材料。
 */
export interface DeriveSessionKeysInput {
  /** 本端的临时私钥 */
  ownPrivateKey: KeyObject;
  /** 对端的 raw 临时公钥 */
  peerPublicKeyRaw: Buffer;
  /** Client 的 raw 公钥(无论本端是哪一侧,都按 client → server 顺序进 info) */
  clientPublicKeyRaw: Buffer;
  /** Server 的 raw 公钥 */
  serverPublicKeyRaw: Buffer;
  /** Client 的握手随机数 */
  clientNonce: Buffer;
  /** Server 的握手随机数 */
  serverNonce: Buffer;
  /** 预共享 token(用户配置的字符串,原样 utf8 编码进 IKM) */
  token: string;
}

/**
 * 一对方向密钥。
 */
export interface LinkSessionKeys {
  /** Client → Server 方向的 AES-256 密钥 */
  clientToServer: Buffer;
  /** Server → Client 方向的 AES-256 密钥 */
  serverToClient: Buffer;
}

/**
 * 从 ECDH 共享秘密与预共享 token 派生双向会话密钥。
 *
 * 密钥派生的完整定义(两端必须逐字节一致,否则解密失败):
 *
 *   shared = X25519(ownPriv, peerPub)                       // 32 字节
 *   ikm    = shared ‖ utf8(token)
 *   salt   = clientNonce ‖ serverNonce                      // 32 字节
 *   info   = utf8("marina-link/v{V}") ‖ clientPub ‖ serverPub
 *   okm    = HKDF-SHA256(ikm, salt, info, 64)
 *   c2sKey = okm[0..32)
 *   s2cKey = okm[32..64)
 *
 * 为什么 info 里要放两个公钥(transcript binding):把握手记录绑进密钥,
 * 攻击者即使能改写明文握手包里的公钥,也只会导致两端派生出不同的密钥、
 * 第一个加密帧就失败,而不能悄悄降级成一个它能控制的会话。
 *
 * 为什么 token 进 IKM 而不是 salt:HKDF 的 salt 被设计成可以公开,
 * extract 阶段对 salt 的保密性不提供保证;秘密材料必须走 IKM。
 *
 * @throws Error ECDH 结果全零(对端送了低阶点),或 token 为空
 *
 * @副作用:无(纯函数)
 */
export function deriveSessionKeys(input: DeriveSessionKeysInput): LinkSessionKeys {
  if (!input.token) {
    throw new Error(
      `[LinkCrypto] deriveSessionKeys: token 为空。` +
        `可能原因:(1) Host 端未生成 token 就开启了监听;` +
        `(2) Client 端设置里 token 字段留空。` +
        `建议:在 Host 的设置 → 远程访问里生成 token 并抄到 Client。`,
    );
  }

  const peerPublicKey = importRawPublicKey(input.peerPublicKeyRaw);
  const shared = diffieHellman({
    privateKey: input.ownPrivateKey,
    publicKey: peerPublicKey,
  });

  // 低阶点防御:X25519 在对端送小阶点时会得到全零共享秘密。OpenSSL 通常
  // 已经拦掉,但标准并不强制,这里显式再挡一次 —— 全零共享秘密意味着
  // 任何人都能算出同样的结果,前向保密与认证同时失效。
  if (shared.every((b) => b === 0)) {
    throw new Error(
      `[LinkCrypto] deriveSessionKeys: ECDH 共享秘密全为零,拒绝建立会话。` +
        `可能原因:(1) 对端发送了低阶 X25519 公钥(主动攻击);` +
        `(2) 对端实现有缺陷。建议:检查是谁在连这个端口。`,
    );
  }

  const ikm = Buffer.concat([shared, Buffer.from(input.token, 'utf8')]);
  const salt = Buffer.concat([input.clientNonce, input.serverNonce]);
  const info = Buffer.concat([
    Buffer.from(`marina-link/v${LINK_PROTOCOL_VERSION}`, 'utf8'),
    input.clientPublicKeyRaw,
    input.serverPublicKeyRaw,
  ]);

  const okm = Buffer.from(hkdfSync('sha256', ikm, salt, info, AES_KEY_BYTES * 2));

  return {
    clientToServer: okm.subarray(0, AES_KEY_BYTES),
    serverToClient: okm.subarray(AES_KEY_BYTES, AES_KEY_BYTES * 2),
  };
}

/**
 * 按序号构造 GCM nonce。
 *
 * 12 字节 = 4 字节零填充 ‖ 8 字节大端序号。
 *
 * 为什么可以用确定性计数器而不是随机 nonce:每条连接的密钥都是全新的
 * (临时 ECDH),所以计数器在该密钥下永不重复。这比随机 nonce 更安全
 * (随机 96-bit nonce 在 2^32 帧后有生日碰撞风险),也让重放天然失效。
 */
function nonceForSeq(seq: number): Buffer {
  const nonce = Buffer.alloc(GCM_NONCE_BYTES);
  // writeBigUInt64BE 放在偏移 4,前 4 字节保持零。
  nonce.writeBigUInt64BE(BigInt(seq), 4);
  return nonce;
}

/**
 * 一条连接上单个方向的加密通道。
 *
 * 加密与解密各持有一个独立实例(不同密钥、不同计数器)。
 */
export class LinkCipherStream {
  private seq = 0;

  /**
   * @param key 该方向的 AES-256 密钥
   * @param direction 仅用于错误信息,便于日志定位是哪个方向出的问题
   */
  constructor(
    private readonly key: Buffer,
    private readonly direction: 'c2s' | 's2c',
  ) {
    if (key.length !== AES_KEY_BYTES) {
      throw new Error(
        `[LinkCrypto] LinkCipherStream: 密钥长度非法 ` +
          `(got ${key.length}, expect ${AES_KEY_BYTES})。这是 deriveSessionKeys 的实现 bug。`,
      );
    }
  }

  /** 当前已处理的帧数,供诊断与测试断言。 */
  get frameCount(): number {
    return this.seq;
  }

  /**
   * 加密一帧。
   *
   * @param plaintext 明文(JSON 序列化后的 UTF-8 字节)
   * @returns `ciphertext ‖ tag`,调用方负责加上长度前缀
   *
   * @throws Error 该密钥已用满 MAX_FRAMES_PER_KEY(实际不可能到达,到了说明有 bug)
   */
  encrypt(plaintext: Buffer): Buffer {
    if (this.seq >= MAX_FRAMES_PER_KEY) {
      throw new Error(
        `[LinkCrypto] encrypt(${this.direction}): 该密钥已达帧数上限 ${MAX_FRAMES_PER_KEY}。` +
          `继续使用会导致 GCM nonce 复用(灾难性)。这必然是计数器被错误重置的 bug。` +
          `建议:检查 LinkCipherStream 是否被复用到了第二条连接上。`,
      );
    }
    const nonce = nonceForSeq(this.seq);
    this.seq += 1;
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([body, cipher.getAuthTag()]);
  }

  /**
   * 解密一帧。
   *
   * 使用**本端自己维护的**序号,而非帧里携带的序号。因此任何重放、乱序、
   * 丢帧都会导致认证标签校验失败并抛错,调用方应当直接断开连接。
   *
   * @param frame `ciphertext ‖ tag`
   * @returns 明文
   *
   * @throws Error 帧过短,或 GCM 认证失败(token 不匹配 / 篡改 / 重放)
   */
  decrypt(frame: Buffer): Buffer {
    if (frame.length < LINK_AUTH_TAG_BYTES) {
      throw new Error(
        `[LinkCrypto] decrypt(${this.direction}): 帧长度 ${frame.length} 小于认证标签长度 ` +
          `${LINK_AUTH_TAG_BYTES}。可能原因:(1) 对端不是 Ceteris Link;(2) 分帧逻辑有 bug。`,
      );
    }
    const body = frame.subarray(0, frame.length - LINK_AUTH_TAG_BYTES);
    const tag = frame.subarray(frame.length - LINK_AUTH_TAG_BYTES);
    const nonce = nonceForSeq(this.seq);

    const decipher = createDecipheriv('aes-256-gcm', this.key, nonce);
    decipher.setAuthTag(tag);
    let plaintext: Buffer;
    try {
      plaintext = Buffer.concat([decipher.update(body), decipher.final()]);
    } catch {
      // 故意不透出底层错误细节:对外只有"解不开"这一种结果。
      // 区分"token 错"与"被篡改"会给攻击者提供 oracle。
      throw new Error(
        `[LinkCrypto] decrypt(${this.direction}): 帧认证失败(seq=${this.seq})。` +
          `可能原因:(1) 两端 token 不一致 —— 最常见;(2) 流量被篡改;` +
          `(3) 帧被重放或乱序。建议:核对两端设置里的 token 是否逐字符相同。`,
      );
    }
    // 只有解密成功才推进计数器。失败时调用方必须断开连接,不存在"跳过这帧
    // 继续用"的路径,所以不推进不会造成状态错乱。
    this.seq += 1;
    return plaintext;
  }
}

/**
 * 由派生出的双向密钥构造一对加解密通道。
 *
 * @param keys deriveSessionKeys 的输出
 * @param side 本端是 client 还是 server,决定哪个方向用于发、哪个用于收
 */
export function createCipherPair(
  keys: LinkSessionKeys,
  side: 'client' | 'server',
): { send: LinkCipherStream; recv: LinkCipherStream } {
  if (side === 'client') {
    return {
      send: new LinkCipherStream(keys.clientToServer, 'c2s'),
      recv: new LinkCipherStream(keys.serverToClient, 's2c'),
    };
  }
  return {
    send: new LinkCipherStream(keys.serverToClient, 's2c'),
    recv: new LinkCipherStream(keys.clientToServer, 'c2s'),
  };
}
