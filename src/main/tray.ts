/**
 * @file src/main/tray.ts
 * @purpose 系统托盘管理。常驻托盘图标、右键菜单、单击聚焦最近活动窗口、
 *   "完全退出 Ceteris"流程。
 *
 * @关键设计:
 * - 托盘是应用"始终在线"的代表 (软件定义书 6.5)
 * - 单击: 有窗口聚焦最近活动的;无窗口新开一个 (软件定义书 6.5.2)
 * - 右键菜单 V1 完整规格 (软件定义书 6.5.3) 包括会话子菜单 / 设置 /
 *   完全退出。CP-1 仅实现"打开新窗口" + "完全退出",其余项 CP-3/CP-4
 *   随 SessionManager / SettingsManager 接入后补齐。
 * - 完全退出: 设置 isQuitting → 显式 app.quit(),让 Electron 走标准退出
 *   (before-quit → will-quit → quit)。这样 window-all-closed 不会被
 *   误解为纯托盘模式。
 * - 图标: 用 nativeImage.createFromBitmap 程序化生成 16x16 像素图,
 *   与 build/icon.svg 同一设计,避免托盘依赖打包资源路径。
 *
 * @对应文档章节: 软件定义书.md 6.5、7.4 节;AGENTS.md CP-1 完成标志
 *
 * @不要在这里做的事:
 * - 不要在这里弹"完全退出"二次确认对话框 (CP-1 还没 session 概念,
 *   无法判断"有 session 在跑"。CP-3 有 SessionManager 后再加,
 *   软件定义书 7.4.3)
 * - 不要直接调 BrowserWindow API (通过 WindowManager)
 */
import {
  app,
  dialog,
  Menu,
  nativeImage,
  Tray,
  type MenuItemConstructorOptions,
  type NativeImage,
} from 'electron';
import { EVENT_CHANNELS } from '@shared/protocol';
import { randomUUID } from 'node:crypto';
import type { WindowManager } from './window-manager';
import type { SessionInfo } from '@shared/types';
import type { SessionManager } from './session-manager';
import type { SettingsManager } from './settings-manager';
import { getAppLabel } from './build-type';
import { logger } from './logger';
import { setQuitting } from './index';

/**
 * 16×16 托盘图标的像素图。设计与 build/icon.svg 同源:海青底、白色 ">"、
 * 浅青波浪。16px 下矢量缩放会糊,这里按像素手工对齐。
 *   . 透明   b 底色   f 提示符   w 水面
 */
const TRAY_PIXELS = [
  '..bbbbbbbbbbbb..',
  '.bbbbbbbbbbbbbb.',
  'bbbbbffbbbbbbbbb',
  'bbbbbfffbbbbbbbb',
  'bbbbbbfffbbbbbbb',
  'bbbbbbbfffbbbbbb',
  'bbbbbbbbfffbbbbb',
  'bbbbbbbfffbbbbbb',
  'bbbbbbfffbbbbbbb',
  'bbbbbfffbbbbbbbb',
  'bbbbbffbbbbbbbbb',
  'bbbbbbbbbbbbbbbb',
  'bbwwwwbbbbbbbbbb',
  'wwwwwwwwbbbbwwww',
  '.wwwwwwwwwwwwww.',
  '..wwwwwwwwwwww..',
] as const;

const TRAY_PALETTE: Record<string, readonly [number, number, number]> = {
  b: [0x00, 0x6a, 0x6a],
  f: [0xff, 0xff, 0xff],
  w: [0x9c, 0xf1, 0xf0],
};

/** active 状态光点,在海青底上保持可辨 */
const TRAY_ACTIVE_DOT: readonly [number, number, number] = [0xff, 0xd3, 0x7a];

/**
 * 程序化生成 16×16 RGBA 托盘图标,不依赖打包资源路径,dev 与生产行为一致。
 *
 * M1-E 起,接受 variant 区分三态(spec 6.5.1):
 *   - 'default':无 session 或 idle
 *   - 'active':右上角琥珀色光点,至少一个 session 处于 active
 */
