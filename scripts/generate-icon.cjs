#!/usr/bin/env node
/**
 * @file scripts/generate-icon.cjs
 * @purpose Ceteris 应用图标生成器。从一张原图缩出所有尺寸的 PNG、多尺寸 ICO 和托盘位图。
 *
 * 用法:
 *   npm run generate-icon
 *
 * 输入:
 *   build/icon-source.png              正方形 RGBA 原图(至少 1024px),圆角外已透明。唯一的设计源。
 *
 * 产物:
 *   build/icon.png                     1024×1024,Linux 与跨平台打包用
 *   build/icon.ico                     16 到 256 共 7 档,exe 与 NSIS 用
 *   native/context-menu/package/assets Win11 右键菜单 MSIX 用的 PNG 与 ICO
 *   src/main/tray.ts                   TRAY_BITMAP_16 / TRAY_BITMAP_32 两个常量(托盘位图)
 *
 * @设计: 午夜蓝圆角方块,只在底边升起一道紫粉极光,C 身后保持纯净深色,让白色的 C
 *   对比最强。主角是一笔书法 C,起笔饱满、收笔飞白;C 怀里的青柠色 ">" 用同一支笔写成,
 *   两笔读作一个手写标记。
 *
 * @原图来历: 由 Google Nano Banana 2.1(google/gemini-nano-banana-2.1,经 OpenRouter)
 *   按上面的描述生成 2048 图,裁掉边缘 6px、缩到 1024、套圆角半径 23.5% 的抗锯齿蒙版。
 *   AI 出图不能逐像素复现,所以原图提交进仓库,脚本只负责缩放和编码。
 *   要改设计,替换 build/icon-source.png 后重跑本脚本。
 *
 * @关键设计:
 * - 不依赖任何 npm 包(AGENTS.md 1.2 边界 2):内置最小 PNG 解码器、Lanczos3 缩放器、
 *   PNG / ICO 编码器。
 * - 缩放在预乘 alpha 上做,否则透明圆角外的颜色会渗进边缘,缩小后圆角发灰。
 * - Lanczos3 比面积平均锐利,小尺寸上书法 C 的细笔画不至于糊掉。它会在硬边外过冲,
 *   结果钳到 0..255。
 * - ICO 里小于 256 的帧用 DIB,256 帧用 PNG。NSIS 与部分 Windows Shell 路径
 *   对 PNG 帧的小尺寸支持不可靠,这是 Windows 图标的传统布局。
 *
 * - 托盘位图直接改写 src/main/tray.ts 里的两个 base64 常量:托盘不读打包资源(dev 与
 *   打包后路径不同),所以位图必须内嵌,由脚本写进去才不会和原图脱节。格式是
 *   createFromBitmap 要的 BGRA、alpha 预乘。
 *
 * @同步点: 安装程序配图用 Material 主题的海青种子色,不跟随图标配色。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ROOT = path.resolve(__dirname, '..');
const BUILD_DIR = path.join(ROOT, 'build');
const ARTWORK = path.join(BUILD_DIR, 'icon-source.png');
const TRAY_SOURCE = path.join(ROOT, 'src', 'main', 'tray.ts');
const NATIVE_ASSETS = path.join(ROOT, 'native', 'context-menu', 'package', 'assets');

const PNG_SIZE = 1024;
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
const NATIVE_PNG_SIZE = 256;
const TRAY_SIZES = [16, 32];
const TRAY_LINE_LENGTH = 100;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// ────────────────────────────────────────────────────────────────
// 解码
// ────────────────────────────────────────────────────────────────

/** PNG 行过滤器 4(Paeth)的预测值。 */
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/**
 * 解码 8 位、非隔行的 RGB 或 RGBA PNG,返回 { width, height, rgba }。
 * 原图由我们自己导出,只支持这两种格式;遇到别的格式直接报错,而不是悄悄解错。
 */
