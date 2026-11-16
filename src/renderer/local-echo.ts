/**
 * @file src/renderer/local-echo.ts
 * @purpose Draws predicted keystrokes for remote terminals. The decisions live in
 *   shared/local-echo-model.ts; this file only places them on screen.
 *
 * The overlay is a DOM node above xterm, not terminal output, so the buffer stays exactly
 * what the Host sent. It is dotted-underlined so a prediction can be told from real text.
 *
 * Where to draw comes from input-anchor.ts.
 */
import type { Terminal } from '@xterm/xterm';
import { LocalEchoModel } from '@shared/local-echo-model';
import { trackInputAnchor } from './input-anchor';

const TICK_MS = 100;

export interface LocalEcho {
  /** @returns an id to pass to ack once the Host accepts the key, or null */
  noteInput(data: string): number | null;
  ack(id: number): void;
  noteOutput(text: string): void;
  reset(): void;
  dispose(): void;
}

export function attachLocalEcho(term: Terminal): LocalEcho {
  const model = new LocalEchoModel();
  const screen = term.element?.querySelector<HTMLElement>('.xterm-screen') ?? null;
  const overlay = document.createElement('div');
  overlay.className = 'local-echo-overlay';
  overlay.hidden = true;
  screen?.appendChild(overlay);

  const anchor = trackInputAnchor(term);

  const render = (): void => {
    const text = model.text;
    const at = text && screen ? anchor.at() : null;
    if (!at || !screen) {
      overlay.hidden = true;
      return;
    }
    const cellWidth = screen.clientWidth / term.cols;
    const cellHeight = screen.clientHeight / term.rows;
    overlay.hidden = false;
    overlay.textContent = text;
    overlay.style.left = `${at.x * cellWidth}px`;
    overlay.style.top = `${at.y * cellHeight}px`;
    overlay.style.height = `${cellHeight}px`;
    overlay.style.lineHeight = `${cellHeight}px`;
    overlay.style.fontFamily = term.options.fontFamily ?? 'monospace';
    overlay.style.fontSize = `${term.options.fontSize ?? 13}px`;
    overlay.style.color = term.options.theme?.foreground ?? 'inherit';
    overlay.style.backgroundColor = term.options.theme?.background ?? 'transparent';
  };

  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = (): void => {
    if (timer !== null || !model.busy) return;
    timer = setTimeout(() => {
      timer = null;
      if (model.tick(Date.now())) render();
      schedule();
    }, TICK_MS);
  };

  const onRender = term.onRender(render);

  return {
    noteInput(data) {
      const id = model.noteInput(data, Date.now());
      render();
      schedule();
      return id;
    },
    ack(id) {
      model.noteAck(id, Date.now());
      render();
    },
    noteOutput(text) {
      model.noteOutput(Date.now(), text);
      render();
    },
    reset() {
      model.reset();
      render();
    },
    dispose() {
      if (timer !== null) clearTimeout(timer);
      onRender.dispose();
      anchor.dispose();
      overlay.remove();
    },
  };
}
