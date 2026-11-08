/**
 * @file src/main/window-manager.ts
 * @purpose 管理所有 BrowserWindow 实例的创建、销毁、编号分配、聚焦。
 *   维护 windowId ↔ BrowserWindow 的映射,响应"新开窗口 / 关闭所有窗口 /
 *   聚焦某窗口"等命令。
 *
 * @关键设计:
 * - windowId 用 UUID v4,持久且不复用
 * - 窗口编号 (Window 1, Window 2, ...) 单调递增,关闭后不复用
 *   (软件定义书 6.7 节;每次应用启动从 1 重新开始,运行时分配,不持久化)
 * - 通过 query string ?windowId=... 把 ID 传给 Renderer (ipc-protocol 2.2)
 * - 维护"最近活动"窗口指针,用于托盘单击聚焦 (软件定义书 6.5.2)
 * - 监听 BrowserWindow 的 'closed' 事件自动清理映射,renderer 进程退出
 *   是异步的,清理必须惰性 (Electron 内部经验)
 *
 * @对应文档章节: 软件定义书.md 6.7、9.2、9.3 节;ipc-protocol.md 2.2 节
 *
 * @不要在这里做的事:
 * - 不要管理 session 的 owner 关系 (那是 PtyController/SessionManager 的职责)
 * - 不要存储窗口的视图状态如选中路径 — 那是 Renderer 私有,Main 不存
 * - 不要创建 Tray (那是 TrayManager)
 *
 * @CP-1 状态:
 * 完整实现 createWindow / closeWindow / list / focus / getById /
 * getByElectronId / getMostRecentlyActive。
 * CP-1 还不需要 session-window 的关系管理,该功能在 CP-3 加入。
 */
import { BrowserWindow, screen, shell } from 'electron';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { WindowInfo } from '@shared/types';
import { logger } from './logger';

const __dirname = dirname(fileURLToPath(import.meta.url));

const isDev = !!process.env.ELECTRON_RENDERER_URL;

/**
 * 窗口数硬上限 (ipc-protocol.md 5.1, MaxWindowsReached 错误码)。
 * V1 设 20,合理上限避免误操作把内存爆满。
 */
const MAX_WINDOWS = 20;

interface ManagedWindow {
  info: WindowInfo;
  electronWindow: BrowserWindow;
  /** 该窗口最后一次获得焦点的时间戳,用于"最近活动"排序 */
  lastFocusedAt: number;
}

/**
 * Ceteris Link:虚拟窗口的 electronWindowId 占位值。
 *
 * 虚拟窗口没有 BrowserWindow,自然也没有 webContents.id。用 -1 是因为
 * Electron 的 webContents.id 恒为正整数,不会与真实窗口碰撞;
 * getByElectronId 的线性查找因此永远不会误命中虚拟窗口。
 */
export const VIRTUAL_WINDOW_ELECTRON_ID = -1;

/**
 * Ceteris Link(Host 侧):一个远程客户端在本机 WindowManager 里的表示。
 *
 * @关键设计:
 * 把远程客户端注册成"虚拟窗口"是整个 Link 特性的支点。有了它,
 * session ownership、事件广播、owner-only 的字节流路由**全都不需要为
 * 远程情况写特例分支** —— 远程客户端在 Host 眼里就是又一个窗口,走的
 * 是与本地窗口完全相同的代码路径。
 *
 * 对应地,虚拟窗口不能做的事:
 * - 不能被 focus(它不在本机屏幕上,focus 是 no-op)
 * - 不能被 minimize / maximize
 * - 不是 getMostRecentlyActive 的候选(托盘单击不该"聚焦"一个远程客户端)
 */
interface ManagedVirtualWindow {
  info: WindowInfo;
  /**
   * 把一条事件送给该远程客户端。由 LinkServer 在注册时注入,内部实现是
   * "序列化 → 加密 → socket.write"。
   *
   * 约定:实现方必须自己吞掉写失败(socket 已断等),不能向上抛 —— 事件
   * 广播是 fire-and-forget,一个客户端断开不能影响其他窗口收事件。
   */
  send: (channel: string, envelope: unknown) => void;
}

