/**
 * @file src/renderer/components/Modal.tsx
 * @purpose 自绘 Modal Provider — 替换 window.confirm / window.prompt。
 *
 *   原生 dialog 在 Electron 里是 Chromium 同步 modal,关闭后焦点归还行为
 *   不可控(多数情况下漂到 document.body 而非弹出前的 activeElement)。
 *   这就是用户主诉"粘贴后打不进字必须关窗口重开"的根因(CPB-P2)。
 *
 *   本组件:
 *   - 自绘 backdrop + 中央 panel
 *   - 焦点 trap(Tab 在 panel 内循环;Esc 走 cancel;backdrop 点击不关闭,
 *     避免误操作 — 多行粘贴尤其要避免"点了 backdrop 一下就关掉"丢警告)
 *   - 关闭时归还 previousActiveElement(同 ContextMenuProvider 模式)
 *   - 异步 API:confirm/prompt 返回 Promise,让 await 风格的调用点干净
 *
 * @模式仿:src/renderer/components/ContextMenu.tsx
 *
 * @CSS:复用 global.css 的 --surface / --overlay / --text 等主题变量
 *   + 新增 .app-modal-backdrop / .app-modal-panel / .app-modal-button
 *
 * @对应审计条目:CPB-P2(取代 window.confirm)、FOC-5(焦点 trap + 归还)
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
import { useOverlayRegistration } from '../ui-overlay-stack';
import { usePresence } from '../motion';

// ──────────────────────────────────────────────────────────────────
// API 形状
// ──────────────────────────────────────────────────────────────────

export interface ConfirmOptions {
  title: string;
  /** 主体文字(纯文本,可含 \n;不支持 HTML 防注入) */
  message: string;
  /** 可选预览块(等宽字体显示,用于多行粘贴预览) */
  preview?: string;
  /** 默认 "确定" */
  confirmLabel?: string;
  /** 默认 "取消" */
  cancelLabel?: string;
  /** 危险操作 — confirm 按钮变红 */
  danger?: boolean;
}

export interface PromptOptions {
  title: string;
  message?: string;
  defaultValue?: string;
  placeholder?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** password 不回显,给 SSH 登录提示用。默认 text */
  inputType?: 'text' | 'password';
}

export interface ChoiceButton {
  /** choose() 返回的值 */
  id: string;
  label: string;
  /** 默认焦点落在它上面;最多一个 */
  primary?: boolean;
  danger?: boolean;
}

/** 两个以上选项的问题 (ADR-037 的"整体重载 / 只更新");Esc 或"取消"返回 null */
export interface ChooseOptions {
  title: string;
  message: string;
  choices: ChoiceButton[];
  /** 默认 "取消" */
  cancelLabel?: string;
}

export interface ModalApi {
  /** 返回 true=确认 false=取消(同 window.confirm 语义但 async) */
  confirm(opts: ConfirmOptions): Promise<boolean>;
  /** 返回输入字符串,取消返回 null(同 window.prompt 语义) */
  prompt(opts: PromptOptions): Promise<string | null>;
  /** 返回选中按钮的 id,取消返回 null */
  choose(opts: ChooseOptions): Promise<string | null>;
  /**
   * 从外部收起当前 modal,按取消处理(confirm → false,prompt → null)。
   * 给"提问方已经不需要答案"的场景用,比如 ssh 连接在用户回答前就断了。
   */
  dismiss(): void;
}

const Ctx = createContext<ModalApi | null>(null);

export function useModal(): ModalApi {
  const v = useContext(Ctx);
  if (!v) throw new Error('[Modal] useModal must be inside <ModalProvider>');
  return v;
}

// ──────────────────────────────────────────────────────────────────
// 内部 state 形状
// ──────────────────────────────────────────────────────────────────

interface ConfirmState extends ConfirmOptions {
  kind: 'confirm';
  resolve: (v: boolean) => void;
}

interface PromptState extends PromptOptions {
  kind: 'prompt';
  resolve: (v: string | null) => void;
}

interface ChooseState extends ChooseOptions {
  kind: 'choose';
  resolve: (v: string | null) => void;
}

type ModalState = ConfirmState | PromptState | ChooseState;

/** 取消 (Esc / 取消按钮 / dismiss) 时各种 modal 的返回值 */
function resolveCancel(modal: ModalState): void {
  if (modal.kind === 'confirm') modal.resolve(false);
  else modal.resolve(null);
}

// ──────────────────────────────────────────────────────────────────
// Provider
// ──────────────────────────────────────────────────────────────────

