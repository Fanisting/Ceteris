/**
 * @file src/renderer/components/AgentChoiceNoticeBridge.tsx
 * @purpose When an agent in a tab the user is not looking at stops to ask them something
 *   (an approval prompt or an AskUserQuestion choice), show a toast in this window that
 *   names the tab and jumps to it on click. The toast goes away by itself once the agent
 *   moves on, so a prompt answered from another window leaves nothing behind.
 *
 * @关键设计:
 * - The signal is the store, not a new IPC event: agentPhase already turns 'blocked' for
 *   both prompt kinds (ADR-021, ADR-035), and every window's store sees the same
 *   state-changed events. The bridge only diffs the phase of each session between renders.
 * - Only a transition into 'blocked' counts. A window that opens while an agent already
 *   waits shows nothing: the breathing warning dot on the tab is enough for a state that
 *   was there before the user arrived.
 * - A tab shown in this window (selected, or in a split pane) gets no toast; the prompt is
 *   on screen. Other windows still get one, because the user may be working there.
 * - "Go to tab" follows the sidebar's click rules (软件定义书 8.4): a tab this window holds
 *   or nobody holds is selected here (claiming it), one held by another window focuses
 *   that window instead.
 * - "Options" expands the toast into the prompt itself: main reads the question and the
 *   numbered options off the tab's screen (cmd:session:read-choice) and a click answers
 *   through cmd:session:answer-choice, which re-reads the screen before typing anything.
 *   The toast closes on a sent answer; the phase change would close it a moment later too.
 *
 * @对应文档章节:软件定义书.md ADR-035
 * @不要在这里做的事:
 * - No OS notifications: the user asked to be pointed at the tab inside Ceteris. If an
 *   unfocused window turns out to need more, that is a separate decision.
 * - No settings switch yet: the toast fires only for a tab out of sight, at most once per
 *   prompt, so there is nothing to tune until someone asks.
 */
import { useEffect, useRef, useState } from 'react';
import {
  COMMAND_CHANNELS,
  type AnswerChoicePayload,
  type AnswerChoiceResponse,
  type FocusSessionOwnerResponse,
  type ReadChoicePayload,
  type ReadChoiceResponse,
} from '@shared/protocol';
import type { AgentPhase, ChoiceOption, ChoicePrompt, SessionInfo } from '@shared/types';
import {
  findMyOwnedSessionId,
  getDisplayableSession,
  getEffectivePaneLayout,
  getPaneSlots,
  useAppDispatch,
  useAppState,
  useAppStateRef,
  type AppState,
} from '../store';
import { useTranslation } from './LanguageProvider';
import { useToast } from './Toast';

/**
 * The toast never times out on its own: the agent is still waiting, and the point is to be
 * told. It leaves when the agent moves on, the user looks at the tab, or they close it.
 */
const CHOICE_TOAST_MS = Infinity;

/** True when the session's terminal is on screen in this window. */
function isVisibleHere(state: AppState, sessionId: string): boolean {
  if (getDisplayableSession(state)?.id === sessionId) return true;
  if (getEffectivePaneLayout(state) === 'single') return false;
  return getPaneSlots(state).some((s) => s?.id === sessionId);
}

/**
 * The expanded part of the toast: the agent's question and its options as buttons. A click
 * sends the pick to the tab through main, which re-reads the screen first. Options that
 * want typed text afterwards open the tab instead; typing belongs in the terminal.
 */
function ChoicePanel({
  sessionId,
  onGo,
  onSent,
}: {
  sessionId: string;
  onGo: () => void;
  onSent: () => void;
}): JSX.Element {
  const { tx } = useTranslation();
  /** undefined while loading */
  const [prompt, setPrompt] = useState<ChoicePrompt | null | undefined>(undefined);
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'failed'>('idle');

  useEffect(() => {
    let alive = true;
    window.api
      .invoke<ReadChoicePayload, ReadChoiceResponse>(COMMAND_CHANNELS.SESSION_READ_CHOICE, {
        sessionId,
      })
      .then((res) => {
        if (alive) setPrompt(res.prompt);
      })
      .catch((err) => {
        console.warn('[AgentChoiceNotice] read-choice failed', err);
        if (alive) setPrompt(null);
      });
    return () => {
      alive = false;
    };
  }, [sessionId]);

  const pick = (option: ChoiceOption): void => {
    if (option.freeText) {
      onGo();
      return;
    }
    setStatus('sending');
    window.api
      .invoke<AnswerChoicePayload, AnswerChoiceResponse>(COMMAND_CHANNELS.SESSION_ANSWER_CHOICE, {
        sessionId,
        index: option.index,
      })
      .then((res) => {
        if (res.sent) {
          setStatus('sent');
          onSent();
        } else {
          console.warn('[AgentChoiceNotice] answer-choice refused', res.reason);
          setStatus('failed');
        }
      })
      .catch((err) => {
        console.warn('[AgentChoiceNotice] answer-choice failed', err);
        setStatus('failed');
      });
  };

  if (prompt === undefined) {
    return <span className="toast-choice-empty">{tx('读取中…', 'Reading…')}</span>;
  }
  if (!prompt) {
    return (
      <span className="toast-choice-empty">
        {tx('读不出选项,去标签里看看', 'Could not read the options, open the tab')}
      </span>
    );
  }
  return (
    <>
      {prompt.question && <div className="toast-choice-question">{prompt.question}</div>}
      <div className="toast-choice-list">
        {prompt.options.map((o) => (
          <button
            key={o.index}
            type="button"
            className={'toast-choice-option' + (o.pointed ? ' pointed' : '')}
            disabled={status === 'sending' || status === 'sent'}
            onClick={() => pick(o)}
          >
            <span className="toast-choice-index">{o.index}.</span>
            {o.label}
            {o.freeText && (
              <span className="toast-choice-note">{tx('(去标签里打字)', '(type in the tab)')}</span>
            )}
          </button>
        ))}
      </div>
      {status === 'failed' && (
        <div className="toast-choice-empty">
          {tx('提示已经变了,去标签里看看', 'The prompt changed, open the tab')}
        </div>
      )}
    </>
  );
}

