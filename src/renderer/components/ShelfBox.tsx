/**
 * @file src/renderer/components/ShelfBox.tsx
 * @purpose The shelf (ADR-036) as the user sees it: a small grey box at the left end of the
 *   tab row that appears when a tab has been put away, a popover listing the shelved tabs
 *   with restore / forget / clear all, and the ghost of a tab sliding into the box.
 *
 * @关键设计:
 * - The box is only on screen while the shelf has something in it, so the tab row of a user
 *   who never shelves looks exactly as before. It pops in when the first tab goes in and
 *   shrinks away after the last one leaves.
 * - Each tab that goes in makes the box bob once (a `receiving` class driven by a counter,
 *   so two tabs in a row bob twice). The tab itself stays as a ghost for SHELF_GHOST_MS and
 *   slides toward the box while it shrinks; store.tsx keeps the ghost in its old place.
 * - Rows leaving the popover (restored or forgotten) linger for SHELF_ROW_EXIT_MS with an
 *   exit class, in the same way motion.ts handles dialogs; "clear all" staggers them.
 * - Restoring claims the new tab for this window and selects its folder, like a click on the
 *   quick launch icons. A restored agent comes back with its conversation when the shelf
 *   kept a resume id; the row says which it will be.
 * - Closing: Esc (only when on top of the overlay stack), a click outside, or any action.
 *
 * @对应文档章节:软件定义书.md ADR-036, 2 (鼠标优先)
 *
 * @不要在这里做的事:
 * - No keyboard shortcuts to open the box (13.2). No confirmation dialogs: forgetting a row
 *   loses only an id, and the tab was already closed when it went in.
 */
import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { COMMAND_CHANNELS, type ShelfRestoreResponse } from '@shared/protocol';
import type { ShelfEntry } from '@shared/shelf';
import { findPathNode, useAppDispatch, useAppState, type ShelfGhost } from '../store';
import { focusTerminalDom } from '../focus';
import { prefersReducedMotion } from '../motion';
import { useOverlayRegistration } from '../ui-overlay-stack';
import { Icon } from './icons';
import { useTranslation } from './LanguageProvider';
import { TemplateIcon } from './TemplateIcon';
import { useToast } from './Toast';

/** How long a shelved tab stays on screen while it slides into the box. Matches shelf.css. */
export const SHELF_GHOST_MS = 420;
/** How long a row stays while it fades out of the list. Matches shelf.css. */
const SHELF_ROW_EXIT_MS = 180;
/** Delay between rows when clearing all. */
const SHELF_ROW_STAGGER_MS = 30;
/** Rows past this one leave together; a long list must not take seconds to clear. */
const SHELF_ROW_STAGGER_MAX = 8;
/** How long the box bobs after receiving a tab. Matches shelf.css. */
const SHELF_RECEIVE_MS = 600;
/** How long the box lingers while it shrinks away after the last entry leaves. */
const SHELF_BOX_EXIT_MS = 220;

/** The storage box: a lid and a body, so the lid can lift when a tab goes in. */
function BoxIcon({ size = 18 }: { size?: number }): JSX.Element {
  return (
    <svg
      className="shelf-box-icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <g className="shelf-box-lid">
        <path d="M3.5 8.5 L5 5.5 H19 L20.5 8.5 Z" />
      </g>
      <g className="shelf-box-body">
        <path d="M4 8.5 H20 V18.5 A1.5 1.5 0 0 1 18.5 20 H5.5 A1.5 1.5 0 0 1 4 18.5 Z" />
        <path d="M10 12.5 H14" />
      </g>
    </svg>
  );
}

/** "3 h ago" style text, short enough for a row. */
function ago(ms: number, tx: (zh: string, en: string) => string): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 1) return tx('刚刚', 'just now');
  if (m < 60) return tx(`${m} 分钟前`, `${m} min ago`);
  const h = Math.round(m / 60);
  if (h < 24) return tx(`${h} 小时前`, `${h} h ago`);
  const d = Math.round(h / 24);
  return tx(`${d} 天前`, `${d} d ago`);
}

function lastSegment(path: string): string {
  return path.match(/[^/\\]+$/)?.[0] ?? path;
}

/**
 * The entries to draw: the live list plus rows that just left, kept for their exit
 * animation. Returns the rows in order and the set of ids on their way out.
 */
