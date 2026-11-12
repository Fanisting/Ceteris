/**
 * @file src/shared/main-agent.ts
 * @purpose The user's main agent (ADR-042): which agent template Ceteris reaches for when it
 *   has to pick one by itself, and the small rules for ordering things around it.
 *
 * @关键设计:
 * - Stored as a template id in settings.behavior.mainAgent. '' means "not chosen"; then the
 *   first installed agent in template order stands in, so nothing breaks before the question
 *   is answered (or after the user pressed Later).
 * - Any template that is not a plain shell counts as an agent, custom ones included: a user
 *   may run their agent through a wrapper template.
 * - A stored id whose template was deleted, or whose command is no longer on PATH, is skipped
 *   rather than trusted: opening a tab for a missing command only shows an error.
 * - Picking a main agent moves it to the front of quick launch (the ghost tab), because the
 *   coordinator tour and the remote setup guide also start from the first agent there.
 *
 * @对应文档章节:软件定义书.md ADR-042
 *
 * @不要在这里做的事:
 * - No IPC and no settings writes here; the renderer asks main which agents are installed and
 *   saves the choice. Keep these functions pure so they stay tested.
 */
import { QUICK_LAUNCH_MAX_ITEMS, type QuickLaunchItem } from './quick-launch';

/** Built-in templates that start a plain shell, not an agent. */
export const SHELL_TEMPLATE_IDS: ReadonlySet<string> = new Set(['shell', 'admin-shell']);

/** Whether a template runs an agent (anything that is not a plain shell). */
export function isAgentTemplateId(templateId: string): boolean {
  return !SHELL_TEMPLATE_IDS.has(templateId);
}

/**
 * The agent Ceteris should use when it has to choose one.
 *
 * @param stored settings.behavior.mainAgent; '' when the user has not chosen
 * @param templates visible templates in their usual order (hidden ones already removed)
 * @param missing template ids whose command is not on PATH; null while not known yet, and then
 *   nothing counts as missing
 * @returns the stored agent when it can still start; else the first installed agent; else the
 *   first agent template; null when there is no agent template at all
 */
export function resolveMainAgent(
  stored: string,
  templates: ReadonlyArray<{ id: string }>,
  missing: ReadonlySet<string> | null,
): string | null {
  const agents = templates.map((t) => t.id).filter(isAgentTemplateId);
  const usable = (id: string): boolean => !(missing?.has(id) ?? false);
  if (stored && agents.includes(stored) && usable(stored)) return stored;
  return agents.find(usable) ?? agents[0] ?? null;
}

/**
 * Which agent the first start card preselects: the agent opened most often, else the first
 * installed one in template order.
 *
 * @param agentIds installed agent template ids in display order
 * @param counts how often each template was opened (template-usage), by template id
 */
export function preselectMainAgent(
  agentIds: readonly string[],
  counts: ReadonlyMap<string, number>,
): string | null {
  let best: string | null = null;
  let bestCount = 0;
  for (const id of agentIds) {
    const n = counts.get(id) ?? 0;
    if (n > bestCount) {
      best = id;
      bestCount = n;
    }
  }
  return best ?? agentIds[0] ?? null;
}

/**
 * Quick launch with the main agent moved to the front. An agent that was not in the list is
 * added at the front; when the list is full, the last agent template makes room (shells the
 * user picked stay).
 */
export function quickLaunchWithMain(
  items: readonly QuickLaunchItem[],
  mainAgent: string,
): QuickLaunchItem[] {
  const main: QuickLaunchItem = { kind: 'template', id: mainAgent };
  const rest = items.filter((i) => !(i.kind === 'template' && i.id === mainAgent));
  if (rest.length >= QUICK_LAUNCH_MAX_ITEMS) {
    let drop = -1;
    for (let i = rest.length - 1; i >= 0; i--) {
      const item = rest[i];
      if (item && item.kind === 'template' && isAgentTemplateId(item.id)) {
        drop = i;
        break;
      }
    }
    rest.splice(drop >= 0 ? drop : rest.length - 1, 1);
  }
  return [main, ...rest];
}

/** Ids with the main agent first and the rest in their given order. */
export function mainAgentFirst<T extends { id: string }>(
  items: readonly T[],
  mainAgent: string | null,
): T[] {
  const main = items.find((i) => i.id === mainAgent);
  return main ? [main, ...items.filter((i) => i !== main)] : [...items];
}
