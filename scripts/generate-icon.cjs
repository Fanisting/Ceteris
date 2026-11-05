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
 * @设计: 海青色块 + 白色 ">" 提示符 + 浅青波浪。提示符表明这是终端,波浪取
 *   marina(港湾)的意象。配色取自 Marina Material 主题的种子色 #006a6a。
 *
 * @关键设计:
 * - 不依赖任何 npm 包(AGENTS.md 1.2 边界 2):用 SDF 算覆盖率实现抗锯齿,
 *   内置最小 PNG / ICO 编码器。
 * - 24px 及以下换用 SMALL 几何。大图的波浪振幅缩到 16px 只剩不到 1px,
 *   线条会糊成一条直线,所以小尺寸加粗并减少波峰数量。
 * - ICO 里小于 256 的帧用 DIB,256 帧用 PNG。NSIS 与部分 Windows Shell 路径
 *   对 PNG 帧的小尺寸支持不可靠,这是 Windows 图标的传统布局。
 *
 * @同步点: 改几何或配色时,同步 src/renderer/components/icons.tsx 的 MarinaMark
 *   和 src/main/tray.ts 的像素图。
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
const BG_TOP = '#007a79';
const BG_BOTTOM = '#005353';
const PROMPT_COLOR = '#ffffff';
const WAVE_COLOR = '#9cf1f0';

const FULL = {
  prompt: { points: [[66, 54], [122, 96], [66, 138]], width: 28 },
  wave: { start: [62, 192], segmentLength: 33, control: 24, segments: 4, width: 20 },
};

const SMALL = {
  prompt: { points: [[64, 40], [124, 88], [64, 136]], width: 40 },
  wave: { start: [62, 206], segmentLength: 66, control: 30, segments: 2, width: 30 },
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

/** 波浪是上下交替的二次贝塞尔,展平成折线用于距离计算。 */
function flattenWave(wave) {
  const points = [wave.start];
  let [x, y] = wave.start;
  for (let s = 0; s < wave.segments; s++) {
    const sign = s % 2 === 0 ? -1 : 1;
    const x0 = x;
    const cx = x + wave.segmentLength / 2;
    const cy = y + sign * wave.control;
    const x1 = x + wave.segmentLength;
    for (let i = 1; i <= 16; i++) {
      const t = i / 16;
      const u = 1 - t;
      points.push([u * u * x0 + 2 * u * t * cx + t * t * x1, u * u * y + 2 * u * t * cy + t * t * y]);
    }
    x = x1;
  }
  return points;
}

function waveToSvgPath(wave) {
  const half = wave.segmentLength / 2;
  const segments = [];
  for (let s = 0; s < wave.segments; s++) {
    const sign = s % 2 === 0 ? -1 : 1;
    segments.push(`q${half} ${sign * wave.control} ${wave.segmentLength} 0`);
  }
  return `M${wave.start[0]} ${wave.start[1]} ${segments.join(' ')}`;
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
  const wavePoints = flattenWave(geometry.wave);
  const promptHalf = geometry.prompt.width / 2;
  const waveHalf = geometry.wave.width / 2;
  const top = rgb(BG_TOP);
  const bottom = rgb(BG_BOTTOM);
  const promptRgb = rgb(PROMPT_COLOR);
  const waveRgb = rgb(WAVE_COLOR);
  const buf = Buffer.alloc(size * size * 4);

  for (let y = 0; y < size; y++) {
    const v = size === 1 ? 0 : y / (size - 1);
    const bg = top.map((c, i) => c * (1 - v) + bottom[i] * v);
    for (let x = 0; x < size; x++) {
      const gx = (x + 0.5) / scale;
      const gy = (y + 0.5) / scale;
      const bgCoverage = coverage(roundedRectSdf(gx, gy, DESIGN_SIZE, CORNER_RADIUS) * scale);
      if (bgCoverage === 0) continue;

      const promptCoverage = coverage(
        (distanceToPolyline(gx, gy, geometry.prompt.points) - promptHalf) * scale,
      );
      const waveCoverage = coverage((distanceToPolyline(gx, gy, wavePoints) - waveHalf) * scale);

      const color = bg.slice();
      for (let c = 0; c < 3; c++) {
        color[c] = color[c] * (1 - waveCoverage) + waveRgb[c] * waveCoverage;
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
  <!-- 由 scripts/generate-icon.cjs 生成,不要手改。海青底 + ">" 提示符 + 波浪。 -->
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${BG_TOP}"/>
      <stop offset="100%" stop-color="${BG_BOTTOM}"/>
    </linearGradient>
  </defs>
  <rect width="${DESIGN_SIZE}" height="${DESIGN_SIZE}" rx="${CORNER_RADIUS}" ry="${CORNER_RADIUS}" fill="url(#bg)"/>
  <g fill="none" stroke-linecap="round" stroke-linejoin="round">
    <path d="${waveToSvgPath(FULL.wave)}" stroke="${WAVE_COLOR}" stroke-width="${FULL.wave.width}"/>
    <polyline points="${points}" stroke="${PROMPT_COLOR}" stroke-width="${FULL.prompt.width}"/>
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
