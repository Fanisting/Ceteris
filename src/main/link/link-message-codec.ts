/**
 * @file src/main/link/link-message-codec.ts
 * @purpose Ceteris Link 加密帧里的明文怎么编码:JSON,或者 deflate 过的 JSON(ADR-056)。
 *   Host 与 Client 都用这里的两个函数,压缩规则只在这一处。
 *
 * @关键设计:
 * - 明文的第一个字节区分两种格式。JSON 消息永远以 `{`(0x7B)开头;压缩过的消息
 *   以 0x01 开头,后面是 raw deflate 数据。解码端两种都认,不看对端声明了什么,
 *   所以只有编码端需要知道对端支不支持。
 * - 先压缩再加密。加密过的数据是随机的,压不动。
 * - 每条消息单独压缩,不共享字典。这样一条消息的长度只取决于它自己的内容,
 *   不会因为和前面的消息有重复而变短,压缩比泄露的信息只到单条消息为止。
 * - 解压设上限(LINK_MAX_FRAME_BYTES):压缩炸弹解不出超过一帧上限的明文。
 * - 终端输出事件(evt:session:output)的 data 是 base64。base64 把字节打散成 6 位一组,
 *   deflate 找不到重复,omp 整屏重画只能压到 1/3。压缩前把它换成 latin1 字符串
 *   (dataLatin1,一个字符一个字节),解压后再换回 base64,同样的数据能压到 1/4.5。
 *   这个替换只发生在压缩帧里,解码端还原后窗口拿到的 payload 与原来逐字节相同。
 *
 * @对应文档章节: docs/ceteris-link-protocol.md 第 3.4 节;docs/软件定义书.md ADR-056
 *
 * @不要在这里做的事:
 * - 不要在这里加解密或分帧(那是 link-crypto.ts 和 frame-codec.ts 的职责)
 * - 不要判断对端支不支持压缩(调用方按 auth / auth-ok 的 features 决定传不传 deflate)
 */
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { LINK_DEFLATE_MIN_BYTES, LINK_MAX_FRAME_BYTES } from '@shared/link-protocol';
import { EVENT_CHANNELS } from '@shared/protocol';

/** 压缩消息的第一个字节。JSON 不可能以它开头。 */
const DEFLATE_MARKER = 0x01;

/** encodeLinkMessage 的选项。 */
export interface EncodeLinkMessageOptions {
  /** 对端声明了 deflate,且这条消息值得压缩时为 true */
  deflate: boolean;
}

/**
 * 把一条 Link 消息编码成待加密的明文。
 *
 * @param msg 任意可 JSON 序列化的消息
 * @param options deflate 为 false 时总是输出 JSON
 * @returns 明文。压缩后不比原文小时退回 JSON
 * @throws 只有 JSON.stringify 会抛(循环引用等),与原来直接 stringify 的行为一致
 */
export function encodeLinkMessage(msg: unknown, options: EncodeLinkMessageOptions): Buffer {
  const json = Buffer.from(JSON.stringify(msg), 'utf8');
  if (!options.deflate || json.length < LINK_DEFLATE_MIN_BYTES) return json;
  const latin1 = outputAsLatin1(msg);
  const latin1Json = latin1 ? Buffer.from(JSON.stringify(latin1), 'utf8') : null;
  // latin1 的 JSON 可能比 base64 的大(每个控制字符转义成 6 字节)。解码端的解压上限是
  // LINK_MAX_FRAME_BYTES,超过就退回压 base64 版,保证对端解得开
  const source = latin1Json && latin1Json.length <= LINK_MAX_FRAME_BYTES ? latin1Json : json;
  const packed = deflateRawSync(source);
  if (packed.length + 1 >= json.length) return json;
  const out = Buffer.allocUnsafe(packed.length + 1);
  out[0] = DEFLATE_MARKER;
  packed.copy(out, 1);
  return out;
}

/**
 * 把解密后的明文还原成消息对象。
 *
 * @param plaintext 解密后的明文
 * @returns 解析出的 JSON 值;调用方再按 type 分派
 * @throws Error 解压失败(数据损坏,或解出来超过 LINK_MAX_FRAME_BYTES);JSON 解析失败。
 *   调用方会因此断开连接,与收到坏帧时的处理一致
 */
export function decodeLinkMessage(plaintext: Buffer): unknown {
  if (plaintext.length > 0 && plaintext[0] === DEFLATE_MARKER) {
    let json: Buffer;
    try {
      json = inflateRawSync(plaintext.subarray(1), { maxOutputLength: LINK_MAX_FRAME_BYTES });
    } catch (err) {
      throw new Error(
        `解压 Link 消息失败(压缩数据 ${plaintext.length - 1} 字节):` +
          `${err instanceof Error ? err.message : String(err)}。可能原因:(1) 解出来超过 ` +
          `${LINK_MAX_FRAME_BYTES} 字节的单帧上限;(2) 对端的压缩实现有误。建议:看对端日志,` +
          `必要时两端升级到同一版本。`,
      );
    }
    return restoreOutputBase64(JSON.parse(json.toString('utf8')));
  }
  return JSON.parse(plaintext.toString('utf8'));
}

/** evt:session:output 里 base64 的 data 换成 latin1 后的 payload。 */
interface Latin1OutputPayload {
  dataLatin1: string;
  [key: string]: unknown;
}

/**
 * 是终端输出事件时,返回 data 换成 dataLatin1 的浅拷贝;否则 null。
 *
 * 不改传进来的对象:同一个 envelope 可能还要发给别的窗口。
 */
function outputAsLatin1(msg: unknown): unknown {
  const m = msg as { type?: unknown; channel?: unknown; envelope?: unknown } | null;
  if (!m || m.type !== 'evt' || m.channel !== EVENT_CHANNELS.SESSION_OUTPUT) return null;
  const envelope = m.envelope as { payload?: unknown } | null;
  const payload = envelope?.payload as { data?: unknown } | null | undefined;
  if (!payload || typeof payload.data !== 'string') return null;
  const { data, ...rest } = payload;
  const next: Latin1OutputPayload = {
    ...rest,
    dataLatin1: Buffer.from(data, 'base64').toString('latin1'),
  };
  return { ...m, envelope: { ...envelope, payload: next } };
}

/** outputAsLatin1 的逆操作。不是那种形状时原样返回。 */
function restoreOutputBase64(msg: unknown): unknown {
  const m = msg as { type?: unknown; channel?: unknown; envelope?: unknown } | null;
  if (!m || m.type !== 'evt' || m.channel !== EVENT_CHANNELS.SESSION_OUTPUT) return msg;
  const envelope = m.envelope as { payload?: unknown } | null;
  const payload = envelope?.payload as { dataLatin1?: unknown } | null | undefined;
  if (!payload || typeof payload.dataLatin1 !== 'string') return msg;
  const { dataLatin1, ...rest } = payload;
  return {
    ...m,
    envelope: {
      ...envelope,
      payload: { ...rest, data: Buffer.from(dataLatin1, 'latin1').toString('base64') },
    },
  };
}

/**
 * 对端在 auth / auth-ok 里声明的能力里有没有 feature。
 *
 * @param features 对端的 features 字段,来自网络,形状不可信
 */
export function peerHasFeature(features: unknown, feature: string): boolean {
  return Array.isArray(features) && features.includes(feature);
}
