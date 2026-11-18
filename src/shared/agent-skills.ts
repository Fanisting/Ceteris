/**
 * @file src/shared/agent-skills.ts
 * @purpose Types and pure helpers for the skills panel (ADR-053): what the main process sends
 *   about the skills of the agent in a tab, and how a SKILL.md header is read.
 *
 * @关键设计:
 * - A skill is a folder with a SKILL.md whose YAML front matter holds `name` and `description`.
 *   Ceteris has no YAML library (软件定义书 10.1), and skills only use plain keys, quoted
 *   strings and block scalars (`>` / `|`), so parseSkillFrontMatter reads exactly that and
 *   ignores the rest. A file it cannot read still lists, under its folder name.
 * - Groups say where the skills come from, the way the user thinks of them: this folder
 *   (project), mine (personal), a plugin, or the agent's built-in ones (system).
 *
 * @对应文档章节: 软件定义书.md ADR-053; ipc-protocol.md 5.15
 *
 * @不要在这里做的事:
 * - No file access; reading folders belongs to src/main/agent-skills.ts.
 */
import type { ModelAgent } from './agent-model';

/** Where a group of skills comes from. */
export type SkillGroupKind = 'project' | 'personal' | 'plugin' | 'system';

export interface SkillEntry {
  /** The name the agent knows it by: front matter `name`, else the folder name. */
  name: string;
  /** One paragraph from the front matter, '' when the file has none. */
  description: string;
  /** Absolute path of the SKILL.md, opened in the file viewer on click. */
  path: string;
}

export interface SkillGroup {
  kind: SkillGroupKind;
  /** The plugin name for 'plugin'; otherwise the folder the skills were read from. */
  label: string;
  skills: SkillEntry[];
}

/** Why a tab has no skill list. */
export type SkillsUnavailableReason = 'no-session' | 'no-agent' | 'remote';

export type ListSkillsResult =
  | { ok: true; agent: ModelAgent; groups: SkillGroup[] }
  | { ok: false; reason: SkillsUnavailableReason };

/** Most bytes of a SKILL.md read for its header; a header is never near this long. */
export const SKILL_HEADER_BYTES = 16 * 1024;

/** Longest description kept; the panel shows one line and the viewer shows the rest. */
export const MAX_SKILL_DESCRIPTION = 600;

/**
 * Reads `name` and `description` from the front matter at the top of a SKILL.md.
 *
 * @param text the start of the file (BOM and CRLF allowed)
 * @returns the two fields when present; an empty object when the file has no front matter
 * @throws never
 */
export function parseSkillFrontMatter(text: string): { name?: string; description?: string } {
  const all = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).split(/\r?\n/);
  const end = frontMatterEnd(all);
  // An unclosed header is not front matter: a body line like "description: x" must not count.
  if (end < 0) return {};
  const lines = all.slice(0, end);
  const out: { name?: string; description?: string } = {};
  let i = 1;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    i += 1;
    if (!m) continue;
    const key = m[1] as string;
    const rest = (m[2] as string).trim();
    // Continuation lines are the indented ones that follow (block scalars and wrapped plain text).
    const more: string[] = [];
    while (i < lines.length && /^(\s+\S|\s*$)/.test(lines[i] ?? '')) {
      more.push((lines[i] as string).trim());
      i += 1;
    }
    if (key !== 'name' && key !== 'description') continue;
    const value = scalarValue(rest, more);
    if (value) out[key] = value;
  }
  return out;
}

/** Front matter longer than this many lines is not treated as front matter. */
const MAX_FRONT_MATTER_LINES = 200;

/**
 * Index of the line closing the front matter ("---" or "..." at the start of a line), or -1 when
 * the first line is not "---", the first line inside is not a `key:` line (a note that only opens
 * with a horizontal rule), or nothing closes it within MAX_FRONT_MATTER_LINES.
 */
function frontMatterEnd(lines: readonly string[]): number {
  if (lines[0]?.trimEnd() !== '---') return -1;
  if (!/^[A-Za-z_][\w-]*:/.test(lines[1] ?? '')) return -1;
  const end = lines.findIndex((l, i) => i > 0 && (l.trimEnd() === '---' || l.trimEnd() === '...'));
  return end < 0 || end > MAX_FRONT_MATTER_LINES ? -1 : end;
}

/** The value of one YAML scalar, folded to a single line. */
function scalarValue(first: string, more: string[]): string {
  // `>` and `|` differ only in kept line breaks, and the panel shows one line either way.
  if (/^[>|][-+]?\d*$/.test(first)) {
    return trimEmpty(more).join(' ').replace(/\s+/g, ' ').trim();
  }
  const quote = first[0];
  if (quote === '"' || quote === "'") {
    const all = [first, ...trimEmpty(more)].join(' ');
    const end = all.lastIndexOf(quote);
    const body = end > 0 ? all.slice(1, end) : all.slice(1);
    return (
      quote === '"' ? body.replace(/\\"/g, '"').replace(/\\\\/g, '\\') : body.replace(/''/g, "'")
    )
      .replace(/\s+/g, ' ')
      .trim();
  }
  return [first, ...trimEmpty(more)].join(' ').replace(/\s+/g, ' ').trim();
}

function trimEmpty(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && lines[end - 1] === '') end -= 1;
  return lines.slice(0, end);
}

/**
 * The entry for one skill folder: front matter fields, else the folder name and no description.
 * Descriptions longer than MAX_SKILL_DESCRIPTION are cut with an ellipsis.
 */
export function skillEntryFrom(folderName: string, path: string, header: string): SkillEntry {
  const fm = parseSkillFrontMatter(header);
  let description = fm.description ?? '';
  if (description.length > MAX_SKILL_DESCRIPTION) {
    description = `${description.slice(0, MAX_SKILL_DESCRIPTION - 1).trimEnd()}…`;
  }
  return { name: fm.name || folderName, description, path };
}

/** How many skills all groups hold together. */
export function countSkills(groups: readonly SkillGroup[]): number {
  return groups.reduce((n, g) => n + g.skills.length, 0);
}

/**
 * Markdown with its YAML front matter turned into a ```yaml code block, for the file viewer.
 * markdown-it reads `---` / `name: x` / `---` as a setext heading, so a SKILL.md opened from the
 * skills panel would start with its whole description as one huge heading.
 *
 * @param text a Markdown file (BOM and CRLF allowed)
 * @returns the text unchanged when it has no front matter (see frontMatterEnd)
 * @throws never
 */
export function frontMatterAsCode(text: string): string {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = body.split(/\r?\n/);
  const end = frontMatterEnd(lines);
  if (end < 0) return text;
  const inner = lines.slice(1, end);
  // A fence longer than any backtick run inside, so the block cannot be closed early.
  const longest = Math.max(
    2,
    ...inner.map((l) => Math.max(0, ...(l.match(/`+/g) ?? []).map((r) => r.length))),
  );
  const fence = '`'.repeat(longest + 1);
  return [`${fence}yaml`, ...inner, fence, ...lines.slice(end + 1)].join('\n');
}
