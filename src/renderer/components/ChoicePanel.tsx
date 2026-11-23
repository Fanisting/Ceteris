/**
 * @file src/renderer/components/ChoicePanel.tsx
 * @purpose The expanded part of the "waiting for your decision" toast (ADR-035): the prompt
 *   an agent stopped at, shown as the agent drew it on its tab's screen, answered from here.
 *   Covers every shape Claude Code draws: approval boxes with their command or diff, single
 *   and multi-select AskUserQuestion with descriptions and previews, its "Type something"
 *   field, "Chat about this", the pages of a several-question prompt and their review page.
 *
 * @关键设计:
 * - Main owns the screen. The panel shows the rows cmd:session:read-choice returns (styled
 *   runs from the prompt's top rule to its footer) and asks cmd:session:answer-choice to
 *   act; main re-reads the screen before every keystroke, so a panel that went stale cannot
 *   type into whatever the agent does next.
 * - A copy, not a rebuild (2026-11-22): the rows keep the agent's colours, marks and
 *   layout, mapped through the current terminal theme. Each option's rows are one button.
 * - The expanded toast spans the tab page minus 16px on each side, so a prompt drawn for
 *   the tab's width fits; the font shrinks only when the rows are still wider than that.
 * - After each action the panel polls read-choice until the rows change, because one
 *   prompt can have several pages: answering page one shows page two in the same toast.
 *   When the prompt is gone the agent is working again, and the bridge closes the toast.
 * - Text answers open a one-line field under the copy. "Type something" needs text;
 *   "Chat about this" (and an approval's "No, and tell Claude") may go without, which just
 *   leaves the prompt, as pressing Enter there would.
 *
 * @对应文档章节:软件定义书.md ADR-035;ipc-protocol.md cmd:session:read-choice / answer-choice
 * @不要在这里做的事:
 * - Do not send keys from here. All typing goes through main's answer-choice, which knows
 *   the pointer position and checks the screen between stages.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
} from 'react';
import type { ITheme } from '@xterm/xterm';
import {
  COMMAND_CHANNELS,
  type AnswerChoicePayload,
  type AnswerChoiceReason,
  type AnswerChoiceResponse,
  type ReadChoicePayload,
  type ReadChoiceResponse,
} from '@shared/protocol';
import type { ChoiceOption, ScreenRun } from '@shared/types';
import { useTranslation } from './LanguageProvider';
import { useAppState } from '../store';
import { LIGHT_THEME_MIN_CONTRAST, getXtermTheme, isLightTheme } from './TerminalView';

/** How often the panel re-reads the prompt after an action, and for how long at most. */
const SETTLE_POLL_MS = 200;
const SETTLE_TIMEOUT_MS = 3000;

/** The placeholder label of AskUserQuestion's text field before anything is typed there. */
const TYPE_PLACEHOLDER = /^(?:Type something\.?|Other)$/;

/** Gap between the expanded toast and each side of the tab page. */
const PAGE_GAP_PX = 16;
/** The copy never gets smaller than this, however wide the agent drew it; it scrolls instead. */
const MIN_FONT_PX = 9;

/** The 16 theme colours in ANSI order. */
const ANSI_KEYS = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite',
] as const;

/** xterm's own colour for palette index 16-255: a 6x6x6 cube, then 24 greys. */
function cubeColour(i: number): string {
  const hex = (v: number): string => v.toString(16).padStart(2, '0');
  if (i >= 232) {
    const g = 8 + (i - 232) * 10;
    return '#' + hex(g) + hex(g) + hex(g);
  }
  const n = i - 16;
  const step = (v: number): number => (v === 0 ? 0 : 55 + v * 40);
  return '#' + hex(step(Math.floor(n / 36))) + hex(step(Math.floor(n / 6) % 6)) + hex(step(n % 6));
}

/** A run's colour as CSS, through the theme the tab itself uses. */
function cssColour(c: number | string | undefined, theme: ITheme): string | undefined {
  if (c === undefined || typeof c === 'string') return c;
  if (c < 16) return theme[ANSI_KEYS[c]!];
  return theme.extendedAnsi?.[c - 16] ?? cubeColour(c);
}

