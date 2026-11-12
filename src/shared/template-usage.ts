/**
 * @file src/shared/template-usage.ts
 * @purpose Counts how often each button on the new tab page gets clicked, and decides which of
 *   them count as the user's frequent choices so the page can give them a little animation.
 *
 * @关键设计:
 * - One entry per button, keyed by the template id, or `shell:<shellId>` for a detected shell,
 *   because the Shell section has one button per shell and they are different choices.
 * - A choice is "frequent" only after a few launches inside a recent window: a button clicked
 *   twice by accident must not start dancing, and a habit from months ago must not either.
 * - The ranking only looks at the buttons that are on the page right now (visibleKeys), so a
 *   hidden or uninstalled template never takes a slot.
 * - Pure functions, no I/O: the main process persists the entries (src/main/template-usage.ts),
 *   the renderer asks for them and applies the rule.
 *
 * @对应文档章节:软件定义书.md ADR-034
 *
 * @不要在这里做的事:
 * - 不要在这里读写文件或记日志,这里只有规则
 */

export interface TemplateUsageEntry {
  /** Template id, or `shell:<shellId>` for a detected shell button. */
  key: string;
  count: number;
  /** Unix ms of the latest launch. */
  lastUsedAt: number;
}

export interface TemplateUsageFile {
  version: 1;
  entries: TemplateUsageEntry[];
}

export const EMPTY_TEMPLATE_USAGE: TemplateUsageFile = { version: 1, entries: [] };

/** Entries kept on disk; the least recently used go first when the list is full. */
export const TEMPLATE_USAGE_MAX_ENTRIES = 64;

/** Launches needed before a button counts as a frequent choice. */
export const FREQUENT_MIN_COUNT = 3;
/** Launches older than this no longer make a button frequent. */
export const FREQUENT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
/** How many buttons can be frequent at once: one favorite and the rest just frequent. */
export const FREQUENT_MAX = 3;

export type FrequentTier = 'favorite' | 'frequent';

/** The key an entry uses for a template button, or for a detected shell button. */
export function templateUsageKey(templateId: string, shellId?: string | null): string {
  return shellId ? `shell:${shellId}` : templateId;
}

/** Drops anything that is not a well formed entry, so a damaged file cannot reach the page. */
export function sanitizeTemplateUsage(value: unknown): TemplateUsageFile {
  if (!value || typeof value !== 'object') return EMPTY_TEMPLATE_USAGE;
  const raw = (value as { entries?: unknown }).entries;
  if (!Array.isArray(raw)) return EMPTY_TEMPLATE_USAGE;
  const seen = new Set<string>();
  const entries: TemplateUsageEntry[] = [];
  for (const item of raw as Array<Partial<TemplateUsageEntry> | null>) {
    if (!item || typeof item.key !== 'string' || item.key.length === 0) continue;
    if (typeof item.count !== 'number' || !Number.isFinite(item.count) || item.count < 1) continue;
    if (typeof item.lastUsedAt !== 'number' || !Number.isFinite(item.lastUsedAt)) continue;
    if (seen.has(item.key)) continue;
    seen.add(item.key);
    entries.push({ key: item.key, count: Math.floor(item.count), lastUsedAt: item.lastUsedAt });
  }
  return { version: 1, entries: entries.slice(-TEMPLATE_USAGE_MAX_ENTRIES) };
}

/**
 * Returns the entries after one more launch of `key`. The touched entry moves to the end, so the
 * list stays ordered from least to most recently used and the overflow drops the stalest one.
 */
export function recordTemplateUsage(
  entries: readonly TemplateUsageEntry[],
  key: string,
  now: number,
): TemplateUsageEntry[] {
  const existing = entries.find((e) => e.key === key);
  const rest = entries.filter((e) => e.key !== key);
  const next: TemplateUsageEntry = {
    key,
    count: (existing?.count ?? 0) + 1,
    lastUsedAt: now,
  };
  const all = [...rest, next];
  return all.length > TEMPLATE_USAGE_MAX_ENTRIES
    ? all.slice(all.length - TEMPLATE_USAGE_MAX_ENTRIES)
    : all;
}

/**
 * Picks the frequent choices among the buttons on the page.
 *
 * Rule: a button qualifies with at least FREQUENT_MIN_COUNT launches, the latest within
 * FREQUENT_WINDOW_MS. Qualifying buttons rank by count, then by most recent launch. The first
 * is the 'favorite', the next FREQUENT_MAX - 1 are 'frequent', the rest get nothing.
 *
 * @param visibleKeys the keys of the buttons currently rendered; others are ignored
 * @returns key to tier, empty when nothing qualifies
 */
export function frequentChoices(
  entries: readonly TemplateUsageEntry[],
  visibleKeys: readonly string[],
  now: number,
): Map<string, FrequentTier> {
  const visible = new Set(visibleKeys);
  const ranked = entries
    .filter(
      (e) =>
        visible.has(e.key) &&
        e.count >= FREQUENT_MIN_COUNT &&
        now - e.lastUsedAt <= FREQUENT_WINDOW_MS,
    )
    .sort((a, b) => b.count - a.count || b.lastUsedAt - a.lastUsedAt)
    .slice(0, FREQUENT_MAX);
  const tiers = new Map<string, FrequentTier>();
  ranked.forEach((e, i) => tiers.set(e.key, i === 0 ? 'favorite' : 'frequent'));
  return tiers;
}
