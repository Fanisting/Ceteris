/**
 * @file src/renderer/type-ahead-view.ts
 * @purpose Draws the type ahead text of a remote agent tab (ADR-047) where the agent's input
 *   cursor is, with a small "sends on Enter" mark, and keeps it there while the agent redraws.
 *
 * @关键设计:
 * - A DOM overlay above xterm, like local-echo.ts: the terminal buffer stays exactly what the
 *   Host sent. Solid text, not dotted, because this text is certain: it goes out on Enter.
 * - It wraps at the terminal's right edge and grows downward for multi-line prompts.
 * - IME: while a composition is under way the composing text shows at the end of the overlay,
 *   underlined, and xterm's own composition box is hidden (it would sit at the Host's cursor,
 *   on top of the overlay).
 *
 * @对应文档章节:软件定义书.md ADR-047
 * @不要在这里做的事: no decisions about keys; shared/type-ahead.ts owns them.
 */
import type { Terminal } from '@xterm/xterm';
import { trackInputAnchor } from './input-anchor';

export interface TypeAheadView {
  /** Shows the buffered text; an empty string hides the overlay unless an IME is composing. */
  show(text: string): void;
  /** Viewport cell of the agent's input cursor, or null (see input-anchor.ts). */
  inputCell(): { x: number; y: number } | null;
  dispose(): void;
}

/**
 * @param term the terminal, already opened
 * @param label the mark after the text, already translated
 * @param armed true when keys would be held now. Asked when an IME composition starts and on
 *   every draw, so the text hides while an approval prompt or a menu covers the agent's input.
 */
export function attachTypeAheadView(
  term: Terminal,
  label: string,
  armed: () => boolean,
): TypeAheadView {
  const screen = term.element?.querySelector<HTMLElement>('.xterm-screen') ?? null;
  const textarea =
    term.element?.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea') ?? null;
  const overlay = document.createElement('div');
  overlay.className = 'type-ahead-overlay';
  overlay.hidden = true;
  const body = document.createElement('span');
  const composing = document.createElement('span');
  composing.className = 'type-ahead-composing';
  const mark = document.createElement('span');
  mark.className = 'type-ahead-mark';
  mark.textContent = label;
  overlay.append(body, composing, mark);
  screen?.appendChild(overlay);

  const anchor = trackInputAnchor(term);
  let text = '';
  let composition: string | null = null;

  const render = (): void => {
    const at = (text || composition) && screen && armed() ? anchor.at() : null;
    term.element?.classList.toggle('type-ahead-composing-active', composition !== null);
    if (!at || !screen) {
      overlay.hidden = true;
      return;
    }
    const cellWidth = screen.clientWidth / term.cols;
    const cellHeight = screen.clientHeight / term.rows;
    const left = at.x * cellWidth;
    overlay.hidden = false;
    body.textContent = text;
    composing.textContent = composition ?? '';
    overlay.style.left = `${left}px`;
    overlay.style.top = `${at.y * cellHeight}px`;
    overlay.style.width = `${Math.max(cellWidth, screen.clientWidth - left)}px`;
    overlay.style.lineHeight = `${cellHeight}px`;
    overlay.style.fontFamily = term.options.fontFamily ?? 'monospace';
    overlay.style.fontSize = `${term.options.fontSize ?? 13}px`;
    overlay.style.color = term.options.theme?.foreground ?? 'inherit';
    overlay.style.backgroundColor = term.options.theme?.background ?? 'transparent';
  };

  const onStart = (): void => {
    if (!armed()) return;
    composition = '';
    render();
  };
  const onUpdate = (e: CompositionEvent): void => {
    if (composition === null) return;
    composition = e.data;
    render();
  };
  const onEnd = (): void => {
    if (composition === null) return;
    composition = null;
    render();
  };
  textarea?.addEventListener('compositionstart', onStart);
  textarea?.addEventListener('compositionupdate', onUpdate);
  textarea?.addEventListener('compositionend', onEnd);
  const onRender = term.onRender(render);

  return {
    show(next) {
      text = next;
      render();
    },
    inputCell: () => anchor.at(),
    dispose() {
      textarea?.removeEventListener('compositionstart', onStart);
      textarea?.removeEventListener('compositionupdate', onUpdate);
      textarea?.removeEventListener('compositionend', onEnd);
      term.element?.classList.remove('type-ahead-composing-active');
      onRender.dispose();
      anchor.dispose();
      overlay.remove();
    },
  };
}