function rgbOf(c: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{6})$/i.exec(c);
  if (!m) return null;
  const n = parseInt(m[1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function luminance([r, g, b]: [number, number, number]): number {
  const lin = (v: number): number => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(a: [number, number, number], b: [number, number, number]): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * The tab's minimumContrastRatio, done by hand: on light themes the terminal darkens text
 * that is too faint for its background (Claude Code paints its question #ffffff, meant
 * for a dark terminal). Darkens in 10% steps as xterm does; returns `fg` when it is fine.
 */
function withContrast(fg: string, bg: string, min: number): string {
  let c = rgbOf(fg);
  const b = rgbOf(bg);
  if (!c || !b || min <= 1) return fg;
  while (contrast(c, b) < min && c.some((v) => v > 0)) {
    c = c.map((v) => v - Math.max(1, Math.ceil(v * 0.1))).map((v) => Math.max(0, v)) as [
      number,
      number,
      number,
    ];
  }
  return '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
}

function runStyle(run: ScreenRun, theme: ITheme, minContrast: number): CSSProperties | undefined {
  let fg = cssColour(run.fg, theme);
  let bg = cssColour(run.bg, theme);
  if (run.inverse) [fg, bg] = [bg ?? theme.background, fg ?? theme.foreground];
  if (fg && minContrast > 1) fg = withContrast(fg, bg ?? theme.background ?? '', minContrast);
  if (!fg && !bg && !run.bold && !run.dim && !run.italic && !run.underline) return undefined;
  return {
    color: fg,
    backgroundColor: bg,
    fontWeight: run.bold ? 700 : undefined,
    opacity: run.dim ? 0.55 : undefined,
    fontStyle: run.italic ? 'italic' : undefined,
    textDecoration: run.underline ? 'underline' : undefined,
  };
}

/** One row of the agent's screen. A blank row keeps its height. */
function ScreenRow({
  runs,
  theme,
  minContrast,
}: {
  runs: ScreenRun[];
  theme: ITheme;
  minContrast: number;
}): JSX.Element {
  return (
    <div className="toast-choice-row">
      {runs.length === 0
        ? ' '
        : runs.map((r, i) => (
            <span key={i} style={runStyle(r, theme, minContrast)}>
              {r.text}
            </span>
          ))}
    </div>
  );
}

function readChoice(sessionId: string): Promise<ReadChoiceResponse> {
  return window.api.invoke<ReadChoicePayload, ReadChoiceResponse>(
    COMMAND_CHANNELS.SESSION_READ_CHOICE,
    { sessionId },
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Widens the toast holding `el` to the tab page minus PAGE_GAP_PX a side, and keeps it so
 * while the window resizes. The toast goes back to its own width when the panel closes.
 */
function useTabPageWidth(el: HTMLElement | null): void {
  useLayoutEffect(() => {
    const toast = el?.closest<HTMLElement>('.toast');
    if (!toast) return undefined;
    const page = document.querySelector<HTMLElement>('.main-pane');
    const fit = (): void => {
      const r = page?.getBoundingClientRect() ?? {
        width: window.innerWidth,
        right: window.innerWidth,
      };
      toast.style.setProperty('--choice-width', `${Math.max(0, r.width - 2 * PAGE_GAP_PX)}px`);
      // The toast stack is pinned 16px from the window edge; the tab page may end short of
      // it, so shift the toast left by that much to keep both gaps equal.
      toast.style.setProperty('--choice-shift', `${Math.max(0, window.innerWidth - r.right)}px`);
    };
    fit();
    toast.classList.add('choice-wide');
    const ro = new ResizeObserver(fit);
    ro.observe(page ?? document.body);
    return () => {
      ro.disconnect();
      toast.classList.remove('choice-wide');
      toast.style.removeProperty('--choice-width');
      toast.style.removeProperty('--choice-shift');
    };
  }, [el]);
}

export function ChoicePanel({
  sessionId,
  onGo,
}: {
  sessionId: string;
  /** Opens the tab: the fallback whenever the panel cannot answer. */
  onGo: () => void;
}): JSX.Element {
  const { tx } = useTranslation();
  const appearance = useAppState().settings.appearance;
  const theme = getXtermTheme(appearance?.theme);
  const minContrast = isLightTheme(appearance?.theme) ? LIGHT_THEME_MIN_CONTRAST : 1;
  const fontSize = appearance?.terminalFontSize ?? 13;
  const fontFamily =
    appearance?.terminalFontFamily ??
    '"Cascadia Mono", "JetBrains Mono", Consolas, "LXGW WenKai Mono", monospace';
  /** undefined while the first read is on its way, null when it failed */
  const [view, setView] = useState<ReadChoiceResponse | null | undefined>(undefined);
  const prompt = view === undefined ? undefined : (view?.prompt ?? null);
  const [busy, setBusy] = useState(false);
  /** A line under the options; errors also offer the tab. */
  const [note, setNote] = useState<{ text: string; error: boolean } | null>(null);
  /** The option whose text field is open, by printed number. */
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const alive = useRef(true);
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const screenRef = useRef<HTMLDivElement | null>(null);
  const [screenFontSize, setScreenFontSize] = useState(fontSize);

  useTabPageWidth(root);

  useEffect(() => {
    alive.current = true;
    readChoice(sessionId)
      .then((v) => {
        if (alive.current) setView(v);
      })
      .catch((err) => {
        console.warn('[ChoicePanel] read-choice failed', err);
        if (alive.current) setView(null);
      });
    return () => {
      alive.current = false;
    };
  }, [sessionId]);

  // Fit the copy: measure at the terminal's font size and shrink in proportion when the
  // rows are wider than the toast. Then show the bottom, where the options are.
  useLayoutEffect(() => {
    const el = screenRef.current;
    if (!el) return;
    el.style.fontSize = `${fontSize}px`;
    // Only the text scales, not the padding; keep 2% spare for glyph rounding.
    const cs = getComputedStyle(el);
    const pad = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
    const room = el.clientWidth - pad;
    const need = el.scrollWidth - pad;
    const size = need > room ? Math.max(MIN_FONT_PX, (fontSize * room * 0.98) / need) : fontSize;
    el.style.fontSize = `${size}px`;
    setScreenFontSize(size);
    el.scrollTop = el.scrollHeight;
  }, [view, fontSize, root]);

  const reasonText = useCallback(
    (reason: AnswerChoiceReason | undefined): string => {
      switch (reason) {
        case 'no-prompt':
          return tx('agent 已经不在等了', 'The agent is no longer waiting');
        case 'text-needed':
          return tx('先写点什么', 'Write something first');
        case 'prompt-stuck':
          return tx('留言没发出去,去标签里看看', 'The message was not sent, open the tab');
        default:
          return tx('提示已经变了,去标签里看看', 'The prompt changed, open the tab');
      }
    },
    [tx],
  );

  /**
   * Sends one action, then re-reads until the screen shows its effect. The next page of a
   * paged prompt, a ticked box, or no prompt once the agent is working again.
   */
  const act = useCallback(
    async (action: AnswerChoicePayload): Promise<void> => {
      if (busy) return;
      const before = JSON.stringify(view?.screen ?? null);
      setBusy(true);
      setNote(null);
      try {
        const res = await window.api.invoke<AnswerChoicePayload, AnswerChoiceResponse>(
          COMMAND_CHANNELS.SESSION_ANSWER_CHOICE,
          action,
        );
        if (!alive.current) return;
        if (!res.sent) {
          if (res.reason !== 'busy') setNote({ text: reasonText(res.reason), error: true });
          return;
        }
        setEditing(null);
        setDraft('');
        const until = Date.now() + SETTLE_TIMEOUT_MS;
        let next: ReadChoiceResponse | null = view ?? null;
        while (alive.current && Date.now() < until) {
          await sleep(SETTLE_POLL_MS);
          next = await readChoice(sessionId);
          if (JSON.stringify(next.prompt ? next.screen : null) !== before) break;
        }
        if (!alive.current) return;
        setView(next);
        if (!next?.prompt) setNote({ text: tx('已发送', 'Sent'), error: false });
      } catch (err) {
        console.warn('[ChoicePanel] answer-choice failed', err);
        if (alive.current) setNote({ text: reasonText(undefined), error: true });
      } finally {
        if (alive.current) setBusy(false);
      }
    },
    [busy, view, reasonText, sessionId, tx],
  );

  const onOption = (o: ChoiceOption): void => {
    if (o.input === 'none') {
      void act({ sessionId, index: o.index });
      return;
    }
    setEditing(o.index);
    setNote(null);
    // The field keeps what was typed there before; start from it.
    setDraft(o.input === 'type' && !TYPE_PLACEHOLDER.test(o.label) ? o.label : '');
  };

  const onSubmitText = (e: FormEvent, o: ChoiceOption): void => {
    e.preventDefault();
    if (o.input === 'type' && !draft.trim()) {
      setNote({ text: reasonText('text-needed'), error: false });
      return;
    }
    void act({ sessionId, index: o.index, text: draft });
  };

  if (prompt === undefined) {
    return (
      <div ref={setRoot} className="toast-choice-empty">
        {tx('读取中…', 'Reading…')}
      </div>
    );
  }
  if (!prompt) {
    return (
      <div ref={setRoot} className="toast-choice-empty">
        {note?.text ?? tx('读不出选项,去标签里看看', 'Could not read the options, open the tab')}
      </div>
    );
  }

  const optionNote = (o: ChoiceOption): string | null => {
    if (o.input === 'type') return tx('打字回答', 'type an answer');
    if (o.input === 'chat') return tx('给 agent 留言', 'message the agent');
    return null;
  };

  const offset = prompt.region.from;
  const rows = view?.screen ?? [];
  const field = editing !== null ? prompt.options.find((o) => o.index === editing) : undefined;

  // Rows top to bottom; an option's rows (its label and description) are one button, so a
  // click anywhere on them answers with that option.
  const blocks: JSX.Element[] = [];
  for (let k = 0; k < rows.length; ) {
    const o = prompt.options.find((opt) => opt.rows.from - offset === k);
    if (!o) {
      blocks.push(<ScreenRow key={k} runs={rows[k]!} theme={theme} minContrast={minContrast} />);
      k++;
      continue;
    }
    const last = Math.min(o.rows.to - offset, rows.length - 1);
    blocks.push(
      <button
        key={k}
        type="button"
        className={'toast-choice-hit' + (editing === o.index ? ' editing' : '')}
        disabled={busy}
        aria-label={o.label}
        aria-pressed={o.checked ?? undefined}
        title={optionNote(o) ?? undefined}
        onClick={() => onOption(o)}
      >
        {rows.slice(k, last + 1).map((runs, j) => (
          <ScreenRow key={j} runs={runs} theme={theme} minContrast={minContrast} />
        ))}
      </button>,
    );
    k = last + 1;
  }

  return (
    <div ref={setRoot} className="toast-choice">
      <div
        ref={screenRef}
        className="toast-choice-screen"
        style={{
          fontFamily,
          fontSize: screenFontSize,
          color: theme.foreground,
          backgroundColor: theme.background,
        }}
      >
        {blocks}
      </div>
      {field && (
        <form className="toast-choice-input" onSubmit={(e) => onSubmitText(e, field)}>
          <input
            // The field opens because the user clicked for it; focus belongs there.
            autoFocus
            value={draft}
            disabled={busy}
            placeholder={
              field.input === 'type'
                ? tx('你的回答', 'Your answer')
                : tx('想对 agent 说的话(可空)', 'Message to the agent (optional)')
            }
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation();
                setEditing(null);
              }
            }}
          />
          <button type="submit" className="toast-choice-send" disabled={busy}>
            {tx('发送', 'Send')}
          </button>
        </form>
      )}
      {prompt.multiSelect && !prompt.reviewing && (
        <button
          type="button"
          className="toast-choice-next"
          disabled={busy}
          onClick={() => void act({ sessionId, next: true })}
        >
          {tx('选好了,下一步 →', 'Done, next →')}
        </button>
      )}
      {note && (
        <div className="toast-choice-empty">
          {note.text}
          {note.error && (
            <>
              {' '}
              <button type="button" className="toast-choice-go" onClick={onGo}>
                {tx('去看看', 'Go to tab')}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
