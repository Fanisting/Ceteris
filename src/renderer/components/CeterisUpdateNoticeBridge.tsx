/**
 * @file src/renderer/components/CeterisUpdateNoticeBridge.tsx
 * @purpose An in-app message when a check finds a new Ceteris version (ADR-018, point 6):
 *   "Ceteris 0.4.5 is available" with Download and Details. Agents already get theirs
 *   from AgentUpdateNoticeBridge; this is the same kind of toast for Ceteris itself.
 *
 * @关键设计:
 * - Only from evt:update:status-changed, never from the status pulled on mount: a window
 *   opened while an update is already known stays quiet (the settings button badge shows
 *   it), so opening windows does not repeat the message.
 * - Once per version per window. The checker reports 'available' after every check (every
 *   6 hours); a newer version shows again.
 * - Not while the window is in Settings: the user is there, and "Check now" in About
 *   shows the result on the page itself.
 * - In-app only, by the developer's choice: no system notification for updates.
 *
 * @对应文档章节:软件定义书.md ADR-018
 * @不要在这里做的事:no checking or downloading; main's UpdateChecker does the checks.
 */
import { useEffect, useRef } from 'react';
import { COMMAND_CHANNELS, EVENT_CHANNELS } from '@shared/protocol';
import type { UpdateStatus } from '@shared/update-check';
import { useAppDispatch, useAppState } from '../store';
import { useTranslation } from './LanguageProvider';
import { useToast } from './Toast';

export function CeterisUpdateNoticeBridge(): null {
  const toast = useToast();
  const dispatch = useAppDispatch();
  const { tx } = useTranslation();
  const inSettings = useAppState().inSettingsView;
  const inSettingsRef = useRef(inSettings);
  inSettingsRef.current = inSettings;
  /** Versions this window already showed */
  const shownRef = useRef(new Set<string>());

  useEffect(
    () =>
      window.api.on<UpdateStatus>(EVENT_CHANNELS.UPDATE_STATUS_CHANGED, (s) => {
        if (s.state !== 'available' || !s.update) return;
        const update = s.update;
        if (shownRef.current.has(update.version)) return;
        shownRef.current.add(update.version);
        if (inSettingsRef.current) return;
        toast.push({
          kind: 'info',
          message: tx(
            `Ceteris ${update.version} 可以更新了 (你现在用的是 ${s.currentVersion})`,
            `Ceteris ${update.version} is available (you have ${s.currentVersion})`,
          ),
          durationMs: 15_000,
          actions: [
            {
              label: tx('下载', 'Download'),
              onClick: () => {
                window.api
                  .invoke(COMMAND_CHANNELS.SYSTEM_OPEN_EXTERNAL, { url: update.downloadUrl })
                  .catch((err) => console.warn('[CeterisUpdateNotice] open failed', err));
              },
            },
            {
              label: tx('详情', 'Details'),
              onClick: () => dispatch({ type: 'view/enter-settings', category: 'about' }),
            },
          ],
        });
      }),
    [dispatch, toast, tx],
  );

  return null;
}
