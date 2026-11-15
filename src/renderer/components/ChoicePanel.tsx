/**
 * @file src/renderer/components/ChoicePanel.tsx
 * @purpose The expanded part of the "waiting for your decision" toast (ADR-035): the prompt
 *   an agent stopped at, read off its tab's screen, answered from here. Covers every shape
 *   Claude Code draws: approval boxes, single and multi-select AskUserQuestion, its "Type
 *   something" field, "Chat about this", the pages of a several-question prompt and the
 *   review page that submits them.
 *
 * @关键设计:
 * - Main owns the screen. The panel only shows what cmd:session:read-choice returns and asks
 *   cmd:session:answer-choice to act; main re-reads the screen before every keystroke, so
 *   a panel that went stale cannot type into whatever the agent does next.
 * - After each action the panel polls read-choice until the screen changes, because one
 *   prompt can have several pages: answering page one shows page two in the same toast.
 *   When the prompt is gone the agent is working again, and the bridge closes the toast.
 * - Text answers open a one-line field under their option. "Type something" needs text;
 *   "Chat about this" (and an approval's "No, and tell Claude") may go without, which just
 *   leaves the prompt, as pressing Enter there would.
 *
 * @对应文档章节:软件定义书.md ADR-035;ipc-protocol.md cmd:session:read-choice / answer-choice
 * @不要在这里做的事:
 * - Do not send keys from here. All typing goes through main's answer-choice, which knows
 *   the pointer position and checks the screen between stages.
 */
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import {
  COMMAND_CHANNELS,
  type AnswerChoicePayload,
  type AnswerChoiceReason,
  type AnswerChoiceResponse,
  type ReadChoicePayload,
  type ReadChoiceResponse,
} from '@shared/protocol';
import type { ChoiceOption, ChoicePrompt } from '@shared/types';
import { useTranslation } from './LanguageProvider';

/** How often the panel re-reads the prompt after an action, and for how long at most. */
const SETTLE_POLL_MS = 200;
const SETTLE_TIMEOUT_MS = 3000;

/** The placeholder label of AskUserQuestion's text field before anything is typed there. */
const TYPE_PLACEHOLDER = /^(?:Type something\.?|Other)$/;

function readChoice(sessionId: string): Promise<ChoicePrompt | null> {
  return window.api
    .invoke<ReadChoicePayload, ReadChoiceResponse>(COMMAND_CHANNELS.SESSION_READ_CHOICE, {
      sessionId,
    })
    .then((res) => res.prompt);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  /** undefined while the first read is on its way */
  const [prompt, setPrompt] = useState<ChoicePrompt | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  /** A line under the options; errors also offer the tab. */
  const [note, setNote] = useState<{ text: string; error: boolean } | null>(null);
  /** The option whose text field is open, by printed number. */
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    readChoice(sessionId)
      .then((p) => {
        if (alive.current) setPrompt(p);
      })
      .catch((err) => {
        console.warn('[ChoicePanel] read-choice failed', err);
        if (alive.current) setPrompt(null);
      });
    return () => {
      alive.current = false;
    };
  }, [sessionId]);

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
   * paged prompt, a ticked box, or null once the agent is working again.
   */
  const act = useCallback(
    async (action: AnswerChoicePayload): Promise<void> => {
      if (busy) return;
      const before = JSON.stringify(prompt ?? null);
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
        let next: ChoicePrompt | null = prompt ?? null;
        while (alive.current && Date.now() < until) {
          await sleep(SETTLE_POLL_MS);
          next = await readChoice(sessionId);
          if (JSON.stringify(next) !== before) break;
        }
        if (!alive.current) return;
        setPrompt(next);
        if (!next) setNote({ text: tx('已发送', 'Sent'), error: false });
      } catch (err) {
        console.warn('[ChoicePanel] answer-choice failed', err);
        if (alive.current) setNote({ text: reasonText(undefined), error: true });
      } finally {
        if (alive.current) setBusy(false);
      }
    },
    [busy, prompt, reasonText, sessionId, tx],
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
    return <span className="toast-choice-empty">{tx('读取中…', 'Reading…')}</span>;
  }
  if (!prompt) {
    return (
      <span className="toast-choice-empty">
        {note?.text ?? tx('读不出选项,去标签里看看', 'Could not read the options, open the tab')}
      </span>
    );
  }

  const optionNote = (o: ChoiceOption): string | null => {
    if (o.input === 'type') return tx('打字回答', 'type an answer');
    if (o.input === 'chat') return tx('给 agent 留言', 'message the agent');
    return null;
  };

  return (
    <>
      {prompt.steps.length > 0 && (
        <div className="toast-choice-steps">
          {prompt.steps.map((s) => (
            <span key={s.label} className={'toast-choice-step' + (s.done ? ' done' : '')}>
              {s.done ? '✓ ' : ''}
              {s.label}
            </span>
          ))}
          <span className={'toast-choice-step' + (prompt.reviewing ? ' current' : '')}>
            {tx('提交', 'Submit')}
          </span>
        </div>
      )}
      {prompt.question && <div className="toast-choice-question">{prompt.question}</div>}
      {prompt.reviewing && prompt.review.length > 0 && (
        <div className="toast-choice-review">
          {prompt.review.map((line, i) => (
            <div
              key={i}
              className={
                'toast-choice-review-line' +
                (line.startsWith('→') ? ' answer' : '') +
                (line.startsWith('⚠') ? ' warn' : '')
              }
            >
              {line.replace(/^●\s*/, '')}
            </div>
          ))}
        </div>
      )}
      <div className="toast-choice-list">
        {prompt.options.map((o) => (
          <div key={o.index} className="toast-choice-item">
            <button
              type="button"
              className={
                'toast-choice-option' +
                (o.pointed ? ' pointed' : '') +
                (o.chosen || o.checked === true ? ' chosen' : '')
              }
              disabled={busy}
              aria-pressed={o.checked ?? undefined}
              onClick={() => onOption(o)}
            >
              <span className="toast-choice-index">{o.index}.</span>
              {o.checked !== null && (
                <span className="toast-choice-box" aria-hidden="true">
                  {o.checked ? '☑' : '☐'}
                </span>
              )}
              <span className="toast-choice-label">{o.label}</span>
              {o.chosen && <span className="toast-choice-mark"> ✓</span>}
              {optionNote(o) && <span className="toast-choice-note">{optionNote(o)}</span>}
              {o.description && o.description !== o.label && (
                <span className="toast-choice-desc">{o.description}</span>
              )}
            </button>
            {editing === o.index && (
              <form className="toast-choice-input" onSubmit={(e) => onSubmitText(e, o)}>
                <input
                  // The field opens because the user clicked for it; focus belongs there.
                  autoFocus
                  value={draft}
                  disabled={busy}
                  placeholder={
                    o.input === 'type'
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
          </div>
        ))}
      </div>
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
    </>
  );
}
