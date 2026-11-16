/**
 * @file src/renderer/components/NotificationClickBridge.tsx
 * @purpose A click on a "finished" system notification (ADR-048) brings this window up and
 *   asks it to show the tab. Selecting alone is not enough: a window draws a terminal only
 *   for the tab it owns, and a tab in the background has no owner (single focus owner,
 *   软件定义书 8.4). This bridge claims the tab, by the sidebar's click rules.
 *
 * @关键设计:
 * - The store already selects the tab on evt:window:focus-requested; this only adds the
 *   claim, for reason 'notification-click' only, so the tray and focus-owner paths keep
 *   their behaviour.
 * - No owner: optimistic claim with rollback, the same protocol as Sidebar.tsx. Owned by
 *   another window: cmd:session:focus-owner, which focuses it, or hands the tab over when
 *   either side is a Link virtual window.
 * - In a Link remote window the commands go to the Host like every other click.
 *
 * @对应文档章节:软件定义书.md ADR-048, 8.4
 * @不要在这里做的事:no notifications here; main shows them (done-notifier.ts).
 */
import { useEffect } from 'react';
import {
  COMMAND_CHANNELS,
  EVENT_CHANNELS,
  type FocusSessionOwnerResponse,
  type WindowFocusRequestedPayload,
} from '@shared/protocol';
import { findMyOwnedSessionId, useAppDispatch, useAppStateRef } from '../store';

export function NotificationClickBridge(): null {
  const stateRef = useAppStateRef();
  const dispatch = useAppDispatch();

  useEffect(
    () =>
      window.api.on<WindowFocusRequestedPayload>(EVENT_CHANNELS.WINDOW_FOCUS_REQUESTED, (p) => {
        if (p.reason !== 'notification-click' || !p.selectSessionId) return;
        const st = stateRef.current;
        const session = st.sessions.get(p.selectSessionId);
        if (!session || session.ownerWindowId === st.myWindowId) return;
        if (session.ownerWindowId) {
          window.api
            .invoke<{ sessionId: string }, FocusSessionOwnerResponse>(
              COMMAND_CHANNELS.SESSION_FOCUS_OWNER,
              { sessionId: session.id },
            )
            .then((res) => {
              if (res.transferred) dispatch({ type: 'view/select-session', sessionId: session.id });
            })
            .catch((err) => console.error('[NotificationClick] focus-owner failed', err));
          return;
        }
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
            console.error('[NotificationClick] claim failed, rolling back', err);
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
              dispatch({ type: 'view/select-session', sessionId: prevOwnedId });
            }
          });
      }),
    [dispatch, stateRef],
  );

  return null;
}
