#!/usr/bin/env node
/**
 * @file scripts/generate-icon.cjs
 * @purpose Marina 应用图标生成器。一份几何定义同时产出 SVG、PNG 和多尺寸 ICO。
 *
 * 用法:
 *   npm run generate-icon
 *
 * 产物:
 *   build/icon.svg                     矢量源图(由本脚本写出,不要手改)
 *   build/icon.png                     1024×1024,Linux 与跨平台打包用
 *   build/icon.ico                     16 到 256 共 7 档,exe 与 NSIS 用
 *   native/context-menu/package/assets Win11 右键菜单 MSIX 用的 PNG 与 ICO
 *
 * @设计: Material Design 产品图标的做法:平涂色块分层,不用渐变,主体居中在
 *   安全区内。海青底上一个白色 ">" 提示符,底部一层浅青的水面。提示符表明这是
 *   终端,水面是 marina(港湾)的意象,波浪边与运行中标签页的指示线呼应。配色
 *   取自 Marina Material 主题的种子色 #006a6a。
 *
 * @关键设计:
 * - 不依赖任何 npm 包(AGENTS.md 1.2 边界 2):用 SDF 算覆盖率实现抗锯齿,
 *   内置最小 PNG / ICO 编码器。
 * - 24px 及以下换用 SMALL 几何:提示符加粗,水面只留一个波峰。大图的波峰缩到
 *   16px 只剩不到 1px,水面边缘会变成一条直线。
 * - ICO 里小于 256 的帧用 DIB,256 帧用 PNG。NSIS 与部分 Windows Shell 路径
 *   对 PNG 帧的小尺寸支持不可靠,这是 Windows 图标的传统布局。
 *
 * @同步点: 改几何或配色时,同步 src/main/tray.ts 的像素图。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ROOT = path.resolve(__dirname, '..');
const BUILD_DIR = path.join(ROOT, 'build');
const NATIVE_ASSETS = path.join(ROOT, 'native', 'context-menu', 'package', 'assets');

const PNG_SIZE = 1024;
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
const NATIVE_PNG_SIZE = 256;
const SMALL_ICON_MAX = 24;

/** 所有几何都定义在 256×256 坐标系里,渲染时按目标尺寸缩放。 */
const DESIGN_SIZE = 256;
const CORNER_RADIUS = 72;
const BG_COLOR = '#006a6a';
const PROMPT_COLOR = '#ffffff';
const WATER_COLOR = '#9cf1f0';

/** water:水面边缘是上下交替的二次贝塞尔,control 是相对 level 的控制点偏移。 */
const FULL = {
  prompt: { points: [[101, 56], [151, 100], [101, 144]], width: 30 },
  water: { level: 188, segmentLength: 64, control: 24 },
};

const SMALL = {
  prompt: { points: [[98, 36], [156, 84], [98, 132]], width: 42 },
  water: { level: 188, segmentLength: 128, control: 28 },
};

