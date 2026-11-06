/**
 * @file src/main/link/frame-codec.ts
 * @purpose TCP 字节流的分帧编解码。TCP 是流不是消息,一次 'data' 事件可能
 *   给到半个帧,也可能给到三个半帧;这里把字节流还原成一条条完整的帧。
 *
 * @关键设计:
 * - 帧格式:`[uint32 BE 长度][载荷]`。长度**不含**这 4 字节前缀本身。
 * - FrameDecoder 是纯状态机,不碰 socket,因此可以直接喂任意切分的
 *   Buffer 做单测(测试里会逐字节喂,验证极端分片下的正确性)。
 * - 长度上限是硬约束:先校验再分配。否则一个伪造的 0xFFFFFFFF 前缀就能
 *   让我们尝试 allocate 4 GiB(经典的 length-prefix DoS)。
 * - 上限可变:握手阶段用 LINK_MAX_HANDSHAKE_BYTES(4 KiB,对端尚未认证,
 *   能让它占的内存越少越好),握手完成后调 raiseLimit 放宽到
 *   LINK_MAX_FRAME_BYTES(8 MiB,要容纳 scrollback 响应)。
 *
 * @对应文档章节: docs/ceteris-link-protocol.md 第 2 章(分帧)
 *
 * @不要在这里做的事:
 * - 不要做加解密(那是 link-crypto.ts 的职责,本层只认字节)
 * - 不要做 JSON 解析(调用方按阶段决定载荷是明文 JSON 还是密文)
 *
 * @常见问题排查:
 * - 收到 'frame-too-large' → 对端多半根本不是 Ceteris Link(比如误连了
 *   一个 HTTP 服务,"GET /" 的 ASCII 会被当成长度 0x47455420 = 1.2 GB)
 * - 帧内容错位 / JSON 解析失败 → 检查两端是否都在用同一个 raiseLimit 时机
 */
import {
  LINK_LENGTH_PREFIX_BYTES,
  LINK_MAX_FRAME_BYTES,
  LINK_MAX_HANDSHAKE_BYTES,
} from '@shared/link-protocol';

/**
 * 分帧错误。带 code 便于调用方区分"对端不是 Ceteris"(直接断开、不重连)
 * 与其他情况。
 */
export class FrameDecodeError extends Error {
  constructor(
    readonly code: 'frame-too-large',
    message: string,
  ) {
    super(message);
    this.name = 'FrameDecodeError';
  }
}

/**
 * 把一段载荷编码成带长度前缀的帧。
 *
 * @param payload 载荷字节(明文 JSON 或密文,本层不关心)
 * @returns 可直接 socket.write 的完整帧
 *
 * @throws Error 载荷超过 LINK_MAX_FRAME_BYTES(说明上层攒了一个超大消息,
 *   通常是 scrollback 超限,属于实现 bug 而非正常输入)
 */
export function encodeFrame(payload: Buffer): Buffer {
  if (payload.length > LINK_MAX_FRAME_BYTES) {
    throw new Error(
      `[FrameCodec] encodeFrame: 载荷 ${payload.length} 字节超过上限 ${LINK_MAX_FRAME_BYTES}。` +
        `可能原因:(1) session scrollback 超出了 2MB 的设计上限;` +
        `(2) 某条命令的响应体异常膨胀。` +
        `建议:看日志里紧邻的 channel 名定位是哪条消息。`,
    );
  }
  const frame = Buffer.allocUnsafe(LINK_LENGTH_PREFIX_BYTES + payload.length);
  frame.writeUInt32BE(payload.length, 0);
  payload.copy(frame, LINK_LENGTH_PREFIX_BYTES);
  return frame;
}

/**
 * 流式分帧解码器。
 *
 * 用法:
 * ```ts
 * const decoder = new FrameDecoder();
 * socket.on('data', (chunk) => {
 *   for (const frame of decoder.push(chunk)) {
 *     handleFrame(frame);
 *   }
 * });
 * ```
 *
 * 状态机只有两个状态,隐含在 buffer 长度里:
 *   等待长度前缀(buffer < 4 字节) → 等待载荷(buffer >= 4 但不足一整帧)
 *   → 吐出一帧,回到起点
 */
