/**
 * @file src/renderer/components/main-agent-ui.ts
 * @purpose Renderer side of the main agent (ADR-042): which agents are on PATH, the resolved
 *   main agent, and saving a new choice.
 *
 * @关键设计:
 * - "Installed" comes from cmd:agent:list-installed, which main caches, so every caller can ask
 *   on mount without running anything twice. Templates main has no detection rule for (custom
 *   ones) are not in the reply and count as installed.
 * - Saving a choice writes three fields at once: mainAgent, mainAgentAsked and quick launch with
 *   that agent moved to the front (quickLaunchWithMain), so the ghost tab, the coordinator tour
 *   and the remote setup guide all follow it.
 *
 * @对应文档章节:软件定义书.md ADR-042
 *
 * @不要在这里做的事:
 * - No ordering rules here; they live in @shared/main-agent and are tested there.
 */
import { useEffect, useState } from 'react';
import {
  COMMAND_CHANNELS,
  type ListInstalledAgentsPayload,
  type ListInstalledAgentsResponse,
} from '@shared/protocol';
import { DEFAULT_QUICK_LAUNCH_ITEMS, type QuickLaunchItem } from '@shared/quick-launch';
import { quickLaunchWithMain, resolveMainAgent } from '@shared/main-agent';
import { useAppState } from '../store';

/**
 * Template ids whose command is not on PATH.
 *
 * @param enabled false for SSH and WSL folders, whose agents are another install; the result
 *   is then an empty set (nothing counts as missing)
 * @returns null until main answers; an empty set when the question fails
 */
export function useMissingAgents(enabled: boolean): Set<string> | null {
  const [missing, setMissing] = useState<Set<string> | null>(() => (enabled ? null : new Set()));
  useEffect(() => {
    if (!enabled) {
      setMissing(new Set());
      return;
    }
    let cancelled = false;
    window.api
      .invoke<ListInstalledAgentsPayload, ListInstalledAgentsResponse>(
        COMMAND_CHANNELS.AGENT_LIST_INSTALLED,
        { force: false },
      )
      .then((res) => {
        if (!cancelled) {
          setMissing(new Set(res.agents.filter((a) => !a.installed).map((a) => a.templateId)));
        }
      })
      .catch((err) => {
        console.warn('[main-agent] list-installed-agents failed', err);
        if (!cancelled) setMissing(new Set());
      });
    return () => {
      cancelled = true;
    };
  }, [enabled]);
  return missing;
}

/**
 * The main agent for this window: the stored choice when it can still start, else the first
 * installed agent (resolveMainAgent).
 */
export function useMainAgent(): string | null {
  const state = useAppState();
  const missing = useMissingAgents(true);
  const templates = state.templates.filter((t) => !t.hidden);
  return resolveMainAgent(state.settings.behavior?.mainAgent ?? '', templates, missing);
}

/**
 * Saves the user's main agent and puts it first in quick launch.
 *
 * @param templateId the chosen agent template
 * @param quickLaunch the current quick launch list (settings.behavior.quickLaunch)
 * @throws whatever cmd:settings:update throws (invalid settings, IPC down); callers show it
 */
export async function saveMainAgent(
  templateId: string,
  quickLaunch: readonly QuickLaunchItem[] | undefined,
): Promise<void> {
  await window.api.invoke(COMMAND_CHANNELS.SETTINGS_UPDATE, {
    partial: {
      behavior: {
        mainAgent: templateId,
        mainAgentAsked: true,
        quickLaunch: quickLaunchWithMain(quickLaunch ?? DEFAULT_QUICK_LAUNCH_ITEMS, templateId),
      },
    },
  });
}