/** 创建窗口时的可选初始 bounds (来自 settings.windowDefaults — M1-G)。 */
export interface CreateWindowOptions {
  initialBounds?: {
    width: number;
    height: number;
    x?: number;
    y?: number;
    maximized?: boolean;
  };
  /** 关窗前调,把当前 bounds 写回 settings (M1-G)。 */
  onBeforeClose?: (bounds: {
    width: number;
    height: number;
    x: number;
    y: number;
    maximized: boolean;
  }) => void;
  /**
   * BETA-027:Explorer 简易模式入口 — 注入 query mode=simple,renderer 在
   * startup 时 dispatch view/set-simple-mode,首次渲染就跳过 Sidebar/Tab bar。
   */
  simpleMode?: boolean;
  /**
   * 右键 Tab → "在新窗口中打开":新窗口启动后从 URL ?selectSessionId 读到
   * 目标 session,自动 dispatch view/focus-requested 切到该 session。ownership
   * 由调用方在创建窗口前后通过 SessionManager.claimOwner 完成,这里只负责
   * 把 hint 透传到 renderer 启动阶段。
   */
  selectSessionId?: string;
  /**
   * Ceteris Link(Client 侧):强制使用指定的 windowId,而不是新生成一个 UUID。
   *
   * 远程窗口必须用 Host 分配的虚拟 windowId 作为自己的身份,原因见
   * LinkAuth.preferredWindowId 的注释:renderer 用 `window.api.windowId` 与
   * `session.ownerWindowId` 比对来判断"这个终端归不归我"。本地窗口若用本地
   * UUID,这个比对永远不成立,侧栏会把所有远程终端显示成"其他窗口持有"。
   *
   * 只有 LinkClient 会传这个字段;普通开窗路径一律不传。
   */
  forcedWindowId?: string;
  /**
   * Do not show the window when its page is ready. Remote views use this: the
   * ViewSwitcher decides when they appear, in place of the current window.
   */
  startHidden?: boolean;
}

export interface IWindowManager {
  createWindow(options?: CreateWindowOptions): WindowInfo;
  closeWindow(windowId: string): boolean;
  list(): WindowInfo[];
  focus(windowId: string): boolean;
  getById(windowId: string): BrowserWindow | null;
  getByElectronId(electronId: number): BrowserWindow | null;
  getMostRecentlyActive(): BrowserWindow | null;
  count(): number;
}

export class WindowManager implements IWindowManager {
  private readonly windows = new Map<string, ManagedWindow>();

  /**
   * Ceteris Link(Host 侧):远程客户端注册成的虚拟窗口。
   * 与 this.windows 共用同一个 windowId 命名空间(都是 UUID),两者的 key
   * 不会碰撞。
   */
  private readonly virtualWindows = new Map<string, ManagedVirtualWindow>();

  /**
   * Ceteris Link(Client 侧):本机哪些真实窗口是"远程窗口"。
   *
   * 远程窗口的 renderer 展示的是**远端** Host 的数据,因此本机守护进程的
   * 事件广播必须跳过它们 —— 否则本机的 path 树、session 列表会与远端数据
   * 混在一起,renderer 的 store 会被两份互不相干的状态来回覆盖。
   *
   * 存 windowId → 该窗口绑定的 Host 连接 id。
   */
  private readonly remoteBoundWindows = new Map<string, string>();
  /**
   * 下一个窗口编号。从 1 开始单调递增,关闭后不复用 (软件定义书 6.7)。
   * 每次应用启动从 1 重新开始,不持久化。
   */
  private nextWindowNumber = 1;
  /**
   * 窗口创建时的 listener 钩子,允许调用者在创建后插入额外逻辑
   * (例如 PtyController 在窗口创建时 spawn PTY)。
   */
  private onCreatedHandlers: Array<(info: WindowInfo, win: BrowserWindow) => void> = [];
  private onClosedHandlers: Array<(windowId: string) => void> = [];

  /**
   * BETA-003b · ADR-013:close 事件拦截器。在窗口 close 事件触发时,询问拦截器
   * "本次是否应该弹 modal 并阻止关闭"。返回 true 表示已拦截(已发 IPC 让 renderer
   * 弹 modal),WindowManager 调 preventDefault();返回 false 表示放行。
   *
   * Linux 上 index.ts 注入的实现:仅在 lifecycleModel === 'no-persistence' +
   * 这是最后一个窗口 + 还有 alive session 时返回 true。
   *
   * Windows / macOS 也复用同一机制(将来托盘"完全退出"按钮 / Cmd+Q 进入退出
   * 流程时,也通过同一 modal 走二次确认),目前 Windows 仍走 isQuitting 直退。
   */
  private closeInterceptor: ((win: BrowserWindow) => boolean) | null = null;

  /** 一次性注入 close 拦截器(BETA-003b)。 */
  setCloseInterceptor(interceptor: ((win: BrowserWindow) => boolean) | null): void {
    this.closeInterceptor = interceptor;
  }