export function AgentChoiceNoticeBridge(): null {
  const state = useAppState();
  const stateRef = useAppStateRef();
  const dispatch = useAppDispatch();
  const toast = useToast();
  const { tx } = useTranslation();
  /** The phase of every session at the previous render; a session missing here is new. */
  const phases = useRef<Map<string, AgentPhase | null> | null>(null);
  /** Open toasts by session id, so the toast leaves when the agent does. */
  const open = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    const goToTab = (session: SessionInfo): void => {
      const st = stateRef.current;
      if (session.ownerWindowId && session.ownerWindowId !== st.myWindowId) {
        window.api
          .invoke<{ sessionId: string }, FocusSessionOwnerResponse>(
            COMMAND_CHANNELS.SESSION_FOCUS_OWNER,
            { sessionId: session.id },
          )
          .then((res) => {
            if (res.transferred) dispatch({ type: 'view/select-session', sessionId: session.id });
          })
          .catch((err) => console.error('[AgentChoiceNotice] focus-owner failed', err));
        return;
      }
      if (session.ownerWindowId === null) {
        // Same optimistic claim as the sidebar: select now, roll back if main refuses.
        const prevOwnedId = findMyOwnedSessionId(st);
        if (prevOwnedId && prevOwnedId !== session.id) {
          dispatch({ type: 'sessions/owner-changed', sessionId: prevOwnedId, ownerWindowId: null });
        }
        dispatch({
          type: 'sessions/owner-changed',
          sessionId: session.id,
          ownerWindowId: st.myWindowId,
        });
        window.api
          .invoke(COMMAND_CHANNELS.SESSION_CLAIM, { sessionId: session.id })
          .catch((err) => {
            console.error('[AgentChoiceNotice] claim failed, rolling back', err);
            dispatch({
              type: 'sessions/owner-changed',
              sessionId: session.id,
              ownerWindowId: null,
            });
            if (prevOwnedId && prevOwnedId !== session.id) {
              dispatch({
                type: 'sessions/owner-changed',
                sessionId: prevOwnedId,
                ownerWindowId: st.myWindowId,
              });
            }
            dispatch({ type: 'view/select-session', sessionId: prevOwnedId });
          });
      }
      dispatch({ type: 'view/select-path', pathId: session.pathId });
      dispatch({ type: 'view/select-session', sessionId: session.id });
    };

    const prev = phases.current;
    const next = new Map<string, AgentPhase | null>();
    for (const s of state.sessions.values()) next.set(s.id, s.agentPhase ?? null);
    phases.current = next;
    // The first render only records what is there.
    if (!prev) return;

    for (const s of state.sessions.values()) {
      const was = prev.get(s.id);
      const now = s.agentPhase ?? null;
      if (now === 'blocked' && was !== undefined && was !== 'blocked' && !open.current.has(s.id)) {
        if (isVisibleHere(state, s.id)) continue;
        // Look the session up again at click time: its owner may have changed by then.
        const go = (): void => goToTab(stateRef.current.sessions.get(s.id) ?? s);
        const closeOwn = (): void => {
          const tid = open.current.get(s.id);
          if (tid === undefined) return;
          toast.dismiss(tid);
          open.current.delete(s.id);
        };
        const id = toast.push({
          kind: 'warn',
          message: tx(
            `${s.displayName} 在等你决定`,
            `${s.displayName} is waiting for your decision`,
          ),
          durationMs: CHOICE_TOAST_MS,
          detail: {
            label: tx('选项', 'Options'),
            render: () => <ChoicePanel sessionId={s.id} onGo={go} onSent={closeOwn} />,
          },
          actions: [{ label: tx('去看看', 'Go to tab'), onClick: go }],
        });
        open.current.set(s.id, id);
      }
    }
    // Agent moved on, the user is now looking at it, or the tab closed: drop the toast.
    for (const [sid, id] of open.current) {
      const s = state.sessions.get(sid);
      if (!s || (s.agentPhase ?? null) !== 'blocked' || isVisibleHere(state, sid)) {
        toast.dismiss(id);
        open.current.delete(sid);
      }
    }
  }, [state, stateRef, dispatch, toast, tx]);

  return null;
}