function useLeavingRows(entries: ShelfEntry[]): { rows: ShelfEntry[]; leaving: Set<string> } {
  const [held, setHeld] = useState<ShelfEntry[]>(entries);
  const [leaving, setLeaving] = useState<Set<string>>(new Set());
  useEffect(() => {
    const live = new Set(entries.map((e) => e.id));
    const gone = held.filter((e) => !live.has(e.id));
    if (gone.length === 0 || prefersReducedMotion()) {
      setHeld(entries);
      setLeaving(new Set());
      return undefined;
    }
    // Keep the old order: live rows where they were, leaving rows in their old slots.
    const merged = held.filter((e) => live.has(e.id) || gone.includes(e));
    for (const e of entries) if (!merged.some((m) => m.id === e.id)) merged.unshift(e);
    setHeld(merged);
    setLeaving(new Set(gone.map((e) => e.id)));
    const timer = setTimeout(
      () => {
        setHeld(entries);
        setLeaving(new Set());
      },
      SHELF_ROW_EXIT_MS + SHELF_ROW_STAGGER_MS * Math.min(gone.length, SHELF_ROW_STAGGER_MAX),
    );
    return () => clearTimeout(timer);
    // `held` is state this effect owns; re-running on it would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries]);
  return { rows: held, leaving };
}

/** The box at the left end of the tab row, and its popover. */
export function ShelfBox(): JSX.Element | null {
  const { tx } = useTranslation();
  const state = useAppState();
  const dispatch = useAppDispatch();
  const toast = useToast();
  const entries = state.shelf;
  const count = entries.length;

  // Bob once per tab received: a counter in a class name restarts the animation.
  const [bobs, setBobs] = useState(0);
  const lastCount = useRef(count);
  const [bobbing, setBobbing] = useState(false);
  useEffect(() => {
    if (count > lastCount.current) {
      setBobs((n) => n + 1);
      setBobbing(true);
    }
    lastCount.current = count;
  }, [count]);
  useEffect(() => {
    if (!bobbing) return undefined;
    const t = setTimeout(() => setBobbing(false), SHELF_RECEIVE_MS);
    return () => clearTimeout(t);
  }, [bobbing, bobs]);

  const [open, setOpen] = useState(false);

  // When the last entry leaves: an open popover stays long enough for its rows to cascade
  // out, then closes; then the box shrinks away; then nothing is drawn at all.
  const [shown, setShown] = useState(count > 0);
  const [exiting, setExiting] = useState(false);
  useLayoutEffect(() => {
    if (count > 0) {
      setShown(true);
      setExiting(false);
    }
  }, [count]);
  useEffect(() => {
    if (count !== 0 || !shown) return undefined;
    const reduced = prefersReducedMotion();
    const popDelay =
      open && !reduced ? SHELF_ROW_EXIT_MS + SHELF_ROW_STAGGER_MS * SHELF_ROW_STAGGER_MAX + 60 : 0;
    const t1 = setTimeout(() => {
      setOpen(false);
      setExiting(true);
    }, popDelay);
    const t2 = setTimeout(
      () => {
        setShown(false);
        setExiting(false);
      },
      popDelay + (reduced ? 0 : SHELF_BOX_EXIT_MS),
    );
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [count, shown, open]);

  const { isTop } = useOverlayRegistration(open);
  const popRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  // The tab bar clips its overflow, so the popover is rendered at the body in a portal and
  // placed under the box by its screen position, measured on open and whenever the window
  // resizes.
  const [popPos, setPopPos] = useState<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    if (!open) {
      setPopPos(null);
      return undefined;
    }
    const place = (): void => {
      const r = buttonRef.current?.getBoundingClientRect();
      if (r) setPopPos({ top: r.bottom + 6, left: Math.max(4, r.left - 4) });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [open]);
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent): void => {
      if (e.isComposing || e.keyCode === 229) return;
      if (!isTop()) return;
      if (e.key === 'Escape') setOpen(false);
    };
    const onDown = (e: Event): void => {
      const t = e.target as Node | null;
      if (t && (popRef.current?.contains(t) || buttonRef.current?.contains(t))) return;
      setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDown);
    };
  }, [open, isTop]);

  const { rows, leaving } = useLeavingRows(entries);
  const [clearing, setClearing] = useState(false);

  const restore = async (entry: ShelfEntry): Promise<void> => {
    const dims = state.lastTerminalDims;
    try {
      const res = await window.api.invoke<unknown, ShelfRestoreResponse>(
        COMMAND_CHANNELS.SHELF_RESTORE,
        { entryId: entry.id, cols: dims.cols, rows: dims.rows },
      );
      dispatch({ type: 'view/select-path', pathId: res.session.pathId });
      dispatch({ type: 'view/select-session', sessionId: res.session.id });
      setOpen(false);
      focusTerminalDom();
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      toast.push({
        kind: 'error',
        message: tx(`恢复标签失败:${reason}`, `Could not bring the tab back: ${reason}`),
      });
    }
  };

  const forget = (entry: ShelfEntry, e: MouseEvent): void => {
    e.stopPropagation();
    window.api
      .invoke(COMMAND_CHANNELS.SHELF_REMOVE, { entryId: entry.id })
      .catch((err) => console.error('[ShelfBox] remove failed', err));
  };

  const clearAll = (): void => {
    setClearing(true);
    window.api
      .invoke(COMMAND_CHANNELS.SHELF_CLEAR, undefined)
      .catch((err) => console.error('[ShelfBox] clear failed', err))
      .finally(() => setClearing(false));
  };

  if (!shown) return null;

  const title =
    count === 1
      ? tx('收纳盒:1 个标签', 'Shelf: 1 tab')
      : tx(`收纳盒:${count} 个标签`, `Shelf: ${count} tabs`);

  return (
    <div className={`shelf-box${exiting ? ' exiting' : ''}`}>
      <button
        ref={buttonRef}
        type="button"
        className={`shelf-box-button${open ? ' open' : ''}${bobbing ? ' receiving' : ''}`}
        key={bobs}
        onClick={() => setOpen((v) => !v)}
        title={title}
        aria-label={title}
        aria-expanded={open}
        aria-haspopup="dialog"
        data-guide="shelf-box"
      >
        <BoxIcon />
        {count > 0 && <span className="shelf-box-count">{count > 99 ? '99+' : count}</span>}
      </button>
      {open &&
        popPos &&
        createPortal(
          <div
            ref={popRef}
            className="shelf-pop"
            role="dialog"
            aria-label={title}
            style={{ top: popPos.top, left: popPos.left }}
          >
            <div className="shelf-pop-head">
              <span className="shelf-pop-title">{tx('收纳盒', 'Shelf')}</span>
              <button
                type="button"
                className="shelf-pop-clear"
                onClick={clearAll}
                disabled={clearing || count === 0}
              >
                {tx('清空', 'Clear all')}
              </button>
            </div>
            <ul className="shelf-list">
              {rows.map((entry, i) => {
                const template = state.templates.find((t) => t.id === entry.templateId);
                const node = findPathNode(state.pathTree, entry.pathId);
                const folder = node?.displayName ?? lastSegment(node?.path ?? entry.cwd);
                const out = leaving.has(entry.id);
                const resumes = entry.resume !== null;
                return (
                  <li
                    key={entry.id}
                    className={`shelf-row${out ? ' leaving' : ''}`}
                    // Rows enter one after another; they only leave one after another when
                    // the whole list is cleared. A single forgotten row goes at once.
                    style={{
                      animationDelay: `${
                        out && leaving.size <= 1
                          ? 0
                          : Math.min(i, SHELF_ROW_STAGGER_MAX) * SHELF_ROW_STAGGER_MS
                      }ms`,
                    }}
                  >
                    <button
                      type="button"
                      className="shelf-row-main"
                      onClick={() => void restore(entry)}
                      disabled={out}
                      title={
                        resumes
                          ? tx('打开并接着上次的对话', 'Open and continue the conversation')
                          : tx('重新打开(新的会话)', 'Open again (fresh session)')
                      }
                    >
                      <span className="shelf-row-icon">
                        {template ? (
                          <TemplateIcon template={template} size={16} />
                        ) : (
                          <Icon name="templateShell" size={16} />
                        )}
                      </span>
                      <span className="shelf-row-text">
                        <span className="shelf-row-name">{entry.displayName}</span>
                        <span className="shelf-row-meta">
                          <span className="shelf-row-folder">{folder}</span>
                          <span className="shelf-row-dot" aria-hidden="true">
                            ·
                          </span>
                          <span>{ago(Date.now() - entry.shelvedAt, tx)}</span>
                          {resumes && (
                            <span className="shelf-row-resume">{tx('可续聊', 'resumes')}</span>
                          )}
                        </span>
                      </span>
                    </button>
                    <button
                      type="button"
                      className="shelf-row-forget"
                      onClick={(e) => forget(entry, e)}
                      disabled={out}
                      title={tx('从收纳盒移除', 'Remove from the shelf')}
                      aria-label={tx(`移除 ${entry.displayName}`, `Remove ${entry.displayName}`)}
                    >
                      <Icon name="close" size={14} />
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>,
          document.body,
        )}
    </div>
  );
}

/**
 * The ghost of a tab sliding into the box. Drawn by TabBar in the tab's old place; unmounts
 * itself through the store once the animation is over.
 */
export function ShelfGhostTab({ ghost }: { ghost: ShelfGhost }): JSX.Element {
  const dispatch = useAppDispatch();
  const id = ghost.session.id;
  useEffect(() => {
    const t = setTimeout(
      () => dispatch({ type: 'shelf/ghost-done', sessionId: id }),
      prefersReducedMotion() ? 0 : SHELF_GHOST_MS,
    );
    return () => clearTimeout(t);
  }, [dispatch, id]);
  return (
    <div className="tab tab-shelving" aria-hidden="true">
      <span className="tab-name">{ghost.session.displayName}</span>
    </div>
  );
}