function rgb(hex) {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

// ────────────────────────────────────────────────────────────────
// 几何
// ────────────────────────────────────────────────────────────────

/** 水面边缘在 x 处的高度。第一段向上,此后交替。 */
function waterEdge(water, x) {
  const segment = Math.floor(x / water.segmentLength);
  const t = x / water.segmentLength - segment;
  const sign = segment % 2 === 0 ? -1 : 1;
  return water.level + sign * water.control * 2 * t * (1 - t);
}

function waterToSvgPath(water) {
  const half = water.segmentLength / 2;
  const count = Math.ceil(DESIGN_SIZE / water.segmentLength);
  const segments = [];
  for (let s = 0; s < count; s++) {
    const sign = s % 2 === 0 ? -1 : 1;
    segments.push(`q${half} ${sign * water.control} ${water.segmentLength} 0`);
  }
  return `M0 ${water.level} ${segments.join(' ')} V${DESIGN_SIZE} H0 Z`;
}

/** 点到折线的最短距离。 */
function distanceToPolyline(px, py, points) {
  let best = Infinity;
  for (let i = 0; i < points.length - 1; i++) {
    const [ax, ay] = points[i];
    const [bx, by] = points[i + 1];
    const dx = bx - ax;
    const dy = by - ay;
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
    const ex = px - (ax + t * dx);
    const ey = py - (ay + t * dy);
    const d = ex * ex + ey * ey;
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}

/** 圆角矩形的有符号距离,内部为负。 */
function roundedRectSdf(px, py, size, radius) {
  const qx = Math.abs(px - size / 2) - size / 2 + radius;
  const qy = Math.abs(py - size / 2) - size / 2 + radius;
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  return outside + Math.min(Math.max(qx, qy), 0) - radius;
}

// ────────────────────────────────────────────────────────────────
// 光栅化
// ────────────────────────────────────────────────────────────────

/** 把有符号距离(目标像素单位)转成 0..1 的覆盖率,实现 1px 抗锯齿。 */
function coverage(signedDistance) {
  return Math.max(0, Math.min(1, 0.5 - signedDistance));
}

/** 渲染一张 RGBA 图,返回 Buffer(自上而下,行内 RGBA)。 */
function renderIcon(size) {
  const geometry = size <= SMALL_ICON_MAX ? SMALL : FULL;
  const scale = size / DESIGN_SIZE;
  const promptHalf = geometry.prompt.width / 2;
  const bg = rgb(BG_COLOR);
  const promptRgb = rgb(PROMPT_COLOR);
  const waterRgb = rgb(WATER_COLOR);
  const buf = Buffer.alloc(size * size * 4);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const gx = (x + 0.5) / scale;
      const gy = (y + 0.5) / scale;
      const bgCoverage = coverage(roundedRectSdf(gx, gy, DESIGN_SIZE, CORNER_RADIUS) * scale);
      if (bgCoverage === 0) continue;

      const promptCoverage = coverage(
        (distanceToPolyline(gx, gy, geometry.prompt.points) - promptHalf) * scale,
      );
      const waterCoverage = coverage((waterEdge(geometry.water, gx) - gy) * scale);

      const color = bg.slice();
      for (let c = 0; c < 3; c++) {
        color[c] = color[c] * (1 - waterCoverage) + waterRgb[c] * waterCoverage;
        color[c] = color[c] * (1 - promptCoverage) + promptRgb[c] * promptCoverage;
      }
      const i = (y * size + x) * 4;
      buf[i] = Math.round(color[0]);
      buf[i + 1] = Math.round(color[1]);
      buf[i + 2] = Math.round(color[2]);
      buf[i + 3] = Math.round(bgCoverage * 255);
    }
  }
  return buf;
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
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
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

function buildSvg() {
  const points = FULL.prompt.points.map((p) => p.join(',')).join(' ');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${DESIGN_SIZE} ${DESIGN_SIZE}" width="${DESIGN_SIZE}" height="${DESIGN_SIZE}">
  <!-- 由 scripts/generate-icon.cjs 生成,不要手改。海青底 + ">" 提示符 + 水面。 -->
  <defs>
    <clipPath id="tile"><rect width="${DESIGN_SIZE}" height="${DESIGN_SIZE}" rx="${CORNER_RADIUS}"/></clipPath>
  </defs>
  <g clip-path="url(#tile)">
    <rect width="${DESIGN_SIZE}" height="${DESIGN_SIZE}" fill="${BG_COLOR}"/>
    <path d="${waterToSvgPath(FULL.water)}" fill="${WATER_COLOR}"/>
    <polyline points="${points}" fill="none" stroke="${PROMPT_COLOR}" stroke-width="${FULL.prompt.width}" stroke-linecap="round" stroke-linejoin="round"/>
  </g>
</svg>
`;
}

function write(file, data) {
  fs.writeFileSync(file, data);
  console.log(`[generate-icon] wrote ${path.relative(ROOT, file)} (${data.length} bytes)`);
}

function main() {
  const ico = encodeIco(
    ICO_SIZES.map((size) => {
      const rgba = renderIcon(size);
      return { size, data: size === 256 ? encodePng(rgba, size) : encodeDib(rgba, size) };
    }),
  );
  const nativePng = encodePng(renderIcon(NATIVE_PNG_SIZE), NATIVE_PNG_SIZE);

  write(path.join(BUILD_DIR, 'icon.svg'), buildSvg());
  write(path.join(BUILD_DIR, 'icon.png'), encodePng(renderIcon(PNG_SIZE), PNG_SIZE));
  write(path.join(BUILD_DIR, 'icon.ico'), ico);
  write(path.join(NATIVE_ASSETS, 'menu-icon.ico'), ico);
  for (const name of ['Square150x150Logo.png', 'Square44x44Logo.png', 'StoreLogo.png']) {
    write(path.join(NATIVE_ASSETS, name), nativePng);
  }
}

main();