export class FrameDecoder {
  /** 尚未凑成完整帧的残余字节 */
  private buffer: Buffer = Buffer.alloc(0);

  /**
   * 当前允许的单帧最大载荷。握手阶段收紧,认证后放宽。
   * 见 raiseLimit 的说明。
   */
  private maxPayloadBytes: number;

  /**
   * @param initialLimit 初始上限,默认为握手阶段的紧上限。
   */
  constructor(initialLimit: number = LINK_MAX_HANDSHAKE_BYTES) {
    this.maxPayloadBytes = initialLimit;
  }

  /**
   * 握手完成后放宽帧上限。
   *
   * 为什么分两段:握手阶段的对端还没证明自己掌握 token,此时它能让我们
   * 分配的内存必须尽可能小。一旦第一个加密帧验证通过,对端已被认证,
   * 放宽到业务需要的 8 MiB 是安全的。
   */
  raiseLimit(limit: number = LINK_MAX_FRAME_BYTES): void {
    this.maxPayloadBytes = limit;
  }

  /**
   * 喂入一段新到达的字节,返回其中能凑出的所有完整帧(可能是 0 个,也可能
   * 是多个)。
   *
   * @param chunk socket 'data' 事件给到的字节
   * @returns 本次能解出的完整帧载荷,按到达顺序
   *
   * @throws FrameDecodeError 长度前缀声明的载荷超过当前上限
   */
  push(chunk: Buffer): Buffer[] {
    // 注意:这里必须先 concat 再循环。曾经试过"chunk 恰好是完整帧时跳过
    // concat"的快路径,但只要 buffer 里还有上一次的残余就会导致乱序,
    // 而这种情况在高吞吐(PTY 刷屏)下才出现,本地测不出来。不值得。
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);

    const frames: Buffer[] = [];
    for (;;) {
      if (this.buffer.length < LINK_LENGTH_PREFIX_BYTES) break;

      const payloadLength = this.buffer.readUInt32BE(0);
      if (payloadLength > this.maxPayloadBytes) {
        throw new FrameDecodeError(
          'frame-too-large',
          `[FrameCodec] 帧载荷声明 ${payloadLength} 字节,超过当前上限 ${this.maxPayloadBytes}。` +
            `可能原因:(1) 目标端口上跑的不是 Ceteris Link(例如误连了 HTTP 服务,` +
            `请求行的 ASCII 会被读成一个巨大的长度);(2) 流被截断导致长度前缀错位;` +
            `(3) 恶意构造的长度前缀。连接将被断开。`,
        );
      }

      const totalLength = LINK_LENGTH_PREFIX_BYTES + payloadLength;
      if (this.buffer.length < totalLength) break;

      // subarray 与原 buffer 共享内存,而下一行就要把 this.buffer 换成
      // 另一段 subarray;两者都指向同一块底层 ArrayBuffer,不会互相破坏
      // (都是只读使用)。但调用方可能长期持有 frame,导致整块大 buffer
      // 无法回收,所以这里显式拷贝一份短的。
      frames.push(Buffer.from(this.buffer.subarray(LINK_LENGTH_PREFIX_BYTES, totalLength)));
      this.buffer = this.buffer.subarray(totalLength);
    }

    // 循环结束后 this.buffer 是一个指向大块内存的 subarray。如果残余很小
    // 而底层块很大,拷贝一份让大块可以被 GC 回收。阈值取 64 KiB:小于这个
    // 数不值得为省内存多做一次拷贝。
    if (this.buffer.length > 0 && this.buffer.byteLength > 65_536) {
      this.buffer = Buffer.from(this.buffer);
    }

    return frames;
  }

  /** 当前尚未凑成完整帧的残余字节数,供诊断与测试断言。 */
  get pendingBytes(): number {
    return this.buffer.length;
  }
}
