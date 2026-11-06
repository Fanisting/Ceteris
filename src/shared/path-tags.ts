/**
 * @file src/shared/path-tags.ts
 * @purpose Rules for folder tags: what a valid tag list is and how tags filter folders.
 *
 * @关键设计:
 * - Main applies normalizeTags to everything it stores, because tags also arrive from
 *   imported archives and hand edited JSON. The renderer applies it to give instant feedback.
 * - Picking several tags narrows the list (a folder needs all of them), as Zotero does.
 * - Every tag has a colour from the first moment: a hash of its name until the user picks
 *   one, so dots tell tags apart without any setup. Only a picked colour is stored.
 * - Colours are stored by id, not hex, so the palette can change without touching user data.
 *
 * @对应文档章节: 软件定义书.md ADR-015
 *
 * @不要在这里做的事:
 * - 不要读写磁盘 (PathManager 负责持久化)
 */

export const MAX_TAG_LENGTH = 32;
export const MAX_TAGS_PER_FOLDER = 20;

/** Mid tones, so a dot reads on both the dark and the light themes. */
export const TAG_COLORS = [
  { id: 'red', hex: '#e5484d' },
  { id: 'orange', hex: '#f76b15' },
  { id: 'yellow', hex: '#d4a017' },
  { id: 'green', hex: '#30a46c' },
  { id: 'cyan', hex: '#06b6d4' },
  { id: 'blue', hex: '#4f6ef7' },
  { id: 'purple', hex: '#8e4ec6' },
  { id: 'pink', hex: '#e93d82' },
] as const;

export type TagColorId = (typeof TAG_COLORS)[number]['id'];

/** Colours the user picked, by tag name. */
export type TagColors = Record<string, TagColorId>;

export function isTagColorId(value: unknown): value is TagColorId {
  return TAG_COLORS.some((c) => c.id === value);
}

/** Keeps the valid entries of an untrusted map, since this also comes from imported files. */
export function sanitizeTagColors(input: unknown): TagColors {
  if (typeof input !== 'object' || input === null) return {};
  const out: TagColors = {};
  for (const [tag, color] of Object.entries(input)) {
    if (isTagColorId(color)) out[tag] = color;
  }
  return out;
}

/** The colour a tag is drawn in: the one picked, else a stable one from its name. */
export function tagColorHex(tag: string, colors: TagColors): string {
  const picked = TAG_COLORS.find((c) => c.id === colors[tag]);
  if (picked) return picked.hex;
  // FNV-1a, folded: similar names such as "paper" and "papr" must land on different colours.
  let hash = 0x811c9dc5;
  for (const ch of tag) hash = Math.imul(hash ^ (ch.codePointAt(0) ?? 0), 16777619);
  const index = ((hash ^ (hash >>> 16)) >>> 0) % TAG_COLORS.length;
  return TAG_COLORS[index]!.hex;
}

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