  /**
   * 新开一个窗口。
   *
   * @throws Error('MaxWindowsReached') 已达 V1 上限 (20 个窗口)
   *
   * @M1-A: frame:false + 自绘标题栏 (含 macOS / Windows 两套布局,由 renderer 端
   *   读 settings.appearance.windowStyle 决定)。Electron 默认 application menu 由
   *   index.ts 端 Menu.setApplicationMenu(null) 全局禁。
   * @M1-G: 接受 options.initialBounds 作为初始位置 / 尺寸 (来自 settings.windowDefaults),
   *   close 前通过 onBeforeClose 回调把最终 bounds 写回。
   */
  createWindow(options: CreateWindowOptions = {}): WindowInfo {
    if (this.windows.size >= MAX_WINDOWS) {
      throw new Error(
        `[WindowManager] MaxWindowsReached: 已达窗口数上限 ${MAX_WINDOWS}。` +
          `先关闭一些窗口再继续。`,
      );
    }

    const windowId = options.forcedWindowId ?? randomUUID();
    if (options.forcedWindowId && this.windows.has(options.forcedWindowId)) {
      throw new Error(
        `[WindowManager] createWindow: forcedWindowId="${options.forcedWindowId}" 已存在。` +
          `可能原因:同一条 Link 连接重复创建了窗口。` +
          `建议:检查 LinkClient 是否在重连时漏掉了"窗口已存在则复用"的分支。`,
      );
    }
    const windowNumber = this.nextWindowNumber++;

    // 解析初始 bounds,做多显示器越界校验 (M1-G):若上次 bounds 已超出现在可用屏幕区
    // (例如外接显示器拔了),回退到主屏幕居中。
    const initial = options.initialBounds;
    const resolved = resolveInitialBounds(initial);

    const win = new BrowserWindow({
      width: resolved.width,
      height: resolved.height,
      ...(resolved.x !== undefined ? { x: resolved.x } : {}),
      ...(resolved.y !== undefined ? { y: resolved.y } : {}),
      minWidth: 600,
      minHeight: 400,
      show: false,
      title: `Ceteris — Window ${windowNumber}`,
      // 历史:BETA-003b 曾在 Linux 上启用 transparent:true 让 CSS 画圆角
      // (Linux 没有 Windows 11 DWM 的系统级 frameless 圆角)。但 transparent
      // + Wayland (Ubuntu 22.04 GNOME 默认 session) 触发严重 resize bug —
      // Chromium 内层 viewport 计算异常,container.clientWidth 卡在初始值,
      // fitAddon.fit() 永远算出错误 cols,xterm + PTY 都跟不上窗口拖动,
      // 用户体感"resize 完全不能用"。已知 electron#28632 等 issue。
      // 修复(BETA-003c):放弃 Linux 圆角,换回 resize 正常工作。Linux 用户
      // 看到方角窗口,这与 gnome-terminal / wezterm 等所有主流 Linux 终端
      // 一致;CSS 端配合 <html data-platform='linux'> 在 .app-root 上去掉
      // border-radius 避免内部出现 #191724 实色边角。
      // 与默认主题 light-pink 的外壳底色一致,避免首帧闪出其它颜色
      backgroundColor: '#f5f0f3',
      transparent: false,
      // M1-A:自绘标题栏。frame:false 把整条 OS 标题栏拿掉,renderer 端用
      // -webkit-app-region:drag 实现拖动,用 cmd:window:* 实现按钮动作。
      frame: false,
      webPreferences: {
        preload: resolve(__dirname, '../preload/index.mjs'),
        contextIsolation: true,
        nodeIntegration: false,
        // SEC-1 回退(2026-05-14):sandbox 暂留 false。
        //
        // SEC-1(4d245f7)曾尝试启用 sandbox=true,但运行时 preload 立刻
        // 报 "Cannot use import statement outside a module" — Electron
        // sandboxed preload 只支持 CommonJS,而当前 electron-vite 把
        // preload 打成 ESM(index.mjs)。这不是 node API 依赖问题,而是
        // preload 产物格式问题。
        //
        // 后续重启 SEC-1 的正路:让 preload rollup 输出 cjs 格式 + 改这里
        // 的 preload 路径为 index.js。当前 preload 源码没有 top-level
        // await 等纯 ESM 特性,转 CJS 没有阻塞。
        sandbox: false,
      },
    });

    if (resolved.maximized) {
      win.maximize();
    }

    const info: WindowInfo = {
      id: windowId,
      number: windowNumber,
      electronWindowId: win.webContents.id,
    };

    const managed: ManagedWindow = {
      info,
      electronWindow: win,
      lastFocusedAt: Date.now(),
    };
    this.windows.set(windowId, managed);

    win.on('focus', () => {
      managed.lastFocusedAt = Date.now();
    });

    // M1-A:把 maximize 状态变化通过 IPC 事件推给 renderer,renderer 据此切
    // "最大化 / 还原" 按钮图标 + 窗口外圆角(最大化时无圆角)。
    const sendMaxState = (): void => {
      if (win.isDestroyed()) return;
      win.webContents.send('evt:window:max-state-changed', {
        eventId: randomUUID(),
        timestamp: Date.now(),
        payload: { maximized: win.isMaximized() },
      });
    };
    win.on('maximize', sendMaxState);
    win.on('unmaximize', sendMaxState);
    // ready-to-show 后也发一次,renderer 初始就知道状态
    win.once('ready-to-show', () => {
      sendMaxState();
    });

    // M1-G:窗口关闭前把当前 bounds 写回 settings (经 onBeforeClose 回调)。
    // 注意 'close' 在 'closed' 之前;'closed' 时 win 已销毁拿不到 bounds。
    win.on('close', (event) => {
      // BETA-003b · ADR-013:先问 closeInterceptor 是否要拦截。Linux 上"最后窗口
      // + 仍有 alive session"时,interceptor 内部已发 UI_SHOW_LAST_SESSION_CONFIRM
      // 给本窗口 renderer,返回 true 表示我们应 preventDefault。
      if (this.closeInterceptor) {
        try {
          if (this.closeInterceptor(win)) {
            event.preventDefault();
            return;
          }
        } catch (err) {
          logger.error('WindowManager', 'closeInterceptor threw', err);
        }
      }
      try {
        if (options.onBeforeClose && !win.isDestroyed()) {
          const b = win.getNormalBounds(); // 不含最大化时的扩展尺寸
          options.onBeforeClose({
            width: b.width,
            height: b.height,
            x: b.x,
            y: b.y,
            maximized: win.isMaximized(),
          });
        }
      } catch (err) {
        logger.warn('WindowManager', 'onBeforeClose save bounds failed', err);
      }
    });

    // 窗口关闭后清理映射。'closed' 在 webContents 销毁后触发,此时 win
    // 已经不可用,所以先取出 windowId 存到本地。
    win.on('closed', () => {
      this.windows.delete(windowId);
      for (const handler of this.onClosedHandlers) {
        try {
          handler(windowId);
        } catch (err) {
          // 一个 handler 出错不能影响其他 handler 或主流程
          logger.error('WindowManager', `onClosed handler threw for ${windowId}`, err);
        }
      }
    });

    win.once('ready-to-show', () => {
      if (!options.startHidden) win.show();
    });

    // F12 / Ctrl+Shift+I 切换 DevTools — dev / packed 都生效。
    // packed 应用没有 application menu (我们故意不设),所以 Chromium 不会
    // 自动绑定这个快捷键,需要在主进程主动拦截 webContents 输入事件。
    // 这是诊断 packed 模式蓝屏 / renderer 错误的唯一通道。
    win.webContents.on('before-input-event', (event, input) => {
      const isToggle =
        input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i');
      if (isToggle && input.type === 'keyDown') {
        win.webContents.toggleDevTools();
        event.preventDefault();
      }
    });

    // dev 模式从 Vite dev server 拉,build 后从本地文件加载
    // BETA-027:simpleMode=true 时附加 ?mode=simple,renderer 启动时一次性 dispatch
    const simpleFlag = options.simpleMode ? '&mode=simple' : '';
    const selectFlag = options.selectSessionId
      ? `&selectSessionId=${encodeURIComponent(options.selectSessionId)}`
      : '';
    const queryString = `?windowId=${encodeURIComponent(windowId)}&windowNumber=${windowNumber}${simpleFlag}${selectFlag}`;
    if (isDev && process.env.ELECTRON_RENDERER_URL) {
      void win.loadURL(process.env.ELECTRON_RENDERER_URL + queryString);
    } else {
      // packed 模式:用 pathToFileURL 显式构造 file:// URL,然后追加 query string
      // (loadFile + search 选项在 packed asar 里有 bug:query 会被当作路径一部分,
      //  生成 "index.html?windowId=..." 这种非法路径,触发
      //  "Not allowed to load local resource"。直接走 loadURL 是稳的)
      const indexPath = resolve(__dirname, '../renderer/index.html');
      const indexUrl = pathToFileURL(indexPath).toString() + queryString;
      void win.loadURL(indexUrl);
    }

    // EASYTERM_DEVTOOLS 环境变量:dev / packed 都支持。诊断启动期 renderer
    // 错误时,启动前 set EASYTERM_DEVTOOLS=always 即可让每个窗口自启 DevTools。
    //   first  → 只为第一个窗口自动开
    //   always → 每个窗口都自动开
    //   未设置 → 不自动开
    const devtoolsMode = process.env['EASYTERM_DEVTOOLS'];
    const isFirstWindow = windowNumber === 1;
    const shouldOpenDevTools =
      devtoolsMode === 'always' || (devtoolsMode === 'first' && isFirstWindow);
    if (shouldOpenDevTools) {
      win.webContents.openDevTools({ mode: 'detach' });
    }

    // CRA-1:renderer 进程崩溃自动 reload + 记录日志。
    //
    // 历史:监听器只 console.error,窗口看着像活的(最后一帧画面)但所有
    // 交互无反应,用户必须关掉窗口重开。
    //
    // 现在:reason 非 clean-exit(crashed/oom/killed/launch-failed/...)时
    // 主动 webContents.reload() — 拉回干净 renderer + handshake + IPC sync。
    // 用户感知"窗口闪一下重新加载",但所有 session(在 main 端)继续活,
    // PTY 不受影响,scrollback 通过 get-scrollback 重新拉到新 renderer。
    win.webContents.on('render-process-gone', (_e, details) => {
      logger.error(
        'WindowManager',
        `renderer process gone (window ${windowNumber}): reason=${details.reason} exitCode=${details.exitCode}`,
      );
      if (details.reason === 'clean-exit' || win.isDestroyed()) return;
      // 防御:reload 自身可能失败(罕见,通常 renderer 进程刚崩 reload
      // 立即拉一个新的);try/catch 保护避免主进程被异常终止。
      try {
        win.webContents.reload();
      } catch (err) {
        logger.error('WindowManager', `reload after crash failed (window ${windowNumber})`, err);
      }
    });
    win.webContents.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL) => {
      logger.error(
        'WindowManager',
        `did-fail-load (window ${windowNumber}): code=${errorCode} desc=${errorDescription} url=${validatedURL}`,
      );
    });
    win.webContents.on('preload-error', (_e, preloadPath, error) => {
      logger.error(
        'WindowManager',
        `preload-error (window ${windowNumber}): preload="${preloadPath}"`,
        error,
      );
    });

    // OSC-5 / SEC-4:WebLinksAddon + OSC 8 超链接的点击触发 window.open,
    // Electron 默认拦截。这里装 setWindowOpenHandler 把白名单协议路由到
    // shell.openExternal 用系统默认浏览器打开。
    //
    // 白名单:http / https / mailto。拒绝 file:// / javascript: / chrome: 等
    // 本地协议(防 OSC 8 注入打开本地文件 / 触发 webview 漏洞)。
    const openExternalIfAllowed = (url: string): void => {
      if (/^(https?|mailto):/i.test(url)) {
        void shell.openExternal(url);
      }
    };
    win.webContents.setWindowOpenHandler(({ url }) => {
      openExternalIfAllowed(url);
      return { action: 'deny' };
    });

    // 窗口永远只显示应用页面。PDF 查看器点链接走的是顶层导航,setWindowOpenHandler
    // 管不到,而 preload 导航后依然生效,外部页面会拿到 window.api。
    // 同地址放行是给 dev 模式的整页刷新。
    win.webContents.on('will-navigate', (event, url) => {
      if (url === win.webContents.getURL()) return;
      event.preventDefault();
      openExternalIfAllowed(url);
    });

    for (const handler of this.onCreatedHandlers) {
      try {
        handler(info, win);
      } catch (err) {
        logger.error('WindowManager', `onCreated handler threw for ${windowId}`, err);
      }
    }

    return info;
  }

  /**
   * 关闭指定窗口。返回 true 表示找到并触发关闭,false 表示窗口不存在。
   *
   * 不弹任何确认对话框 (软件定义书 7.4.1, AGENTS.md 哲学红线)。
   */
  closeWindow(windowId: string): boolean {
    const managed = this.windows.get(windowId);
    if (!managed) return false;
    managed.electronWindow.close();
    return true;
  }

  /**
   * 关闭所有窗口,进入纯托盘模式 (软件定义书 7.4.2)。
   * 注意 Map 在迭代时不能修改,先拷贝再遍历。
   */
  closeAll(): void {
    const all = [...this.windows.values()];
    for (const m of all) {
      m.electronWindow.close();
    }
  }

  /**
   * 所有窗口的简要信息,**包含** Ceteris Link 的虚拟窗口。
   *
   * 为什么虚拟窗口要出现在这个列表里:renderer 侧栏用 windows[] 判断某个
   * session 的 owner 是"本窗口 / 其他窗口 / 无主"。远程客户端持有的 session
   * 若不在列表里,本地窗口会把它误判成无主并尝试 claim,把远端用户正在用的
   * 终端抢走。
   */
  list(): WindowInfo[] {
    return [
      ...[...this.windows.values()].map((m) => ({ ...m.info })),
      ...[...this.virtualWindows.values()].map((m) => ({ ...m.info })),
    ];
  }

  /**
   * 窗口总数,**只算真实窗口**。
   *
   * 与 list() 的差异是刻意的:count() 的调用方是"是否还有窗口开着 →
   * 决定要不要进纯托盘模式 / 触发 app 生命周期"这类判断,而一个远程客户端
   * 连着并不意味着本机屏幕上有窗口。把虚拟窗口算进来会让本机永远进不了
   * 托盘模式。
   */
  count(): number {
    return this.windows.size;
  }

  focus(windowId: string): boolean {
    const managed = this.windows.get(windowId);
    if (!managed) return false;
    const win = managed.electronWindow;
    if (win.isMinimized()) win.restore();
    win.focus();
    managed.lastFocusedAt = Date.now();
    return true;
  }

  getById(windowId: string): BrowserWindow | null {
    return this.windows.get(windowId)?.electronWindow ?? null;
  }

  getByElectronId(electronId: number): BrowserWindow | null {
    for (const m of this.windows.values()) {
      if (m.info.electronWindowId === electronId) return m.electronWindow;
    }
    return null;
  }

  /**
   * 返回最近被聚焦过的窗口,用于托盘单击行为 (软件定义书 6.5.2)。
   * 无窗口时返回 null。
   */
  getMostRecentlyActive(): BrowserWindow | null {
    let best: ManagedWindow | null = null;
    // A view swapped out by the ViewSwitcher is hidden. Prefer what is on screen, or
    // tray and second-instance would focus a window the user cannot see.
    for (const m of this.windows.values()) {
      if (!best) {
        best = m;
        continue;
      }
      const visible = m.electronWindow.isVisible();
      const bestVisible = best.electronWindow.isVisible();
      if (visible !== bestVisible) {
        if (visible) best = m;
      } else if (m.lastFocusedAt > best.lastFocusedAt) {
        best = m;
      }
    }
    return best?.electronWindow ?? null;
  }

  /**
   * 注册回调:每次新窗口创建后立即触发。用于让 PtyController 等模块挂钩。
   */
  onWindowCreated(handler: (info: WindowInfo, win: BrowserWindow) => void): void {
    this.onCreatedHandlers.push(handler);
  }

  /**
   * M1-G:全局工厂注入。所有"新建窗口"入口(IPC `cmd:window:create`、托盘
   * "打开新窗口"等)都应走 setCreateOptionsProvider 提供的 options,这样
   * 持久化 bounds 等横切关注点不必散落到每个调用方。
   *
   * 不调 setCreateOptionsProvider 时 createWindow() 退化成默认行为。
   */
  private createOptionsProvider: (() => CreateWindowOptions) | null = null;
  setCreateOptionsProvider(provider: () => CreateWindowOptions): void {
    this.createOptionsProvider = provider;
  }

  /**
   * 工厂入口:使用 createOptionsProvider 提供的 options 创建窗口。
   * IPC / 托盘等"非首窗"创建路径应调这个,而不是直接 createWindow()。
   *
   * @param extraOpts BETA-027 起接受 { simpleMode } 等附加 opt,与 provider
   *   返回值合并(extraOpts 优先)。
   */
  createWindowFromFactory(extraOpts: Partial<CreateWindowOptions> = {}): WindowInfo {
    const opts = this.createOptionsProvider ? this.createOptionsProvider() : {};
    return this.createWindow({ ...opts, ...extraOpts });
  }

  /**
   * 取 createOptionsProvider 当前会给出的 options,但**不**创建窗口。
   *
   * Ceteris Link 的远程窗口需要在拿到 Host 分配的 windowId 之后才能创建,
   * 没法走 createWindowFromFactory(它不接受 forcedWindowId 以外的时序),
   * 所以这里把"取 options"单独暴露出来,保证远程窗口与本地窗口共用同一套
   * 尺寸 / 位置 / 关窗持久化策略。
   */
  getCreateOptions(): CreateWindowOptions {
    return this.createOptionsProvider ? this.createOptionsProvider() : {};
  }

  /**
   * 注册回调:每次窗口关闭后触发。
   */
  onWindowClosed(handler: (windowId: string) => void): void {
    this.onClosedHandlers.push(handler);
  }

  /**
   * M1-A:供 IPC 调用的窗口控制 — 最小化 / 切换最大化。
   * 失败静默(窗口已销毁 / 不存在);返回是否真触发了动作。
   */
  minimizeWindow(windowId: string): boolean {
    const m = this.windows.get(windowId);
    if (!m || m.electronWindow.isDestroyed()) return false;
    m.electronWindow.minimize();
    return true;
  }

  toggleMaximizeWindow(windowId: string): boolean {
    const m = this.windows.get(windowId);
    if (!m || m.electronWindow.isDestroyed()) return false;
    if (m.electronWindow.isMaximized()) m.electronWindow.unmaximize();
    else m.electronWindow.maximize();
    return true;
  }

  isMaximized(windowId: string): boolean {
    const m = this.windows.get(windowId);
    return !!m && !m.electronWindow.isDestroyed() && m.electronWindow.isMaximized();
  }

  // ────────────────────────────────────────────────────────────────
  // Ceteris Link:虚拟窗口(Host 侧)与远程绑定窗口(Client 侧)
  // ────────────────────────────────────────────────────────────────

  /**
   * Host 侧:把一个远程客户端注册成虚拟窗口。
   *
   * 注册后该 windowId 就是 WindowManager 命名空间里的一等公民:可以持有
   * session ownership、出现在 list() 里、收到广播事件。
   *
   * @param send 事件投递函数,由 LinkServer 注入(序列化 → 加密 → socket)
   * @returns 分配的 WindowInfo(windowId 与窗口编号)
   *
   * @throws Error('MaxWindowsReached') 真实窗口 + 虚拟窗口已达上限
   *
   * @副作用:
   * - 触发 onWindowCreated handlers,于是 evt:window:list-updated 会广播出去,
   *   本地窗口的侧栏立刻看到多了一个窗口
   */
  registerVirtualWindow(
    send: (channel: string, envelope: unknown) => void,
    preferredWindowId?: string,
  ): WindowInfo {
    if (this.windows.size + this.virtualWindows.size >= MAX_WINDOWS) {
      throw new Error(
        `[WindowManager] MaxWindowsReached: 真实窗口 ${this.windows.size} + ` +
          `虚拟窗口 ${this.virtualWindows.size} 已达上限 ${MAX_WINDOWS}。` +
          `可能原因:(1) 本机开了太多窗口;(2) 远程客户端反复重连但旧连接未被清理。` +
          `建议:检查设置 → 远程访问里的已连接客户端列表。`,
      );
    }

    // 只有当 preferredWindowId 当前**既不是**真实窗口也不是虚拟窗口时才复用。
    // 这条校验是安全边界:否则一个恶意客户端可以指定 Host 某个本地窗口的 id
    // 来冒充它,进而 claim / release 该窗口正在用的 session。
    const canReuse =
      !!preferredWindowId &&
      !this.windows.has(preferredWindowId) &&
      !this.virtualWindows.has(preferredWindowId);
    if (preferredWindowId && !canReuse) {
      logger.warn(
        'WindowManager',
        `registerVirtualWindow: 拒绝复用 windowId=${preferredWindowId}(该 id 已被占用),改为新分配`,
      );
    }

    const windowId = canReuse ? preferredWindowId! : randomUUID();
    const windowNumber = this.nextWindowNumber++;
    const info: WindowInfo = {
      id: windowId,
      number: windowNumber,
      electronWindowId: VIRTUAL_WINDOW_ELECTRON_ID,
    };

    this.virtualWindows.set(windowId, { info, send });
    logger.info(
      'WindowManager',
      `registerVirtualWindow: windowId=${windowId} number=${windowNumber} ` +
        `(real=${this.windows.size} virtual=${this.virtualWindows.size})`,
    );

    for (const handler of this.onCreatedHandlers) {
      try {
        // 虚拟窗口没有 BrowserWindow。现有 onCreated handler(tray 重建、
        // 事件广播)都不解引用第二个参数,但为类型安全仍需传值 —— 这里
        // 传 null 并断言,是这条路径唯一的妥协点。若将来有 handler 真的
        // 需要 BrowserWindow,应改用 registerVirtualWindow 专属的回调列表。
        handler(info, null as unknown as BrowserWindow);
      } catch (err) {
        logger.error(
          'WindowManager',
          `onCreated handler threw for virtual window ${windowId}`,
          err,
        );
      }
    }

    return info;
  }

  /**
   * Host 侧:注销一个虚拟窗口(远程客户端断开)。
   *
   * @returns 是否确实存在并被移除
   *
   * @副作用:
   * - 触发 onWindowClosed handlers。这一步很关键:ipc.ts 注册的 handler 会调
   *   sessionManager.handleWindowClosed(windowId),把该客户端持有的所有 session
   *   转为无主。于是远程用户断线后,Host 本机的窗口可以立刻接管这些终端,
   *   agent 一直在跑,什么都没丢。
   */
  unregisterVirtualWindow(windowId: string): boolean {
    if (!this.virtualWindows.delete(windowId)) return false;
    logger.info('WindowManager', `unregisterVirtualWindow: windowId=${windowId}`);
    for (const handler of this.onClosedHandlers) {
      try {
        handler(windowId);
      } catch (err) {
        logger.error('WindowManager', `onClosed handler threw for virtual window ${windowId}`, err);
      }
    }
    return true;
  }

  /** 该 windowId 是否是一个远程客户端的虚拟窗口。 */
  isVirtualWindow(windowId: string): boolean {
    return this.virtualWindows.has(windowId);
  }

  /** 当前已注册的虚拟窗口数(供设置页显示与上限判断)。 */
  virtualCount(): number {
    return this.virtualWindows.size;
  }

  /**
   * Client 侧:把一个本地真实窗口标记为"远程窗口"。
   *
   * @param windowId 本地窗口 id
   * @param linkId 该窗口绑定的 Host 连接 id
   */
  markWindowRemote(windowId: string, linkId: string): void {
    this.remoteBoundWindows.set(windowId, linkId);
    logger.info('WindowManager', `markWindowRemote: windowId=${windowId} link=${linkId}`);
  }

  /** Client 侧:解除远程绑定(连接被永久关闭时)。 */
  unmarkWindowRemote(windowId: string): void {
    this.remoteBoundWindows.delete(windowId);
  }

  /**
   * Client 侧:该窗口是否绑定到远端 Host。
   *
   * 事件广播用它来跳过远程窗口(见 remoteBoundWindows 字段注释),IPC 层用它
   * 决定命令是本地执行还是转发。
   */
  isWindowRemote(windowId: string): boolean {
    return this.remoteBoundWindows.has(windowId);
  }

  /** Client 侧:该远程窗口绑定的连接 id;非远程窗口返回 null。 */
  getRemoteLinkId(windowId: string): string | null {
    return this.remoteBoundWindows.get(windowId) ?? null;
  }

  /** Client 侧:某条连接当前绑定了哪些本地窗口。 */
  listWindowsForLink(linkId: string): string[] {
    const out: string[] = [];
    for (const [windowId, boundLinkId] of this.remoteBoundWindows) {
      if (boundLinkId === linkId) out.push(windowId);
    }
    return out;
  }

  /**
   * 按 windowId 投递一条事件,自动区分真实窗口与虚拟窗口。
   *
   * 这是 ipc.ts 定向推送(如 owner-only 的 evt:session:output)的统一出口。
   * 调用方不需要知道目标究竟是本机的一块玻璃还是一条 TCP 连接。
   *
   * @param envelope 已包好的 EventEnvelope
   * @returns 是否找到了投递目标(false = 该 windowId 已不存在)
   */
  deliverEvent(windowId: string, channel: string, envelope: unknown): boolean {
    const virtual = this.virtualWindows.get(windowId);
    if (virtual) {
      virtual.send(channel, envelope);
      return true;
    }
    const real = this.windows.get(windowId);
    if (real && !real.electronWindow.isDestroyed()) {
      real.electronWindow.webContents.send(channel, envelope);
      return true;
    }
    return false;
  }

  /**
   * 遍历所有虚拟窗口,用于事件广播。
   *
   * ipc.ts 的 broadcastEvent 仍然直接遍历 BrowserWindow.getAllWindows() 覆盖
   * 真实窗口(保持既有行为不变),再调这个补上虚拟窗口。
   */
  forEachVirtualWindow(cb: (send: (channel: string, envelope: unknown) => void) => void): void {
    for (const v of this.virtualWindows.values()) {
      cb(v.send);
    }
  }
}

