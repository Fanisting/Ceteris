/**
 * @file src/main/view-switcher.test.ts
 * @purpose Swapping Local and remote views: the visible window, its bounds, and what
 *   happens when a view goes away.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VIEW_TARGET_LOCAL } from '@shared/protocol';
import { ViewSwitcher } from './view-switcher';

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function fakeWindow(webContentsId: number, visible: boolean, bounds: Rect) {
  const handlers = new Map<string, Array<() => void>>();
  const state = { visible, maximized: false, destroyed: false, bounds };
  const win = {
    state,
    webContents: { id: webContentsId, focus: vi.fn(), send: vi.fn() },
    isDestroyed: () => state.destroyed,
    isVisible: () => state.visible,
    isMaximized: () => state.maximized,
    getBounds: () => state.bounds,
    getNormalBounds: () => state.bounds,
    setBounds: (b: Rect) => {
      state.bounds = b;
    },
    maximize: () => {
      state.maximized = true;
    },
    unmaximize: () => {
      state.maximized = false;
    },
    show: () => {
      state.visible = true;
    },
    hide: () => {
      state.visible = false;
    },
    focus: vi.fn(),
    on: (event: string, cb: () => void) => {
      handlers.set(event, [...(handlers.get(event) ?? []), cb]);
    },
    once: (event: string, cb: () => void) => {
      handlers.set(event, [...(handlers.get(event) ?? []), cb]);
    },
    emit: (event: string) => (handlers.get(event) ?? []).forEach((cb) => cb()),
  };
  return win;
}
type FakeWindow = ReturnType<typeof fakeWindow>;

const BOUNDS_A = { x: 10, y: 20, width: 800, height: 600 };
const BOUNDS_B = { x: 300, y: 300, width: 500, height: 400 };

function setup() {
  const windows = new Map<string, FakeWindow>();
  const created: Array<(info: { id: string }, win: FakeWindow) => void> = [];
  const closed: Array<(id: string) => void> = [];
  let nextId = 1;
  const wm = {
    list: () =>
      [...windows.entries()].map(([id, w]) => ({ id, electronWindowId: w.webContents.id })),
    getById: (id: string) => windows.get(id) ?? null,
    isVirtualWindow: () => false,
    getMostRecentlyActive: () => [...windows.values()].find((w) => w.isVisible()) ?? null,
    createWindowFromFactory: vi.fn(() => {
      const id = `new-${nextId++}`;
      windows.set(id, fakeWindow(90 + nextId, false, BOUNDS_B));
      return { id };
    }),
    onWindowCreated: (cb: (info: { id: string }, win: FakeWindow) => void) => created.push(cb),
    onWindowClosed: (cb: (id: string) => void) => closed.push(cb),
  };
  const labels = new Map<string, string>();
  const switcher = new ViewSwitcher({
    windowManager: wm as never,
    getRemoteLabel: (id) => labels.get(id) ?? null,
  });

  const open = (id: string, visible: boolean, bounds: Rect): FakeWindow => {
    const win = fakeWindow(windows.size + 1, visible, bounds);
    windows.set(id, win);
    created.forEach((cb) => cb({ id }, win));
    return win;
  };
  const openRemote = (id: string, label: string): FakeWindow => {
    labels.set(id, label);
    const win = open(id, false, BOUNDS_B);
    switcher.handleRemoteCreated(id, false);
    return win;
  };
  const close = (id: string): void => {
    windows.get(id)?.emit('close');
    const win = windows.get(id);
    if (win) win.state.destroyed = true;
    windows.delete(id);
    closed.forEach((cb) => cb(id));
  };
  return { wm, switcher, open, openRemote, close, labels, createdHandlers: created };
}

describe('ViewSwitcher', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a window with no remote hosts only offers Local', () => {
    const { switcher, open } = setup();
    open('local', true, BOUNDS_A);
    expect(switcher.getState('local').targets).toEqual([
      { id: VIEW_TARGET_LOCAL, label: 'Local', active: true },
    ]);
  });

  it('labels the remote view with the saved Host name and marks the active view', () => {
    const { switcher, open, openRemote } = setup();
    open('local', true, BOUNDS_A);
    openRemote('r1', 'Home PC');
    expect(switcher.getState('local').targets.map((t) => [t.label, t.active])).toEqual([
      ['Local', true],
      ['Home PC', false],
    ]);
    expect(switcher.getState('r1').targets.map((t) => [t.label, t.active])).toEqual([
      ['Local', false],
      ['Home PC', true],
    ]);
  });

  it('auto-connect keeps Local on screen and the remote hidden', () => {
    const { open, openRemote } = setup();
    const local = open('local', true, BOUNDS_A);
    const remote = openRemote('r1', 'Home PC');
    expect(local.isVisible()).toBe(true);
    expect(remote.isVisible()).toBe(false);
  });

  it('manual connect opens the remote view once its page is ready', () => {
    const { switcher, open, labels, wm } = setup();
    const local = open('local', true, BOUNDS_A);
    labels.set('r1', 'Home PC');
    const remote = open('r1', false, BOUNDS_B);
    switcher.handleRemoteCreated('r1', true);
    expect(remote.isVisible()).toBe(false);
    remote.emit('ready-to-show');
    expect(wm.getById('r1')?.isVisible()).toBe(true);
    vi.runAllTimers();
    expect(local.isVisible()).toBe(false);
  });

  it('switching keeps the on-screen position and hides the old view only after a delay', () => {
    const { switcher, open, openRemote } = setup();
    const local = open('local', true, BOUNDS_A);
    const remote = openRemote('r1', 'Home PC');
    switcher.switchTo('local', 'r1');
    expect(remote.isVisible()).toBe(true);
    expect(remote.getBounds()).toEqual(BOUNDS_A);
    expect(local.isVisible()).toBe(true);
    vi.runAllTimers();
    expect(local.isVisible()).toBe(false);
  });

  it('carries a maximized window across the switch in both directions', () => {
    const { switcher, open, openRemote } = setup();
    const local = open('local', true, BOUNDS_A);
    const remote = openRemote('r1', 'Home PC');
    local.state.maximized = true;
    switcher.switchTo('local', 'r1');
    vi.runAllTimers();
    expect(remote.isMaximized()).toBe(true);

    remote.state.maximized = false;
    remote.setBounds(BOUNDS_B);
    switcher.switchTo('r1', VIEW_TARGET_LOCAL);
    vi.runAllTimers();
    expect(local.isMaximized()).toBe(false);
    expect(local.getBounds()).toEqual(BOUNDS_B);
  });

  it('returns to the same local window when several are open', () => {
    const { switcher, open, openRemote } = setup();
    open('first', true, BOUNDS_A);
    const second = open('second', true, BOUNDS_B);
    const remote = openRemote('r1', 'Home PC');
    switcher.switchTo('second', 'r1');
    vi.runAllTimers();
    expect(second.isVisible()).toBe(false);
    switcher.switchTo('r1', VIEW_TARGET_LOCAL);
    vi.runAllTimers();
    expect(second.isVisible()).toBe(true);
    expect(remote.isVisible()).toBe(false);
  });

  it('moves between two hosts without losing the way back to Local', () => {
    const { switcher, open, openRemote } = setup();
    const local = open('local', true, BOUNDS_A);
    const one = openRemote('r1', 'One');
    const two = openRemote('r2', 'Two');
    switcher.switchTo('local', 'r1');
    vi.runAllTimers();
    switcher.switchTo('r1', 'r2');
    vi.runAllTimers();
    expect(one.isVisible()).toBe(false);
    expect(two.isVisible()).toBe(true);
    switcher.switchTo('r2', VIEW_TARGET_LOCAL);
    vi.runAllTimers();
    expect(local.isVisible()).toBe(true);
  });

  it('opens a new local window if the old one was closed', () => {
    const { switcher, open, openRemote, close, wm } = setup();
    open('local', true, BOUNDS_A);
    const remote = openRemote('r1', 'Home PC');
    switcher.switchTo('local', 'r1');
    vi.runAllTimers();
    close('local');
    switcher.switchTo('r1', VIEW_TARGET_LOCAL);
    vi.runAllTimers();
    expect(wm.createWindowFromFactory).toHaveBeenCalledOnce();
    expect(remote.isVisible()).toBe(false);
  });

  it('closing the visible remote view brings Local back at its position', () => {
    const { switcher, open, openRemote, close } = setup();
    const local = open('local', true, BOUNDS_A);
    const remote = openRemote('r1', 'Home PC');
    switcher.switchTo('local', 'r1');
    vi.runAllTimers();
    remote.setBounds(BOUNDS_B);
    close('r1');
    expect(local.isVisible()).toBe(true);
    expect(local.getBounds()).toEqual(BOUNDS_B);
    expect(switcher.getState('local').targets).toHaveLength(1);
  });

  it('disconnecting a hidden remote view leaves the local window alone', () => {
    const { switcher, open, openRemote, close } = setup();
    const local = open('local', true, BOUNDS_A);
    openRemote('r1', 'Home PC');
    close('r1');
    expect(local.isVisible()).toBe(true);
    expect(local.getBounds()).toEqual(BOUNDS_A);
    expect(switcher.getState('local').targets).toHaveLength(1);
  });

  it('closing everything never opens a window, so the app can go to the tray', () => {
    const { switcher, open, openRemote, close, wm } = setup();
    open('local', true, BOUNDS_A);
    openRemote('r1', 'Home PC');
    switcher.switchTo('local', 'r1');
    vi.runAllTimers();
    close('r1');
    close('local');
    expect(wm.createWindowFromFactory).not.toHaveBeenCalled();
  });

  it('ignores a virtual window, which has no BrowserWindow to track', () => {
    const { switcher, open, createdHandlers } = setup();
    open('local', true, BOUNDS_A);
    expect(() =>
      createdHandlers.forEach((cb) => cb({ id: 'virtual' }, null as never)),
    ).not.toThrow();
    expect(switcher.getState('local').targets).toHaveLength(1);
  });

  it('rejects a target that is not a connected Host', () => {
    const { switcher, open } = setup();
    open('local', true, BOUNDS_A);
    expect(() => switcher.switchTo('local', 'nope')).toThrow(/不是已连接的远端视图/);
  });
});
