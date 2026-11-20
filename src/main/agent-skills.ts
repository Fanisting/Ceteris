/**
 * @file src/main/agent-skills.ts
 * @purpose Lists the skills Claude Code or Codex can use in a folder, for the skills panel in
 *   the sidebar (ADR-053). Read only: Ceteris never writes into ~/.claude, ~/.codex or a
 *   project's skill folders.
 *
 * @关键设计:
 * - Where each agent looks (checked against Claude Code 2.1 and Codex 0.167 on 2026-11-18):
 *   - Claude Code: <folder>/.claude/skills (the tab's folder and its parents up to the git
 *     root), <claudeDir>/skills, and the skills of every enabled plugin. A plugin is enabled when
 *     `enabledPlugins["name@marketplace"]` is true in the user settings, overridden by the
 *     project's .claude/settings.json and .claude/settings.local.json. Its install folder comes
 *     from <claudeDir>/plugins/installed_plugins.json; its skills are in skills/ plus any paths
 *     its .claude-plugin/plugin.json lists under "skills".
 *   - Codex: <folder>/.agents/skills and <folder>/.codex/skills (same walk), <codexDir>/skills,
 *     ~/.agents/skills, and the built-in ones in <codexDir>/skills/.system.
 * - The parent walk stops at the git root. Outside a repository only the tab's own folder is
 *   read, so a tab in D:/data/proj never picks up D:/.claude. The home folder is never read as a
 *   project, so ~/.claude/skills is not listed twice when home is itself a git repository.
 * - A SKILL.md reached through two paths (a symlink in ~/.claude/skills into ~/.agents/skills)
 *   is listed once, in the first group that finds it.
 * - Every read failure (missing folder, broken JSON, unreadable file) skips that one source and
 *   logs at debug: an agent without plugins or project skills is the normal case.
 *
 * @对应文档章节: 软件定义书.md ADR-053; ipc-protocol.md 5.15
 *
 * @不要在这里做的事:
 * - No writes, no network, no running the agent to ask it.
 * - No guessing which agent runs in a tab; the caller passes it.
 */

