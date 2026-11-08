/**
 * @file scripts/dev-queue-resolve.mjs
 * @purpose Resolves the routine merge conflicts the dev build queue hits with almost every
 *   branch, so they don't bounce back to their owners: both sides add to the same list.
 *
 * @关键设计:
 * - Only three files, each with a rule that keeps both sides' additions:
 *   - CHANGELOG.md: keep both sides' entries. An entry both sides edited (same bold title)
 *     keeps only the incoming version, or the old wording would survive next to the new.
 *   - docs/软件定义书.md: version rows are sorted ascending; a row both sides wrote keeps the
 *     incoming one. ADR sections are sorted newest first; two sections with the same number
 *     are refused (that needs a renumber, not a merge). ADR-019 and later get back the `---`
 *     separator a sort can drop; ADR-001 to 017 never had one.
 *   - src/renderer/index.tsx: keep both sides' import lines; motion.css stays the last
 *     stylesheet, since it must load after every other.
 * - Anything else, or a hunk that doesn't fit its rule, is refused: the queue aborts the merge
 *   and the owner resolves it. A wrong guess here would ship silently.
 *
 * @不要在这里做的事:
 * - 不要在这里跑 git:dev-queue.mjs 负责 merge、add 和 commit,这里只改文件内容
 */
import fs from 'node:fs';
import path from 'node:path';

export const RESOLVABLE = new Set(['CHANGELOG.md', 'docs/软件定义书.md', 'src/renderer/index.tsx']);

const HUNK = /<<<<<<< [^\n]*\n([\s\S]*?)=======\n([\s\S]*?)>>>>>>> [^\n]*\n/g;

class Refuse extends Error {}

function changelog(ours, theirs) {
  const title = (line) => /^- \*\*(.+?)\*\*/.exec(line)?.[1] ?? null;
  const incoming = new Set(theirs.split('\n').map(title).filter(Boolean));
  const kept = ours
    .split('\n')
    .filter((l) => !incoming.has(title(l)))
    .join('\n');
  if (!kept.trim()) return theirs;
  return kept + (kept.endsWith('\n\n') ? '' : '\n') + theirs;
}

const rowVersion = (row) => row.split('|')[1].trim().split('.').map(Number);
const adrNumber = (section) => Number(/^#### ADR-(\d+)/.exec(section)[1]);

function specDoc(ours, theirs) {
  const lines = (ours + theirs).split('\n').filter((l) => l.trim());
  if (lines.length === 1 && lines[0].trim() === '---') return ''; // separators are redone below
  if (lines.length && lines.every((l) => l.startsWith('| 1.'))) {
    const byVersion = new Map();
    for (const row of [...ours.split('\n'), ...theirs.split('\n')].filter(Boolean)) {
      byVersion.set(rowVersion(row).join('.'), row); // incoming (theirs) comes last and wins
    }
    const rows = [...byVersion.values()].sort((a, b) => {
      const [x, y] = [rowVersion(a), rowVersion(b)];
      return x[0] - y[0] || x[1] - y[1];
    });
    return rows.join('\n') + '\n';
  }
  const sections = (ours + theirs).split(/(?=^#### ADR-)/m).filter((s) => s.trim());
  if (!sections.every((s) => s.startsWith('#### ADR-'))) {
    throw new Refuse('a design doc hunk is neither version rows nor ADR sections');
  }
  const numbers = sections.map(adrNumber);
  if (new Set(numbers).size !== numbers.length) {
    throw new Refuse(`two ADR sections share a number (${numbers.join(', ')}); renumber one`);
  }
  return sections
    .map((s) => (s.endsWith('\n') ? s : s + '\n'))
    .sort((a, b) => adrNumber(b) - adrNumber(a))
    .join('');
}

function imports(ours, theirs) {
  const lines = (ours + theirs).split('\n').filter((l) => l.trim());
  if (!lines.every((l) => l.startsWith('import '))) {
    throw new Refuse('an index.tsx hunk is not plain import lines');
  }
  return ours + theirs;
}

/** Puts back `---` before ADR-019 and later, which sorting ADR sections can drop. */
function restoreSeparators(text) {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const m = /^#### ADR-(\d+)/.exec(lines[i]);
    if (!m || Number(m[1]) < 19) continue;
    let j = i - 1;
    while (j >= 0 && lines[j].trim() === '') j -= 1;
    if (lines[j]?.trim() !== '---') lines.splice(i, 0, '---', '');
    else if (lines[i - 1].trim() !== '') lines.splice(i, 0, '');
  }
  return lines.join('\n');
}

const RULES = {
  'CHANGELOG.md': changelog,
  'docs/软件定义书.md': specDoc,
  'src/renderer/index.tsx': imports,
};

/**
 * Resolves the conflicted files in the worktree.
 *
 * @param wt worktree root
 * @param files conflicted paths relative to wt (git with core.quotepath=false)
 * @returns null when every file was resolved, or the reason it refused
 */
export function resolveRoutineConflicts(wt, files) {
  const other = files.filter((f) => !RESOLVABLE.has(f));
  if (other.length) return `conflicts outside the routine files: ${other.join(', ')}`;
  try {
    for (const file of files) {
      const full = path.join(wt, file);
      const raw = fs.readFileSync(full, 'utf8');
      const eol = raw.includes('\r\n') ? '\r\n' : '\n';
      let text = raw
        .replace(/\r\n/g, '\n')
        .replace(HUNK, (_m, ours, theirs) => RULES[file](ours, theirs));
      if (/^(<<<<<<<|>>>>>>>) /m.test(text)) throw new Refuse(`${file} still has conflict markers`);
      if (file === 'docs/软件定义书.md') text = restoreSeparators(text);
      if (file === 'src/renderer/index.tsx') {
        const sheets = [...text.matchAll(/import '\.\/styles\/([\w-]+)\.css';/g)].map((m) => m[1]);
        if (sheets.length && sheets.at(-1) !== 'motion') {
          throw new Refuse('motion.css would no longer be the last stylesheet import');
        }
      }
      fs.writeFileSync(full, text.replace(/\n/g, eol));
    }
    return null;
  } catch (err) {
    if (err instanceof Refuse) return err.message;
    throw err;
  }
}