function generateTrayIcon(variant: 'default' | 'active'): NativeImage {
  const size = 16;
  const buf = Buffer.alloc(size * size * 4);

  const setPixel = (x: number, y: number, rgb: readonly [number, number, number]): void => {
    const i = (y * size + x) * 4;
    // createFromBitmap 按 BGRA 读取。旧图标接近中性色,看不出通道反了;海青底
    // 写成 RGBA 会显示成橄榄色。
    buf[i] = rgb[2];
    buf[i + 1] = rgb[1];
    buf[i + 2] = rgb[0];
    buf[i + 3] = 0xff;
  };

  TRAY_PIXELS.forEach((row, y) => {
    for (let x = 0; x < size; x++) {
      const color = TRAY_PALETTE[row[x]!];
      if (color) setPixel(x, y, color);
    }
  });

  // 光点放右上角:那里没有提示符和波浪,4×4 在 16px 下才看得出来
  if (variant === 'active') {
    for (let y = 2; y < 6; y++) {
      for (let x = 10; x < 14; x++) setPixel(x, y, TRAY_ACTIVE_DOT);
    }
  }

  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

export class TrayManager {
  private tray: Tray | null = null;
  /** M1-H:状态变化节流,避免高频抖动 */
  private rebuildTimer: NodeJS.Timeout | null = null;
  private currentIconVariant: 'default' | 'active' = 'default';

  constructor(
    private readonly windowManager: WindowManager,
    private readonly sessionManager?: SessionManager,
    private readonly settingsManager?: SettingsManager,
  ) {}

  /**
   * 初始化托盘。必须在 app.whenReady() 之后调用。
   * 重复调用会先销毁旧的再建新的。
   */
  init(): void {
    if (this.tray) {
      this.tray.destroy();
      this.tray = null;
    }

    this.tray = new Tray(generateTrayIcon('default'));
    this.tray.setToolTip(getAppLabel());

    this.tray.on('click', () => this.handleSingleClick());
    // 双击在 Windows 等同于单击 (软件定义书 6.5.2: "避免双击意外行为")
    this.tray.on('double-click', () => this.handleSingleClick());

    this.rebuildContextMenu();
    this.refreshIcon();

    // 窗口 / session 变化都触发菜单 + 图标重建(节流 300ms)
    this.windowManager.onWindowCreated(() => this.scheduleRebuild());
    this.windowManager.onWindowClosed(() => this.scheduleRebuild());
    this.sessionManager?.on('sessionCreated', () => this.scheduleRebuild());
    this.sessionManager?.on('sessionDestroyed', () => this.scheduleRebuild());
    this.sessionManager?.on('sessionStateChanged', () => this.scheduleRebuild());
    this.sessionManager?.on('sessionOwnerChanged', () => this.scheduleRebuild());
  }

  private scheduleRebuild(): void {
    if (this.rebuildTimer) return;
    this.rebuildTimer = setTimeout(() => {
      this.rebuildTimer = null;
      this.rebuildContextMenu();
      this.refreshIcon();
    }, 300);
  }

  /**
   * M1-H:刷新图标与 tooltip,根据当前 session 集合判断 active/idle。
   */
  private refreshIcon(): void {
    if (!this.tray) return;
    const sessions = this.sessionManager?.list() ?? [];
    const total = sessions.length;
    const live = sessions.filter((s) => s.state !== 'exited').length;
    const active = sessions.filter((s) => s.state === 'active').length;
    const desired: 'default' | 'active' = active > 0 ? 'active' : 'default';
    if (desired !== this.currentIconVariant) {
      this.currentIconVariant = desired;
      try {
        this.tray.setImage(generateTrayIcon(desired));
      } catch (err) {
        logger.warn('TrayManager', 'setImage failed', err);
      }
    }
    this.tray.setToolTip(
      `${getAppLabel()}: ${total} 个会话${total > 0 ? ` (${live} 运行中,${active} 活跃)` : ''}`,
    );
  }

  /**
   * 销毁托盘图标。在 app.quit 真正执行前调用,避免图标残留几秒钟。
   */
  destroy(): void {
    this.tray?.destroy();
    this.tray = null;
  }

  /**
   * 单击 / 双击托盘:
   * - 有窗口 → 聚焦最近活动的 (若被最小化则恢复)
   * - 无窗口 → 新开一个
   */
  private handleSingleClick(): void {
    const recent = this.windowManager.getMostRecentlyActive();
    if (recent) {
      if (recent.isMinimized()) recent.restore();
      if (!recent.isVisible()) recent.show();
      recent.focus();
      return;
    }
    try {
      this.windowManager.createWindowFromFactory();
    } catch (err) {
      logger.error('TrayManager', 'handleSingleClick: createWindow failed', err);
    }
  }

  /**
   * 重建右键菜单。M1-H 完整化(spec 6.5.3):
   *   - 打开新窗口
   *   - 显示所有窗口(>=1 窗口时)
   *   - 关闭所有窗口(>=1 窗口时)
   *   - --
   *   - 正在运行的会话(子菜单,>=1 session 时)
   *   - --
   *   - 设置
   *   - 完全退出 Ceteris
   */
  private rebuildContextMenu(): void {
    if (!this.tray) return;

    const sessions = this.sessionManager?.list() ?? [];
    const liveSessions = sessions.filter((s) => s.state !== 'exited');
    const windowCount = this.windowManager.count();

    const items: MenuItemConstructorOptions[] = [];

    items.push({
      label: '打开新窗口',
      click: () => {
        try {
          this.windowManager.createWindowFromFactory();
        } catch (err) {
          logger.error('TrayManager', 'open new window failed', err);
        }
      },
    });

    if (windowCount > 0) {
      items.push({
        label: '显示所有窗口',
        click: () => {
          for (const info of this.windowManager.list()) {
            const w = this.windowManager.getById(info.id);
            if (!w || w.isDestroyed()) continue;
            // Hidden windows are views swapped out by the ViewSwitcher. Their
            // visible partner is the same window as far as the user can tell.
            if (!w.isVisible()) continue;
            if (w.isMinimized()) w.restore();
            w.show();
          }
        },
      });
      items.push({
        label: `关闭所有窗口 (${windowCount})`,
        click: () => {
          // 关闭所有窗口 — 不影响 session,应用进入"纯托盘模式"
          for (const info of this.windowManager.list()) {
            this.windowManager.closeWindow(info.id);
          }
        },
      });
    }

    items.push({ type: 'separator' });

    // 正在运行的会话子菜单
    if (sessions.length > 0) {
      const submenu: MenuItemConstructorOptions[] = sessions.map((s) =>
        this.buildSessionMenuItem(s),
      );
      items.push({
        label: `正在运行的会话 (${sessions.length})`,
        submenu,
      });
      items.push({ type: 'separator' });
    }

    items.push({
      label: '设置…',
      click: () => this.openSettings(),
    });

    items.push({ type: 'separator' });

    items.push({
      label: `完全退出 ${getAppLabel()}${liveSessions.length > 0 ? ` (${liveSessions.length} 个会话运行中)` : ''}`,
      click: () => this.quitApp(),
    });

    this.tray.setContextMenu(Menu.buildFromTemplate(items));
  }

  /**
   * 构造"正在运行的会话"子菜单中的单项。
   * 状态符号:● active / ◐ idle / ○ exited;点击 → 聚焦 owner 窗口并选中该 session。
   */
  private buildSessionMenuItem(s: SessionInfo): MenuItemConstructorOptions {
    const symbol = s.state === 'active' ? '●' : s.state === 'idle' ? '◐' : '○';
    const cwd = s.currentCwd || s.originalCwd;
    const cwdShort = cwd.length > 50 ? '…' + cwd.slice(-47) : cwd;
    return {
      label: `${symbol} ${s.displayName}   ${cwdShort}`,
      click: () => this.focusSession(s),
    };
  }

  private focusSession(s: SessionInfo): void {
    try {
      const ownerId = s.ownerWindowId;
      if (ownerId) {
        const win = this.windowManager.getById(ownerId);
        if (win && !win.isDestroyed()) {
          if (win.isMinimized()) win.restore();
          win.focus();
          win.webContents.send(EVENT_CHANNELS.WINDOW_FOCUS_REQUESTED, {
            eventId: randomUUID(),
            timestamp: Date.now(),
            payload: { reason: 'tray-session-click', selectSessionId: s.id },
          });
          return;
        }
      }
      // 无 owner:新开窗口并发选中事件
      const info = this.windowManager.createWindowFromFactory();
      const win = this.windowManager.getById(info.id);
      // 窗口 ready 后才发(否则 webContents.send 没人接);用 once webContents.did-finish-load
      win?.webContents.once('did-finish-load', () => {
        if (win.isDestroyed()) return;
        win.webContents.send(EVENT_CHANNELS.WINDOW_FOCUS_REQUESTED, {
          eventId: randomUUID(),
          timestamp: Date.now(),
          payload: { reason: 'tray-session-click', selectSessionId: s.id },
        });
      });
    } catch (err) {
      logger.error('TrayManager', 'focusSession failed', err);
    }
  }

  private openSettings(): void {
    try {
      let recent = this.windowManager.getMostRecentlyActive();
      if (!recent) {
        const info = this.windowManager.createWindowFromFactory();
        recent = this.windowManager.getById(info.id);
      }
      if (!recent || recent.isDestroyed()) return;
      if (recent.isMinimized()) recent.restore();
      recent.focus();
      // 让 renderer 切到 settings 视图。当前没有 cmd:view:enter-settings,
      // 复用 WINDOW_FOCUS_REQUESTED + 一个特殊 reason,renderer 端识别即切。
      recent.webContents.send(EVENT_CHANNELS.WINDOW_FOCUS_REQUESTED, {
        eventId: randomUUID(),
        timestamp: Date.now(),
        payload: { reason: 'tray-open-settings' },
      });
    } catch (err) {
      logger.error('TrayManager', 'openSettings failed', err);
    }
  }

  /**
   * 完全退出应用 (软件定义书 7.4.3)。
   *
   * CP-4 起完整版:
   * - settings.behavior.confirmOnQuit=true 且有 session 在跑(state≠exited)
   *   → 弹 dialog.showMessageBox 二次确认
   * - 用户点"取消" → 不退出
   * - 用户点"退出" → setQuitting + app.quit (will-quit 会负责 SIGTERM
   *   + 等 5 秒强制 kill,见 软件定义书 7.4.3)
   *
   * 关闭单窗口绝对不调到这里 (软件定义书 7.4.1, AGENTS.md 红线)。
   */
  private async quitApp(): Promise<void> {
    const settings = this.settingsManager?.get();
    const confirmOnQuit = settings?.behavior?.confirmOnQuit ?? true;
    const sessions = this.sessionManager?.list() ?? [];
    const liveCount = sessions.filter((s) => s.state !== 'exited').length;

    if (confirmOnQuit && liveCount > 0) {
      const owner = this.windowManager.getMostRecentlyActive();
      const result = await dialog.showMessageBox(owner ?? undefined as never, {
        type: 'warning',
        title: `完全退出 ${getAppLabel()}?`,
        message: `还有 ${liveCount} 个终端在运行,完全退出会关掉它们。`,
        detail: '如果只想隐藏窗口,请关闭窗口而不是"完全退出"。',
        buttons: ['取消', '完全退出'],
        defaultId: 0,
        cancelId: 0,
      });
      if (result.response !== 1) return;
    }

    setQuitting();
    this.destroy();
    app.quit();
  }
}