function decodePng(file) {
  const data = fs.readFileSync(file);
  if (!data.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error(
      `[generate-icon] ${file} is not a PNG. Export the artwork as PNG (RGBA, 8 bit) and rerun.`,
    );
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat = [];
  while (offset < data.length) {
    const length = data.readUInt32BE(offset);
    const type = data.toString('ascii', offset + 4, offset + 8);
    const body = data.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const [bitDepth, colorType, , , interlace] = body.subarray(8, 13);
      channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
      if (bitDepth !== 8 || channels === 0 || interlace !== 0) {
        throw new Error(
          `[generate-icon] ${file} has bitDepth=${bitDepth} colorType=${colorType} interlace=${interlace}. ` +
            'Only 8 bit, non interlaced RGB or RGBA is supported. Re-export it in that format.',
        );
      }
    } else if (type === 'IDAT') {
      idat.push(body);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const row = y * stride;
    for (let i = 0; i < stride; i++) {
      const left = i >= channels ? pixels[row + i - channels] : 0;
      const up = y > 0 ? pixels[row - stride + i] : 0;
      const upLeft = y > 0 && i >= channels ? pixels[row - stride + i - channels] : 0;
      const predictor = [0, left, up, (left + up) >> 1, paeth(left, up, upLeft)][filter];
      if (predictor === undefined) {
        throw new Error(`[generate-icon] ${file} row ${y} uses unknown PNG filter ${filter}.`);
      }
      pixels[row + i] = (line[i] + predictor) & 0xff;
    }
  }

  const rgba = Buffer.alloc(width * height * 4, 255);
  for (let i = 0; i < width * height; i++)
    pixels.copy(rgba, i * 4, i * channels, (i + 1) * channels);
  return { width, height, rgba };
}

// ────────────────────────────────────────────────────────────────
// 缩放
// ────────────────────────────────────────────────────────────────

function lanczos3(x) {
  if (x === 0) return 1;
  if (Math.abs(x) >= 3) return 0;
  const px = Math.PI * x;
  return (3 * Math.sin(px) * Math.sin(px / 3)) / (px * px);
}

/**
 * 一维 Lanczos3 权重表:每个输出像素取哪些输入像素、各占多少。缩小时核按比例放宽,
 * 等于先低通再采样,避免摩尔纹。
 */
function weightsFor(sourceSize, targetSize) {
  const scale = sourceSize / targetSize;
  const support = 3 * Math.max(scale, 1);
  const table = [];
  for (let out = 0; out < targetSize; out++) {
    const center = (out + 0.5) * scale;
    const start = Math.max(0, Math.floor(center - support));
    const end = Math.min(sourceSize - 1, Math.ceil(center + support));
    const weights = [];
    let sum = 0;
    for (let i = start; i <= end; i++) {
      const w = lanczos3((i + 0.5 - center) / Math.max(scale, 1));
      weights.push(w);
      sum += w;
    }
    table.push({ start, weights: weights.map((w) => w / sum) });
  }
  return table;
}

/** 把 RGBA 图缩到 size×size。先预乘 alpha,两遍可分离卷积,再除回 alpha。 */
function resize(image, size) {
  const { width, height, rgba } = image;
  const source = new Float32Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const alpha = rgba[i * 4 + 3] / 255;
    source[i * 4] = rgba[i * 4] * alpha;
    source[i * 4 + 1] = rgba[i * 4 + 1] * alpha;
    source[i * 4 + 2] = rgba[i * 4 + 2] * alpha;
    source[i * 4 + 3] = rgba[i * 4 + 3];
  }

  const columns = weightsFor(width, size);
  const horizontal = new Float32Array(size * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < size; x++) {
      const { start, weights } = columns[x];
      for (let c = 0; c < 4; c++) {
        let sum = 0;
        for (let k = 0; k < weights.length; k++)
          sum += source[(y * width + start + k) * 4 + c] * weights[k];
        horizontal[(y * size + x) * 4 + c] = sum;
      }
    }
  }

  const rows = weightsFor(height, size);
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    const { start, weights } = rows[y];
    for (let x = 0; x < size; x++) {
      const pixel = [0, 0, 0, 0];
      for (let k = 0; k < weights.length; k++) {
        const from = ((start + k) * size + x) * 4;
        for (let c = 0; c < 4; c++) pixel[c] += horizontal[from + c] * weights[k];
      }
      const alpha = Math.max(0, Math.min(255, pixel[3]));
      const i = (y * size + x) * 4;
      for (let c = 0; c < 3; c++) {
        const value = alpha > 0 ? pixel[c] / (alpha / 255) : 0;
        out[i + c] = Math.max(0, Math.min(255, Math.round(value)));
      }
      out[i + 3] = Math.round(alpha);
    }
  }
  return out;
}

// ────────────────────────────────────────────────────────────────
// 编码
// ────────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data) {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ data[i]) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

function encodePng(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const offset = y * (size * 4 + 1);
    raw[offset] = 0; // filter: none
    rgba.copy(raw, offset + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** ICO 内的 DIB 帧:BITMAPINFOHEADER + 自下而上 BGRA + 1bpp AND 掩码。 */
function encodeDib(rgba, size) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8); // ICO 约定:高度含 AND 掩码,写两倍
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);

  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const src = (y * size + x) * 4;
      const dst = ((size - 1 - y) * size + x) * 4;
      pixels[dst] = rgba[src + 2];
      pixels[dst + 1] = rgba[src + 1];
      pixels[dst + 2] = rgba[src];
      pixels[dst + 3] = rgba[src + 3];
    }
  }

  // 32bpp 帧靠 alpha 通道透明,掩码全 0 即可,但这段数据必须存在。每行按 4 字节对齐。
  const maskRowBytes = Math.ceil(size / 32) * 4;
  return Buffer.concat([header, pixels, Buffer.alloc(maskRowBytes * size)]);
}

