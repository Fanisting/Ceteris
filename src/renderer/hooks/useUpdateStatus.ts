/**
 * @file src/renderer/hooks/useUpdateStatus.ts
 * @purpose Gives a component the current GitHub update check status (ADR-018) and keeps it
 *   live: pulls it once on mount, then follows evt:update:status-changed.
 *
 *   Each caller holds its own copy. Two callers (the sidebar settings button and the
 *   About panel) are cheap, and keeping it out of the app store avoids touching the
 *   reducer for a value only two places read.
 */
import { useCallback, useEffect, useState } from 'react';
import { COMMAND_CHANNELS, EVENT_CHANNELS } from '@shared/protocol';
import type { UpdateStatus } from '@shared/update-check';

export interface UseUpdateStatus {
  status: UpdateStatus | null;
  /** Runs a check now. Resolves with the new status, or null when the IPC call failed. */
  checkNow: () => Promise<UpdateStatus | null>;
  /** Opens a link (download or release notes) in the default browser. */
  openLink: (url: string) => void;
}

export function useUpdateStatus(): UseUpdateStatus {
  const [status, setStatus] = useState<UpdateStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    window.api
      .invoke<undefined, UpdateStatus>(COMMAND_CHANNELS.UPDATE_GET_STATUS, undefined)
      .then((s) => {
        if (!cancelled) setStatus(s);
      })
      .catch((err) => console.warn('[update] get-status failed', err));
    const off = window.api.on<UpdateStatus>(EVENT_CHANNELS.UPDATE_STATUS_CHANGED, (s) =>
      setStatus(s),
    );
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  const checkNow = useCallback(async (): Promise<UpdateStatus | null> => {
    try {
      const s = await window.api.invoke<undefined, UpdateStatus>(
        COMMAND_CHANNELS.UPDATE_CHECK_NOW,
        undefined,
      );
      setStatus(s);
      return s;
    } catch (err) {
      console.warn('[update] check-now failed', err);
      return null;
    }
  }, []);

  const openLink = useCallback((url: string): void => {
    window.api
      .invoke(COMMAND_CHANNELS.SYSTEM_OPEN_EXTERNAL, { url })
      .catch((err) => console.warn('[update] open-external failed', err));
  }, []);

  return { status, checkNow, openLink };
}
