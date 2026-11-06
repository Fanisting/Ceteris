/**
 * @file src/main/view-switcher.ts
 * @purpose Client side of Ceteris Link: show Local and each remote Host as views of one
 *   visible window, switched from the title bar.
 *
 * Why swap windows instead of hosting two views in one BrowserWindow:
 * a remote window's renderer is the same code as a local one and keeps its own terminals,
 * scrollback and store. Keeping each view in its own BrowserWindow leaves all of that
 * untouched and costs nothing on the Host. The user sees one window because exactly one
 * of the group is visible, at the same bounds.
 *
 * Rules:
 * - Remote windows start hidden and are only ever shown by this module.
 * - A remote view remembers the local window it replaced (its anchor), so "Local" returns
 *   to that window even when several local windows are open.
 * - Closing a visible remote view disconnects it (LinkManager owns that) and brings back
 *   its local window. Nothing is created here on close, so "close all windows" still ends
 *   in tray mode and app quit never spawns a window.
 *
 * @对应文档章节: docs/远程访问指南.md 第 6 章
 */
import type { BrowserWindow } from 'electron';
import {
  EVENT_CHANNELS,
  VIEW_TARGET_LOCAL,
  type ViewStateResponse,
  type ViewTarget,
} from '@shared/protocol';
import { logger } from './logger';
import type { WindowManager } from './window-manager';

/** Label of the local view in the title bar. */
const LOCAL_LABEL = 'Local';

/** Keep the old window up while the new one fades in, or the desktop flashes through. */
const HIDE_DELAY_MS = 150;

export interface ViewSwitcherDeps {
  windowManager: Pick<
    WindowManager,
    | 'list'
    | 'getById'
    | 'isVirtualWindow'
    | 'getMostRecentlyActive'
    | 'createWindowFromFactory'
    | 'onWindowCreated'
    | 'onWindowClosed'
  >;
  /** The name the user gave this Host. Null when the window is not remote. */
  getRemoteLabel: (windowId: string) => string | null;
}

interface ClosingSnapshot {
  bounds: Electron.Rectangle;
  maximized: boolean;
  visible: boolean;
}

export class ViewSwitcher {
  /** Remote window id → the local window it replaced, or null if it never replaced one. */
  private readonly remotes = new Map<string, string | null>();
  /** Captured on 'close', because bounds are gone by the time 'closed' fires. */
  private readonly closing = new Map<string, ClosingSnapshot>();

  constructor(private readonly deps: ViewSwitcherDeps) {
    deps.windowManager.onWindowCreated((info, win: BrowserWindow | null) => {
      // A remote client on the Host side is a virtual window with no BrowserWindow.
      if (!win) return;
      win.on('close', () => {
        if (win.isDestroyed()) return;
        this.closing.set(info.id, {
          bounds: win.getNormalBounds(),
          maximized: win.isMaximized(),
          visible: win.isVisible(),
        });
      });
      this.notify();
    });
    deps.windowManager.onWindowClosed((windowId) => this.handleWindowClosed(windowId));
  }

  /**
   * Register a remote window right after it is created.
   *
   * @param reveal true when the user pressed Connect, so the view opens straight away.
   *   Auto-connect at startup passes false and stays on Local.
   */
  handleRemoteCreated(windowId: string, reveal: boolean): void {
    this.remotes.set(windowId, null);
    this.notify();
    if (!reveal) return;
    const win = this.deps.windowManager.getById(windowId);
    win?.once('ready-to-show', () => {
      const from = this.visibleWindowId();
      if (from) {
        this.switchTo(from, windowId);
        return;
      }
      if (!win.isDestroyed()) win.show();
    });
  }

  getState(windowId: string): ViewStateResponse {
    const isRemote = this.remotes.has(windowId);
    const targets: ViewTarget[] = [
      { id: VIEW_TARGET_LOCAL, label: LOCAL_LABEL, active: !isRemote },
    ];
    for (const id of this.remotes.keys()) {
      targets.push({
        id,
        label: this.deps.getRemoteLabel(id) ?? id.slice(0, 8),
        active: id === windowId,
      });
    }
    return { targets };
  }