function encodeIco(frames) {
  const dir = Buffer.alloc(6 + 16 * frames.length);
  dir.writeUInt16LE(1, 2); // type: ICO
  dir.writeUInt16LE(frames.length, 4);
  let offset = dir.length;
  frames.forEach(({ size, data }, index) => {
    const entry = 6 + index * 16;
    dir.writeUInt8(size === 256 ? 0 : size, entry);
    dir.writeUInt8(size === 256 ? 0 : size, entry + 1);
    dir.writeUInt16LE(1, entry + 4);
    dir.writeUInt16LE(32, entry + 6);
    dir.writeUInt32LE(data.length, entry + 8);
    dir.writeUInt32LE(offset, entry + 12);
    offset += data.length;
  });
  return Buffer.concat([dir, ...frames.map((frame) => frame.data)]);
}

/** RGBA 转成 createFromBitmap 要的 BGRA、alpha 预乘。 */
function toPremultipliedBgra(rgba) {
  const out = Buffer.alloc(rgba.length);
  for (let i = 0; i < rgba.length; i += 4) {
    const alpha = rgba[i + 3];
    out[i] = Math.round((rgba[i + 2] * alpha) / 255);
    out[i + 1] = Math.round((rgba[i + 1] * alpha) / 255);
    out[i + 2] = Math.round((rgba[i] * alpha) / 255);
    out[i + 3] = alpha;
  }
  return out;
}

/**
 * 把 tray.ts 里 `const TRAY_BITMAP_<size> =` 到下一个分号之间换成新的 base64,
 * 按 TRAY_LINE_LENGTH 折行,和 prettier 的输出一致。找不到常量就报错,不悄悄跳过。
 */
function replaceTrayBitmap(source, size, bitmap) {
  const base64 = bitmap.toString('base64');
  const lines = [];
  for (let i = 0; i < base64.length; i += TRAY_LINE_LENGTH) {
    lines.push(`  '${base64.slice(i, i + TRAY_LINE_LENGTH)}'`);
  }
  const pattern = new RegExp(`const TRAY_BITMAP_${size} =[^;]*;`);
  if (!pattern.test(source)) {
    throw new Error(
      `[generate-icon] TRAY_BITMAP_${size} not found in src/main/tray.ts. ` +
        'Possible causes: (1) the constant was renamed, (2) it is no longer a string literal ending in ";". ' +
        'Update replaceTrayBitmap to match the new code.',
    );
  }
  return source.replace(pattern, `const TRAY_BITMAP_${size} =\n${lines.join(' +\n')};`);
}

function write(file, data) {
  fs.writeFileSync(file, data);
  console.log(`[generate-icon] wrote ${path.relative(ROOT, file)} (${data.length} bytes)`);
}

function main() {
  const artwork = decodePng(ARTWORK);
  if (artwork.width !== artwork.height || artwork.width < PNG_SIZE) {
    throw new Error(
      `[generate-icon] ${path.relative(ROOT, ARTWORK)} is ${artwork.width}×${artwork.height}. ` +
        `It must be square and at least ${PNG_SIZE}px, or the large icons will be upscaled and blurry.`,
    );
  }
  const render = (size) => (size === artwork.width ? artwork.rgba : resize(artwork, size));

  const ico = encodeIco(
    ICO_SIZES.map((size) => {
      const rgba = render(size);
      return { size, data: size === 256 ? encodePng(rgba, size) : encodeDib(rgba, size) };
    }),
  );
  const nativePng = encodePng(render(NATIVE_PNG_SIZE), NATIVE_PNG_SIZE);

  // 原图正好 1024 时直接复制:本脚本的编码器不做行过滤,重新编码会比原文件大三成。
  const png =
    artwork.width === PNG_SIZE ? fs.readFileSync(ARTWORK) : encodePng(render(PNG_SIZE), PNG_SIZE);
  write(path.join(BUILD_DIR, 'icon.png'), png);
  write(path.join(BUILD_DIR, 'icon.ico'), ico);
  write(path.join(NATIVE_ASSETS, 'menu-icon.ico'), ico);
  for (const name of ['Square150x150Logo.png', 'Square44x44Logo.png', 'StoreLogo.png']) {
    write(path.join(NATIVE_ASSETS, name), nativePng);
  }

  let tray = fs.readFileSync(TRAY_SOURCE, 'utf8');
  const eol = tray.includes('\r\n') ? '\r\n' : '\n';
  tray = tray.replace(/\r\n/g, '\n');
  for (const size of TRAY_SIZES) {
    tray = replaceTrayBitmap(tray, size, toPremultipliedBgra(render(size)));
  }
  write(TRAY_SOURCE, tray.replace(/\n/g, eol));
}

main();
