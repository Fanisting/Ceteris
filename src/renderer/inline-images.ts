/**
 * @file inline-images.ts
 * @purpose Renderer half of the "Claude Code formula images" extension (ADR-018,
 *          settings.extensions.claudeMathImages): lets programs draw pictures with the iTerm2
 *          inline image protocol (OSC 1337 File=), says so through XTVERSION, and reports the
 *          terminal's colours and cell shape to main for the latex-math plugin.
 *
 * @关键设计:
 * - @xterm/addon-image draws the pictures. Only its iTerm2 decoder is on; sixel and kitty stay off,
 *   because Claude Code places kitty pictures with Unicode placeholders, which xterm.js lacks.
 * - Claude Code draws pictures only when XTVERSION names iTerm2 3.5 or later, so CSI > q is
 *   answered as "iTerm2 3.5.0" instead of xterm.js's name while the extension is on.
 * - The main process passes OSC 1337 File= through untouched (osc1337-parser.ts), blanks Claude
 *   Code's placeholder cells (placeholder-filter.ts) and uses the bundled ConPTY on Windows.
 * - The addon decodes base64 with WebAssembly, so the CSP in src/main/index.ts allows
 *   'wasm-unsafe-eval'. Without it the handler throws and the terminal stops drawing output.
 *
 * @不要在这里做的事:
 * - Do not parse OSC 1337 CurrentDir here: the main process owns it.
 */
import { ImageAddon } from '@xterm/addon-image';
import type { ITheme, Terminal } from '@xterm/xterm';
import { COMMAND_CHANNELS } from '@shared/protocol';

/** The XTVERSION name. Claude Code reads /^iTerm2\s/ and a version of at least 3.5.0. */
const XTVERSION_NAME = 'iTerm2 3.5.0';

/**
 * Loads the image addon and the XTVERSION answer onto one terminal.
 *
 * @returns a function that removes both again (the setting was turned off, or the view unmounts)
 */
export function activateInlineImages(term: Terminal): () => void {
  const images = new ImageAddon({ sixelSupport: false, kittySupport: false, iipSupport: true });
  term.loadAddon(images);

  // XTVERSION is CSI > q or CSI > 0 q; the answer is DCS > | name ST. Returning true stops
  // xterm.js from sending its own answer. term.input with wasUserInput=false goes out through
  // onData to the PTY, the same path as xterm.js's built-in replies.
  const xtversion = term.parser.registerCsiHandler({ prefix: '>', final: 'q' }, (params) => {
    if (params.length > 1 || (params.length === 1 && params[0] !== 0)) return false;
    term.input(`\x1bP>|${XTVERSION_NAME}\x1b\\`, false);
    return true;
  });

  return () => {
    xtversion.dispose();
    images.dispose();
  };
}

/** #rgb or #rrggbb to #rrggbb; anything else (rgba(), names) to null. */
function toHex(colour: string | undefined): string | null {
  if (!colour) return null;
  const long = /^#([0-9a-fA-F]{6})$/.exec(colour);
  if (long) return `#${long[1]!.toLowerCase()}`;
  const short = /^#([0-9a-fA-F])([0-9a-fA-F])([0-9a-fA-F])$/.exec(colour);
  if (short)
    return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`.toLowerCase();
  return null;
}

/** CSS cell size from xterm's render service; 0 before the first render. Private API. */
function cellSize(term: Terminal): { width: number; height: number } {
  const core = (
    term as unknown as {
      _core?: {
        _renderService?: { dimensions?: { css?: { cell?: { width: number; height: number } } } };
      };
    }
  )._core;
  return core?._renderService?.dimensions?.css?.cell ?? { width: 0, height: 0 };
}

/**
 * Sends this terminal's foreground, background and cell aspect to main once the terminal has
 * rendered (cell size is 0 before that; tried for up to about 3 seconds).
 *
 * @returns a function that cancels a report still waiting
 */
export function reportTerminalLook(term: Terminal, theme: ITheme): () => void {
  const foreground = toHex(theme.foreground);
  const background = toHex(theme.background);
  if (!foreground || !background) return () => undefined;
  let tries = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const attempt = (): void => {
    const cell = cellSize(term);
    if (cell.width > 0 && cell.height > 0) {
      const payload = { foreground, background, cellAspect: cell.width / cell.height };
      window.api
        .invoke(COMMAND_CHANNELS.EXTENSIONS_REPORT_TERMINAL_LOOK, payload)
        .catch((err: unknown) => console.warn('[inline-images] report terminal look failed', err));
      return;
    }
    if (++tries < 30) timer = setTimeout(attempt, 100);
  };
  attempt();
  return () => {
    if (timer !== undefined) clearTimeout(timer);
  };
}