export function ModalProvider({ children }: { children: ReactNode }): JSX.Element {
  const [modal, setModal] = useState<ModalState | null>(null);
  // dismiss 由 useMemo 里的稳定 api 调用,拿不到最新的 modal state,所以走 ref
  const modalRef = useRef<ModalState | null>(null);
  modalRef.current = modal;
  const previousActiveElementRef = useRef<Element | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [promptValue, setPromptValue] = useState('');

  // 打开 Modal 前捕获焦点;同一时刻只允许一个 modal(再 open 时拒绝 — 实际
  // 不会发生,因为 confirm/prompt 是 await 串行)。
  const openModal = useCallback((state: ModalState) => {
    if (!previousActiveElementRef.current) {
      previousActiveElementRef.current = document.activeElement;
    }
    if (state.kind === 'prompt') {
      setPromptValue(state.defaultValue ?? '');
    }
    setModal(state);
  }, []);

  // 关闭 + 归还焦点。归还策略同 ContextMenu:仅在 activeElement 已落回
  // body / null 时归还,避免覆盖 caller 在 resolve 回调里设置的焦点。
  const closeModal = useCallback(() => {
    const prev = previousActiveElementRef.current;
    previousActiveElementRef.current = null;
    // 关闭后面板还要淡出 150ms(见 usePresence),期间 DOM 节点不卸载,焦点
    // 会一直留在面板的按钮上,下面"只在焦点落回 body 时归还"的判断就永远不成立。
    // 先把焦点放掉,归还逻辑与没有退场动画时完全一样。
    const active = document.activeElement;
    if (active instanceof HTMLElement && panelRef.current?.contains(active)) active.blur();
    setModal(null);
    if (!prev) return;
    requestAnimationFrame(() => {
      const cur = document.activeElement;
      if (cur && cur !== document.body && cur !== document.documentElement) return;
      if (prev instanceof HTMLElement && document.body.contains(prev)) {
        prev.focus();
      } else {
        // prev 已 unmount(如 xterm 重挂),fallback 到 .xterm-helper-textarea
        const ta = document.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea');
        ta?.focus();
      }
    });
  }, []);

  const api = useMemo<ModalApi>(
    () => ({
      confirm: (opts) =>
        new Promise<boolean>((resolve) => {
          openModal({ kind: 'confirm', ...opts, resolve });
        }),
      prompt: (opts) =>
        new Promise<string | null>((resolve) => {
          openModal({ kind: 'prompt', ...opts, resolve });
        }),
      choose: (opts) =>
        new Promise<string | null>((resolve) => {
          openModal({ kind: 'choose', ...opts, resolve });
        }),
      dismiss: () => {
        const current = modalRef.current;
        if (!current) return;
        resolveCancel(current);
        closeModal();
      },
    }),
    [openModal, closeModal],
  );

  // KBD-1:接入 UiOverlayStack — modal 在 mount 时 push,unmount 时 pop。
  // Esc/Enter 响应前先问 isTop(),只有当前栈顶 overlay 吃,嵌套场景
  // (Modal 内点按钮触发另一个 Modal,或 Modal + ContextMenu 同时存在)
  // 顺序可预测,Esc 永远从最上层关起。
  const { isTop } = useOverlayRegistration(!!modal);

  // Esc 关闭 = cancel;Enter 在 confirm modal 走确认,prompt modal 在
  // input 自己的 onKeyDown 里处理(避免冲突)。Tab/Shift+Tab 在 panel 内循环
  // (OVR-1 焦点 trap — 头部注释承诺过但原实现只做 mount 聚焦,Tab 仍能漏出 panel)。
  useEffect(() => {
    if (!modal) return undefined;
    const onKey = (e: KeyboardEvent): void => {
      // KBD-1 IME 守卫:中文 / 日文 / 韩文 IME composition 期间
      // (isComposing 或 keyCode===229)所有 Enter / Esc 透传给 IME 状态机。
      // 否则用户输入到一半敲 Enter 选词会被 Modal 误吃 → modal 提前关闭、
      // IME 状态机卡死。所有全局 window keydown listener 必须有此守卫。
      if (e.isComposing || e.keyCode === 229) return;
      // KBD-1 overlay stack:我不是栈顶就不响应,让上层 overlay 吃
      if (!isTop()) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        resolveCancel(modal);
        closeModal();
      } else if (e.key === 'Enter' && modal.kind === 'confirm') {
        // 仅 confirm modal 走全局 Enter;prompt 让 input onKeyDown 自处理
        const tgt = e.target as HTMLElement | null;
        if (tgt?.tagName === 'TEXTAREA' || tgt?.tagName === 'INPUT') return;
        e.preventDefault();
        modal.resolve(true);
        closeModal();
      } else if (e.key === 'Tab') {
        // 焦点 trap:查 panel 内所有可聚焦元素,Tab 在尾→头,Shift+Tab 在头→尾。
        const panel = panelRef.current;
        if (!panel) return;
        const focusables = panel.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
        );
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (!first || !last) return;
        const active = document.activeElement as HTMLElement | null;
        // 焦点不在 panel 内(可能被外部脚本抢走)→ 把它拉回 panel 首项
        if (!active || !panel.contains(active)) {
          e.preventDefault();
          first.focus();
          return;
        }
        if (e.shiftKey && active === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [modal, closeModal, isTop]);

  // mount 后聚焦默认按钮(confirm)或 input(prompt),给用户键盘可用入口
  useEffect(() => {
    if (!modal) return;
    requestAnimationFrame(() => {
      const panel = panelRef.current;
      if (!panel) return;
      if (modal.kind === 'prompt') {
        const input = panel.querySelector<HTMLInputElement>('.app-modal-input');
        input?.focus();
        input?.select();
      } else {
        // confirm 焦点默认在 confirm 按钮(用户多数 Enter 一键确认)
        const btn = panel.querySelector<HTMLButtonElement>('.app-modal-button-primary');
        btn?.focus();
      }
    });
  }, [modal]);

  const handleConfirm = (): void => {
    if (!modal) return;
    if (modal.kind === 'confirm') {
      modal.resolve(true);
    } else if (modal.kind === 'prompt') {
      modal.resolve(promptValue);
    } else {
      // choose 没有单一的"确定":Enter 由焦点所在的选项按钮自己处理
      return;
    }
    closeModal();
  };

  const handleChoice = (id: string): void => {
    if (!modal || modal.kind !== 'choose') return;
    modal.resolve(id);
    closeModal();
  };

  const handleCancel = (): void => {
    if (!modal) return;
    resolveCancel(modal);
    closeModal();
  };

  // 退场:关闭后用最后一个 modal 的内容再渲染 150ms,播完 motion.css 的淡出再卸载。
  // 残影带 .exiting(pointer-events: none、aria-hidden),上面的键盘监听和 overlay
  // 栈都只看真实的 modal,所以残影不响应任何输入。
  const { shown, exiting } = usePresence(modal);

  return (
    <Ctx.Provider value={api}>
      {children}
      {shown && (
        <div
          // app-modal-host 把它抬到其它 .app-modal-backdrop 之上:TagSettings 这类对话框
          // 用 createPortal 挂在 body 末尾,同 z-index 时后来者在上,会盖住它们自己弹出的 confirm。
          className={'app-modal-backdrop app-modal-host' + (exiting ? ' exiting' : '')}
          role="presentation"
          aria-hidden={exiting || undefined}
        >
          <div
            ref={panelRef}
            className={
              'app-modal-panel' + (shown.kind === 'confirm' && shown.danger ? ' danger' : '')
            }
            role="dialog"
            aria-modal="true"
            aria-label={shown.title}
          >
            <div className="app-modal-title">{shown.title}</div>
            {shown.kind === 'confirm' && (
              <>
                <div className="app-modal-message">{shown.message}</div>
                {shown.preview && <pre className="app-modal-preview">{shown.preview}</pre>}
              </>
            )}
            {shown.kind === 'choose' && <div className="app-modal-message">{shown.message}</div>}
            {shown.kind === 'prompt' && (
              <>
                {shown.message && <div className="app-modal-message">{shown.message}</div>}
                <input
                  type={shown.inputType ?? 'text'}
                  className="app-modal-input"
                  value={promptValue}
                  placeholder={shown.placeholder ?? ''}
                  onChange={(e) => setPromptValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      handleConfirm();
                    } else if (e.key === 'Escape') {
                      e.preventDefault();
                      handleCancel();
                    }
                  }}
                />
              </>
            )}
            <div className="app-modal-actions">
              <button type="button" className="app-modal-button" onClick={handleCancel}>
                {shown.cancelLabel ?? '取消'}
              </button>
              {shown.kind === 'choose' ? (
                shown.choices.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    className={
                      'app-modal-button' +
                      (c.primary ? ' app-modal-button-primary' : '') +
                      (c.danger ? ' danger' : '')
                    }
                    onClick={() => handleChoice(c.id)}
                  >
                    {c.label}
                  </button>
                ))
              ) : (
                <button
                  type="button"
                  className={
                    'app-modal-button app-modal-button-primary' +
                    (shown.kind === 'confirm' && shown.danger ? ' danger' : '')
                  }
                  onClick={handleConfirm}
                >
                  {shown.confirmLabel ?? '确定'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </Ctx.Provider>
  );
}
