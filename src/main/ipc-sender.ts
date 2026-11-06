/**
 * @file src/main/ipc-sender.ts
 * @purpose 判断一条 IPC 是否来自 Ceteris 自己的页面。
 *
 * @关键设计:
 * - 这是第二道防线。第一道是 window-manager.ts 的 will-navigate:外部页面本就不该
 *   进入窗口。但 preload 在导航后依然生效,所以万一还有别的路径让窗口离开了应用
 *   页面 (比如 PDF 里的链接),这里保证那个页面调不到任何主进程命令。
 * - 比较完整的页面路径,不是只看 file: 协议或文件名:磁盘上任意一个 html 也是
 *   file:,路径结尾相同的页面也可以放在 Downloads 里。
 * - 只比较路径,不比较 query:窗口地址带 ?windowId=...。
 *
 * @对应文档章节: 软件定义书.md 14.9
 *
 * @不要在这里做的事:
 * - 不要放宽成"未知来源也放行",拿到 IPC 的页面可以创建模板并运行命令
 */

function parse(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/** Windows 盘符大小写不固定,路径里的非 ASCII 字符可能编码也可能不编码。 */
function comparablePath(url: URL): string {
  return decodeURIComponent(url.pathname).toLowerCase();
}

/**
 * @param url 发送方 frame 的 URL
 * @param appPageUrl 打包页面的 file: URL
 * @param devServerUrl dev 模式下的 Vite 地址,打包后没有
 */
export function isAppPageUrl(
  url: string,
  appPageUrl: string,
  devServerUrl: string | undefined,
): boolean {
  const sender = parse(url);
  if (!sender) return false;
  const dev = devServerUrl ? parse(devServerUrl) : null;
  if (dev && sender.origin === dev.origin) return true;
  const app = parse(appPageUrl);
  return (
    app !== null &&
    sender.protocol === 'file:' &&
    sender.host === '' &&
    comparablePath(sender) === comparablePath(app)
  );
}