import { open, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { ModelAgent } from '@shared/agent-model';
import {
  SKILL_HEADER_BYTES,
  skillEntryFrom,
  type SkillEntry,
  type SkillGroup,
} from '@shared/agent-skills';
import { logger } from './logger';

/** Most skills read from one folder, so a mistaken huge folder cannot stall the panel. */
const MAX_SKILLS_PER_DIR = 400;

export interface SkillDirs {
  /** The user's home folder */
  home: string;
  /** CLAUDE_CONFIG_DIR or ~/.claude */
  claudeDir: string;
  /** CODEX_HOME or ~/.codex */
  codexDir: string;
}

/**
 * Every skill the agent can use in `cwd`, grouped by where it comes from. Empty groups are left
 * out; skills inside a group are sorted by name.
 *
 * @param agent which agent's folders to read
 * @param cwd the tab's folder, absolute
 * @param dirs the home and agent config folders
 * @returns groups in the order project, personal, plugins (by name), system
 * @throws never; unreadable sources are skipped
 */
export async function listAgentSkills(
  agent: ModelAgent,
  cwd: string,
  dirs: SkillDirs,
): Promise<SkillGroup[]> {
  const seen = new Set<string>();
  const folders = await projectFolders(cwd, dirs.home);
  const groups: SkillGroup[] = [];
  const push = async (
    kind: SkillGroup['kind'],
    label: string,
    roots: readonly string[],
  ): Promise<void> => {
    const skills: SkillEntry[] = [];
    for (const root of roots) skills.push(...(await readSkillsIn(root, seen)));
    if (skills.length === 0) return;
    skills.sort((a, b) => a.name.localeCompare(b.name));
    groups.push({ kind, label, skills });
  };

  if (agent === 'claude-code') {
    for (const dir of folders) await push('project', dir, [join(dir, '.claude', 'skills')]);
    await push('personal', join(dirs.claudeDir, 'skills'), [join(dirs.claudeDir, 'skills')]);
    for (const plugin of await enabledClaudePlugins(dirs.claudeDir, cwd, folders)) {
      await push('plugin', plugin.name, plugin.skillRoots);
    }
  } else {
    for (const dir of folders) {
      await push('project', dir, [join(dir, '.agents', 'skills'), join(dir, '.codex', 'skills')]);
    }
    const codexSkills = join(dirs.codexDir, 'skills');
    await push('personal', codexSkills, [codexSkills, join(dirs.home, '.agents', 'skills')]);
    await push('system', join(codexSkills, '.system'), [join(codexSkills, '.system')]);
  }
  return groups;
}

/**
 * The tab's folder and its parents, nearest first, up to and including the first one with a
 * .git entry. Without a repository only the tab's own folder counts: its parents are unrelated
 * folders. The home folder is never one; the walk stops there.
 */
async function projectFolders(cwd: string, home: string): Promise<string[]> {
  const out: string[] = [];
  const homeAbs = resolve(home).toLowerCase();
  let dir = resolve(cwd);
  for (;;) {
    // ~/.claude/skills is the personal group, so home is never a project folder. Lower case
    // because Windows paths ignore case; two Linux folders differing only in case are not a
    // real setup to plan for.
    if (dir.toLowerCase() === homeAbs) break;
    out.push(dir);
    if (await exists(join(dir, '.git'))) return out;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return out.slice(0, 1);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Skills in one folder: each child folder with a SKILL.md, or the folder itself when it holds a
 * SKILL.md (plugin.json may point at one skill directly). Folders starting with "." are skipped.
 */
async function readSkillsIn(root: string, seen: Set<string>): Promise<SkillEntry[]> {
  const own = join(root, 'SKILL.md');
  if (await exists(own)) {
    const one = await readSkill(root.split(/[\\/]/).pop() ?? root, own, seen);
    return one ? [one] : [];
  }
  let names: string[];
  try {
    names = (await readdir(root)).filter((n) => !n.startsWith('.')).slice(0, MAX_SKILLS_PER_DIR);
  } catch (err) {
    logger.debug(
      'agent-skills',
      `skill folder ${root} not readable: ${(err as NodeJS.ErrnoException).code ?? String(err)}`,
    );
    return [];
  }
  const entries = await Promise.all(
    names.map((n) => readSkill(n, join(root, n, 'SKILL.md'), seen)),
  );
  return entries.filter((e): e is SkillEntry => e !== null);
}

/** One SKILL.md, or null when it does not exist or was already listed through another path. */
async function readSkill(
  folderName: string,
  path: string,
  seen: Set<string>,
): Promise<SkillEntry | null> {
  let real: string;
  try {
    real = (await realpath(path)).toLowerCase();
  } catch {
    return null;
  }
  if (seen.has(real)) return null;
  seen.add(real);
  try {
    const fh = await open(path, 'r');
    try {
      const buf = Buffer.alloc(SKILL_HEADER_BYTES);
      const { bytesRead } = await fh.read(buf, 0, SKILL_HEADER_BYTES, 0);
      return skillEntryFrom(folderName, path, buf.subarray(0, bytesRead).toString('utf8'));
    } finally {
      await fh.close();
    }
  } catch (err) {
    logger.debug(
      'agent-skills',
      `${path} not readable: ${(err as NodeJS.ErrnoException).code ?? String(err)}`,
    );
    return { name: folderName, description: '', path };
  }
}

interface PluginSkills {
  name: string;
  skillRoots: string[];
}

interface InstalledEntry {
  scope?: unknown;
  installPath?: unknown;
  projectPath?: unknown;
}

/**
 * Enabled Claude Code plugins that apply in `cwd`, with the folders their skills live in,
 * sorted by plugin name.
 */
async function enabledClaudePlugins(
  claudeDir: string,
  cwd: string,
  projectDirs: readonly string[],
): Promise<PluginSkills[]> {
  const installed = await readJson(join(claudeDir, 'plugins', 'installed_plugins.json'));
  const plugins = isRecord(installed) && isRecord(installed['plugins']) ? installed['plugins'] : {};
  // Later files override earlier ones, the way Claude Code merges its settings.
  const enabled: Record<string, unknown> = {};
  const settingsFiles = [join(claudeDir, 'settings.json')];
  for (const dir of [...projectDirs].reverse()) {
    settingsFiles.push(join(dir, '.claude', 'settings.json'));
    settingsFiles.push(join(dir, '.claude', 'settings.local.json'));
  }
  for (const file of settingsFiles) {
    const s = await readJson(file);
    if (isRecord(s) && isRecord(s['enabledPlugins'])) Object.assign(enabled, s['enabledPlugins']);
  }

  const out: PluginSkills[] = [];
  for (const [key, on] of Object.entries(enabled)) {
    if (on !== true) continue;
    const entries = plugins[key];
    if (!Array.isArray(entries)) continue;
    const entry = (entries as InstalledEntry[]).find((e) => appliesHere(e, cwd));
    if (!entry || typeof entry.installPath !== 'string') continue;
    const installPath = entry.installPath;
    const roots = [join(installPath, 'skills')];
    const manifest = await readJson(join(installPath, '.claude-plugin', 'plugin.json'));
    const listed = isRecord(manifest) ? manifest['skills'] : undefined;
    for (const p of typeof listed === 'string' ? [listed] : Array.isArray(listed) ? listed : []) {
      if (typeof p !== 'string') continue;
      const abs = resolve(installPath, p);
      // A manifest may only point inside its own plugin folder.
      if (relative(installPath, abs).startsWith('..')) continue;
      if (!roots.includes(abs)) roots.push(abs);
    }
    const name =
      isRecord(manifest) && typeof manifest['name'] === 'string'
        ? manifest['name']
        : (key.split('@')[0] ?? key);
    out.push({ name, skillRoots: roots });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** A user scope install applies everywhere; a project or local one only inside its folder. */
function appliesHere(entry: InstalledEntry, cwd: string): boolean {
  if (entry.scope === 'user' || entry.scope === undefined) return true;
  if (typeof entry.projectPath !== 'string') return false;
  const rel = relative(entry.projectPath.toLowerCase(), cwd.toLowerCase());
  return !rel.startsWith('..') && !isAbsolute(rel);
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT')
      logger.debug('agent-skills', `${path} not readable: ${code ?? String(err)}`);
    return null;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
