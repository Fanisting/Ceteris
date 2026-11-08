/**
 * @file src/renderer/components/Toast.tsx
 * @purpose 全局 Toast 通知 (M1-J)。任何组件可 useToast().push(...) 弹消息。
 *
 *   - info / success / warn / error 四种类型
 *   - 4 秒自动消失(error 类型 8 秒);hover 暂停计时
 *   - 多条堆叠右下角,新的在上
 *   - 关闭按钮 + 点击 toast 体也可关闭
 *   - 主进程 IPC 错误等场景:catch 后 toast.push({ kind: 'error', message })
 *
 *   - 消失时先淡出 150ms 再卸载(.leaving,见 styles/motion.css 与 motion.ts)
 *
 *   不引入新依赖,纯 React + CSS。
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Icon } from './icons';
import { focusTerminalDom } from '../focus';
import { MOTION_EXIT_MS, prefersReducedMotion } from '../motion';

export type ToastKind = 'info' | 'success' | 'warn' | 'error';

export interface ToastInput {
  kind: ToastKind;
  message: string;
  /** 显示时长 ms;不传走默认(error 8s,其余 4s) */
  durationMs?: number;
  /** 消息右侧的文字按钮;点了先执行 onClick 再关掉这条 toast */
  actions?: ToastAction[];
}

export interface ToastAction {
  label: string;
  onClick: () => void;
}

interface Toast extends ToastInput {
  id: number;
  bornAt: number;
}

interface ToastApi {
  push(t: ToastInput): void;
  dismiss(id: number): void;
}

const Ctx = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const v = useContext(Ctx);
  if (!v) throw new Error('[Toast] useToast must be inside <ToastProvider>');
  return v;
}

export function ToastProvider({ children }: { children: ReactNode }): JSX.Element {
  const [items, setItems] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const pausedIds = useRef<Set<number>>(new Set());
  // 正在淡出的 toast。它们还在 items 里(所以还渲染),但已经不计时、不响应鼠标,
  // MOTION_EXIT_MS 后才真正移除。ref 给 ticker 用,state 给渲染用。
  const [leaving, setLeaving] = useState<ReadonlySet<number>>(new Set());
  const leavingRef = useRef<ReadonlySet<number>>(leaving);
  leavingRef.current = leaving;
  const itemsRef = useRef<Toast[]>(items);
  itemsRef.current = items;

  /**
   * 让一批 toast 退场:标记 leaving,淡出结束后从 items 删掉。
   * 系统开了"减少动效"时直接删。重复调用同一个 id 无害。
   */
  const retire = useCallback((ids: number[]): void => {
    if (ids.length === 0) return;
    for (const id of ids) pausedIds.current.delete(id);
    const remove = (): void => {
      setItems((prev) => prev.filter((t) => !ids.includes(t.id)));
      setLeaving((prev) => {
        const next = new Set(prev);
        for (const id of ids) next.delete(id);
        return next;
      });
    };
    if (prefersReducedMotion()) {
      remove();
      return;
    }
    setLeaving((prev) => new Set([...prev, ...ids]));
    setTimeout(remove, MOTION_EXIT_MS);
  }, []);

  const dismiss = useCallback(
    (id: number): void => {
      // FOC-5:若 dismiss 由用户点击 toast 体 / 关闭按钮触发,activeElement
      // 会是 toast button → toast 立即 unmount → 焦点漂到 body。
      // 检测 active 是否在 .toast 内,是的话 dismiss 后归还焦点给 xterm。
      // 自动 ticker dismiss 时 activeElement 不在 toast,focus.ts 工具会
      // no-op(只在 body / null 时才动)。
      const active = document.activeElement;
      const triggeredByUser = !!(active && active.closest('.toast'));
      // 淡出期间 toast 还在 DOM 里,焦点会留在它的按钮上,focusTerminalDom 只在焦点
      // 落回 body 时才动手。先放掉焦点,效果与立即卸载相同。
      if (triggeredByUser && active instanceof HTMLElement) active.blur();
      retire([id]);
      if (triggeredByUser) focusTerminalDom();
    },
    [retire],
  );

  const push = useCallback((t: ToastInput): void => {
    const id = nextId.current++;
    const toast: Toast = { id, bornAt: Date.now(), ...t };
    setItems((prev) => [toast, ...prev].slice(0, 6)); // 最多堆 6 条
  }, []);

  // 单一 ticker 检查每条是否到期,500ms 间隔(对 4s 时长足够精度)。
  // P2-19:空 items 时不启 timer — 早期实现空 deps,即便没 toast 也每 500ms
  // 触发一次 setState(空 filter,React 浅比较跳过 re-render,但仍占 event loop)。
  // 依赖 items.length:从 0→1 启 timer,1→0 停 timer。toast 在的期间 length 可能
  // 变化(同时 push/dismiss),但 setInterval 重启不影响功能。
  useEffect(() => {
    if (items.length === 0) return undefined;
    const timer = setInterval(() => {
      const now = Date.now();
      const expired = itemsRef.current
        .filter((t) => {
          if (leavingRef.current.has(t.id) || pausedIds.current.has(t.id)) return false;
          const dur = t.durationMs ?? (t.kind === 'error' ? 8000 : 4000);
          return now - t.bornAt >= dur;
        })
        .map((t) => t.id);
      retire(expired);
    }, 500);
    return () => clearInterval(timer);
  }, [items.length, retire]);

  const api = useMemo<ToastApi>(() => ({ push, dismiss }), [push, dismiss]);

  return (
    <Ctx.Provider value={api}>
      {children}
      <div className="toast-container" role="status" aria-live="polite">
        {items.map((t) => (
          <div
            key={t.id}
            className={`toast toast-${t.kind}${leaving.has(t.id) ? ' leaving' : ''}`}
            onMouseEnter={() => pausedIds.current.add(t.id)}
            onMouseLeave={() => pausedIds.current.delete(t.id)}
            onClick={() => dismiss(t.id)}
          >
            <span className="toast-icon" aria-hidden="true">
              {t.kind === 'error' || t.kind === 'warn' ? (
                <Icon name="alertTriangle" size={14} />
              ) : (
                <Icon name="circleDot" size={14} />
              )}
            </span>
            <span className="toast-message">{t.message}</span>
            {t.actions && t.actions.length > 0 && (
              <span className="toast-actions">
                {t.actions.map((a) => (
                  <button
                    key={a.label}
                    type="button"
                    className="toast-action"
                    onClick={(e) => {
                      e.stopPropagation();
                      a.onClick();
                      dismiss(t.id);
                    }}
                  >
                    {a.label}
                  </button>
                ))}
              </span>
            )}
            <button
              type="button"
              className="toast-close"
              onClick={(e) => {
                e.stopPropagation();
                dismiss(t.id);
              }}
              aria-label="关闭通知"
            >
              <Icon name="close" size={12} />
            </button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}
