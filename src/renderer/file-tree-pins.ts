/**
 * @file src/renderer/file-tree-pins.ts
 * @purpose 文件树顶部的置顶文件夹。用户在文件树里右键文件夹选"置顶",它就以小方块
 *   出现在文件树面板顶部,点一下文件树就切到那个文件夹。
 *
 * @关键设计:
 * - 存在 localStorage,不进 settings.json:这只是本机的浏览便利,丢了也只是少几个
 *   快捷入口。同一个 userData 下所有窗口共用一份 localStorage,storage 事件让别的
 *   窗口即时看到变化。
 * - 远程文件夹带 sshProfileId,点击后按 SFTP 只读浏览,和 session 的远程文件树一样。
 * - localStorage 可能读不到或抛错,一律当作没有置顶,不影响文件树本身。
 *
 * @不要在这里做的事:
 * - 不要把置顶并入侧栏文件夹列表 (bookmarks.json),两者是不同的东西
 */
import { useSyncExternalStore } from 'react';

export interface FolderPin {
  path: string;
  /** 有值时是这个 SSH profile 上的远程文件夹 */
  sshProfileId?: string;
}

const STORAGE_KEY = 'ceteris.fileTree.pins';

const listeners = new Set<() => void>();
let cached: readonly FolderPin[] | null = null;

function read(): readonly FolderPin[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage?.getItem(STORAGE_KEY) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (p): p is FolderPin =>
        typeof p === 'object' &&
        p !== null &&
        typeof (p as FolderPin).path === 'string' &&
        ((p as FolderPin).sshProfileId === undefined ||
          typeof (p as FolderPin).sshProfileId === 'string'),
    );
  } catch {
    return [];
  }
}

function snapshot(): readonly FolderPin[] {
  if (cached === null) cached = read();
  return cached;
}

function write(next: readonly FolderPin[]): void {
  cached = next;
  try {
    window.localStorage?.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // 只是本窗口之外看不到这次改动,本窗口照常显示
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  const onStorage = (e: StorageEvent): void => {
    if (e.key !== STORAGE_KEY && e.key !== null) return;
    cached = null;
    listener();
  };
  listeners.add(listener);
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

export function samePin(a: FolderPin, b: FolderPin): boolean {
  return a.path === b.path && (a.sshProfileId ?? '') === (b.sshProfileId ?? '');
}

export function useFolderPins(): readonly FolderPin[] {
  return useSyncExternalStore(subscribe, snapshot);
}

export function isPinned(pins: readonly FolderPin[], pin: FolderPin): boolean {
  return pins.some((p) => samePin(p, pin));
}

/** 已置顶就取消,否则加到末尾。 */
export function togglePin(pin: FolderPin): void {
  const pins = snapshot();
  write(
    isPinned(pins, pin)
      ? pins.filter((p) => !samePin(p, pin))
      : [
          ...pins,
          pin.sshProfileId
            ? { path: pin.path, sshProfileId: pin.sshProfileId }
            : { path: pin.path },
        ],
  );
}

/**
 * 本地文件夹改名后,让指向它或它里面的置顶跟着走。
 * @param remap 和文件树共用的 remapPath,传入避免这里重复路径规则
 */
export function remapLocalPins(remap: (path: string) => string): void {
  const pins = snapshot();
  let changed = false;
  const next = pins.map((p) => {
    if (p.sshProfileId) return p;
    const path = remap(p.path);
    if (path === p.path) return p;
    changed = true;
    return { path };
  });
  if (changed) write(next);
}