/**
 * M1-G:解析持久化的初始 bounds,做越界 / 多显示器缺失的回退。
 * 输入为空 → 主屏幕居中默认 1200×800。
 * 输入超出所有显示器并集 → 同上回退。
 * 输入合法但只在副屏 → 保留(副屏存在的话)。
 */
function resolveInitialBounds(input: CreateWindowOptions['initialBounds']): {
  width: number;
  height: number;
  x?: number;
  y?: number;
  maximized: boolean;
} {
  const DEFAULT_W = 1200;
  const DEFAULT_H = 800;

  if (!input) {
    return { width: DEFAULT_W, height: DEFAULT_H, maximized: false };
  }

  const width = clampInt(input.width, 600, 4096, DEFAULT_W);
  const height = clampInt(input.height, 400, 4096, DEFAULT_H);

  if (input.x === undefined || input.y === undefined) {
    return { width, height, maximized: !!input.maximized };
  }

  // 校验是否落在任意 display 的可用工作区内 (至少左上角点在某 display 内)
  let onScreen = false;
  try {
    for (const d of screen.getAllDisplays()) {
      const wa = d.workArea;
      if (
        input.x >= wa.x - 8 &&
        input.x < wa.x + wa.width - 100 && // 至少留 100px 让用户看到
        input.y >= wa.y - 8 &&
        input.y < wa.y + wa.height - 50
      ) {
        onScreen = true;
        break;
      }
    }
  } catch {
    // screen API 在 app 未 ready 前不可用 — 此处保守起见走回退
    onScreen = false;
  }

  if (!onScreen) {
    return { width, height, maximized: !!input.maximized };
  }
  return { width, height, x: input.x, y: input.y, maximized: !!input.maximized };
}

function clampInt(v: number, lo: number, hi: number, fallback: number): number {
  if (!Number.isFinite(v)) return fallback;
  const i = Math.round(v);
  if (i < lo) return lo;
  if (i > hi) return hi;
  return i;
}
