/**
 * @file src/main/ipc-sender.test.ts
 * @purpose 守护 IPC 来源判断:拿到 IPC 的页面可以运行命令,所以这里只能放行应用页面。
 */
import { describe, expect, it } from 'vitest';
import { isAppPageUrl } from './ipc-sender';

const APP = 'file:///C:/Program%20Files/Marina/resources/app.asar/out/renderer/index.html';
const DEV = 'http://127.0.0.1:5173';

describe('isAppPageUrl', () => {
  it('放行应用页面', () => {
    expect(isAppPageUrl(APP, APP, undefined)).toBe(true);
  });

  it('放行带 windowId 查询参数的地址', () => {
    expect(isAppPageUrl(`${APP}?windowId=1&number=1#a`, APP, undefined)).toBe(true);
  });

  it('盘符大小写和中文路径编码不影响判断', () => {
    const encoded = 'file:///C:/%E6%A1%8C%E9%9D%A2/out/renderer/index.html';
    expect(isAppPageUrl('file:///c:/桌面/out/renderer/index.html', encoded, undefined)).toBe(true);
  });

  it('dev 模式放行 Vite 同源页面', () => {
    expect(isAppPageUrl(`${DEV}/?windowId=1`, APP, DEV)).toBe(true);
  });

  it.each([
    'http://127.0.0.1:18765/link-click',
    'https://example.com/renderer/index.html',
    'file:///C:/Users/x/Downloads/evil.html',
    'file:///C:/Users/x/Downloads/evil/out/renderer/index.html',
    'file://attacker-host/C:/Program%20Files/Marina/resources/app.asar/out/renderer/index.html',
    'data:text/html,<script>1</script>',
    'blob:file:///3d63e291-25c2-47be-8f01-db885b24aed2',
    'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html',
    'about:blank',
    '',
  ])('拒绝 %s', (url) => {
    expect(isAppPageUrl(url, APP, undefined)).toBe(false);
  });

  it.each([
    'http://127.0.0.1:18765/x',
    'http://127.0.0.1:51730/evil',
    'http://127.0.0.1:5173@evil.example/',
  ])('dev 模式下拒绝 %s', (url) => {
    expect(isAppPageUrl(url, APP, DEV)).toBe(false);
  });
});