  /** Replace the view shown by fromWindowId with targetId. */
  switchTo(fromWindowId: string, targetId: string): void {
    const wm = this.deps.windowManager;
    const from = wm.getById(fromWindowId);
    if (!from || from.isDestroyed()) return;

    const fromRemote = this.remotes.has(fromWindowId);
    if (targetId === VIEW_TARGET_LOCAL) {
      if (!fromRemote) return;
      const anchor = this.resolveLocal(fromWindowId);
      if (anchor) {
        this.swap(from, anchor);
      } else {
        // The local window was closed earlier: open a fresh one where this view sits.
        const created = wm.createWindowFromFactory();
        const win = wm.getById(created.id);
        if (win) this.swap(from, win);
      }
      this.notify();
      return;
    }

    if (targetId === fromWindowId) return;
    if (!this.remotes.has(targetId)) {
      throw new Error(`[ViewSwitcher] 目标 ${targetId} 不是已连接的远端视图,无法切换。`);
    }
    const to = wm.getById(targetId);
    if (!to || to.isDestroyed()) return;

    if (to.isVisible()) {
      // Another local window already swapped to this Host.
      to.focus();
      return;
    }
    this.remotes.set(targetId, fromRemote ? (this.remotes.get(fromWindowId) ?? null) : fromWindowId);
    this.swap(from, to);
    this.notify();
  }

  private swap(from: BrowserWindow, to: BrowserWindow): void {
    if (from.isMaximized()) {
      to.setBounds(from.getNormalBounds());
      to.maximize();
    } else {
      if (to.isMaximized()) to.unmaximize();
      to.setBounds(from.getBounds());
    }
    to.show();
    to.focus();
    to.webContents.focus();
    setTimeout(() => {
      if (!from.isDestroyed()) from.hide();
    }, HIDE_DELAY_MS);
  }

  /** The window that "Local" means for a remote view, if one is still open. */
  private resolveLocal(remoteId: string): BrowserWindow | null {
    const wm = this.deps.windowManager;
    const anchorId = this.remotes.get(remoteId);
    const anchor = anchorId ? wm.getById(anchorId) : null;
    if (anchor && !anchor.isDestroyed()) return anchor;
    for (const info of wm.list()) {
      if (wm.isVirtualWindow(info.id) || this.remotes.has(info.id)) continue;
      const win = wm.getById(info.id);
      if (win && !win.isDestroyed()) return win;
    }
    return null;
  }

  private handleWindowClosed(windowId: string): void {
    const snapshot = this.closing.get(windowId);
    this.closing.delete(windowId);

    if (this.remotes.has(windowId)) {
      const local = snapshot?.visible ? this.resolveLocal(windowId) : null;
      this.remotes.delete(windowId);
      if (local && !local.isVisible() && snapshot) {
        logger.info('ViewSwitcher', `远程视图 ${windowId} 已关闭,回到本地窗口`);
        if (snapshot.maximized) {
          local.setBounds(snapshot.bounds);
          local.maximize();
        } else {
          if (local.isMaximized()) local.unmaximize();
          local.setBounds(snapshot.bounds);
        }
        local.show();
        local.focus();
      }
    } else {
      // A remote view whose local window is gone falls back to any other local window.
      for (const [id, anchor] of this.remotes) {
        if (anchor === windowId) this.remotes.set(id, null);
      }
    }
    this.notify();
  }

  private visibleWindowId(): string | null {
    const wm = this.deps.windowManager;
    const recent = wm.getMostRecentlyActive();
    if (!recent || recent.isDestroyed() || !recent.isVisible()) return null;
    return wm.list().find((w) => w.electronWindowId === recent.webContents.id)?.id ?? null;
  }

  /** Tell every window to refetch: each one sees a different active view. */
  private notify(): void {
    const wm = this.deps.windowManager;
    for (const info of wm.list()) {
      if (wm.isVirtualWindow(info.id)) continue;
      const win = wm.getById(info.id);
      if (!win || win.isDestroyed()) continue;
      win.webContents.send(EVENT_CHANNELS.VIEW_STATE_CHANGED, {
        eventId: `view-${Date.now()}`,
        timestamp: Date.now(),
        payload: undefined,
      });
    }
  }
}
