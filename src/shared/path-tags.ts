/**
 * @file src/shared/path-tags.ts
 * @purpose Rules for folder tags: what a valid tag list is and how tags filter folders.
 *
 * @关键设计:
 * - Main applies normalizeTags to everything it stores, because tags also arrive from
 *   imported archives and hand edited JSON. The renderer applies it to give instant feedback.
 * - Picking several tags narrows the list (a folder needs all of them), as Zotero does.
 *
 * @对应文档章节: 软件定义书.md ADR-015
 *
 * @不要在这里做的事:
 * - 不要读写磁盘 (PathManager 负责持久化)
 */

export const MAX_TAG_LENGTH = 32;
export const MAX_TAGS_PER_FOLDER = 20;

export interface TagCount {
  name: string;
  count: number;
}

/**
 * Cleans a tag list. Spacing is tidied, blanks are dropped, and tags that differ only by
 * case count as one, keeping the first spelling.
 *
 * @param input anything, since imported data is not trusted. A non array gives no tags.
 */
export function normalizeTags(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input) {
    if (typeof raw !== 'string') continue;
    const tag = raw.trim().replace(/\s+/g, ' ').slice(0, MAX_TAG_LENGTH).trim();
    const key = tag.toLowerCase();
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length === MAX_TAGS_PER_FOLDER) break;
  }
  return out;
}

/** Every tag in use and how many folders carry it, sorted by name. */
export function countTags(folders: ReadonlyArray<{ tags?: string[] }>): TagCount[] {
  const counts = new Map<string, number>();
  for (const folder of folders) {
    for (const tag of folder.tags ?? []) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return [...counts]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** True when the folder carries every selected tag. No selection matches everything. */
export function matchesTags(tags: string[] | undefined, selected: readonly string[]): boolean {
  return selected.every((tag) => tags?.includes(tag));
}
