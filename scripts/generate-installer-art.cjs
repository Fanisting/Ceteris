/**
 * @file scripts/generate-installer-art.cjs
 * @purpose Draws the installer's sidebar and header in the app's Material colours, and writes
 *   them as the 24 bit BMP files NSIS requires.
 *
 * Rerun after a change, with Electron rather than Node, because it draws with Chromium:
 *   node_modules/electron/dist/electron.exe scripts/generate-installer-art.cjs
 *
 * Twice the size NSIS asks for (164x314, 150x57), so the art stays sharp on a scaled display.
 * NSIS shrinks it to fit. Colours match the Material tokens in material.css.
 */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const OUT = path.join(__dirname, '..', 'build');
const PRIMARY = '#006a6a';
const PRIMARY_CONTAINER = '#80d5d4';
const SIGNATURE = "'Segoe Script', 'Ink Free', cursive";

const page = (w, h, body) => `<!doctype html><html><body style="margin:0;width:${w}px;height:${h}px;overflow:hidden">${body}</body></html>`;

const sidebar = page(328, 628, `
  <div style="position:relative;width:328px;height:628px;overflow:hidden;background:${PRIMARY}">
    <div style="position:absolute;right:-110px;top:-70px;width:320px;height:320px;border-radius:50%;background:${PRIMARY_CONTAINER};opacity:.16"></div>
    <div style="position:absolute;left:-90px;bottom:-110px;width:300px;height:300px;border-radius:50%;background:${PRIMARY_CONTAINER};opacity:.12"></div>
    <div style="position:absolute;left:0;right:0;top:250px;text-align:center;color:#fff;font:italic 52px ${SIGNATURE};transform:rotate(-3deg)">Ceteris</div>
    <svg style="position:absolute;left:44px;top:330px" width="240" height="22" viewBox="0 0 240 22" fill="none">
      <path d="M6 15C58 7 128 3 234 7C176 9 118 12 78 19" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
  </div>`);

const header = page(300, 114, `
  <div style="position:relative;width:300px;height:114px;overflow:hidden;background:#fff">
    <div style="position:absolute;right:-40px;top:-70px;width:190px;height:190px;border-radius:50%;background:${PRIMARY_CONTAINER};opacity:.35"></div>
    <div style="position:absolute;right:22px;top:26px;color:${PRIMARY};font:italic 38px ${SIGNATURE};transform:rotate(-3deg)">Ceteris</div>
  </div>`);

/** Writes BGRA pixels as a bottom up 24 bit BMP, the only form NSIS reads reliably. */
function writeBmp(file, bgra, width, height) {
  const rowSize = Math.ceil((width * 3) / 4) * 4;
  const size = 54 + rowSize * height;
  const out = Buffer.alloc(size);
  out.write('BM', 0, 'ascii');
  out.writeUInt32LE(size, 2);
  out.writeUInt32LE(54, 10);
  out.writeUInt32LE(40, 14);
  out.writeInt32LE(width, 18);
  out.writeInt32LE(height, 22);
  out.writeUInt16LE(1, 26);
  out.writeUInt16LE(24, 28);
  out.writeUInt32LE(rowSize * height, 34);
  for (let y = 0; y < height; y += 1) {
    const row = 54 + (height - 1 - y) * rowSize;
    for (let x = 0; x < width; x += 1) {
      const from = (y * width + x) * 4;
      bgra.copy(out, row + x * 3, from, from + 3);
    }
  }
  fs.writeFileSync(file, out);
}

async function draw(html, width, height, name) {
  const win = new BrowserWindow({
    show: false,
    width,
    height,
    useContentSize: true,
    frame: false,
    webPreferences: { offscreen: true },
  });
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  await new Promise((resolve) => setTimeout(resolve, 500));
  const image = (await win.webContents.capturePage()).resize({ width, height });
  writeBmp(path.join(OUT, `${name}.bmp`), image.toBitmap(), width, height);
  fs.writeFileSync(path.join(process.env.ART_PREVIEW_DIR ?? OUT, `${name}.preview.png`), image.toPNG());
  win.destroy();
}

// Each image closes its window, and the app must outlive that to draw the next one.
app.on('window-all-closed', () => {});
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.whenReady().then(async () => {
  await draw(sidebar, 328, 628, 'installer-sidebar');
  await draw(header, 300, 114, 'installer-header');
  app.quit();
});
