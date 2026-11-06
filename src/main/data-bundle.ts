/**
 * @file src/main/data-bundle.ts
 * @purpose Moves a working setup to another PC as one folder. Ceteris's own data always goes
 *   in and stays small. Claude Code and Codex chats are optional, per agent.
 *
 * Copy, never move: chats stay in ~/.claude and ~/.codex, so each agent keeps finding them
 * wherever it is started from. Import only adds files and never deletes any.
 *
 * Agent data uses an allowlist, not a blocklist. Credentials live beside the chats
 * (.claude/.credentials.json, .codex/auth.json), and only the paths named here are ever
 * read, so a login cannot end up in a bundle however the agents change their folders.
 * No electron imports, so it can be tested against temp folders.
 *
 * @对应文档章节: docs/远程访问指南.md
 */
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import type { SettingsArchiveV1 } from '@shared/protocol';
import type { AgentKind } from '@shared/next-prompt';

const FORMAT = 'ceteris-export';
const VERSION = 1;
const MANIFEST = 'manifest.json';
const ARCHIVE = 'ceteris.json';
const TABS = 'tabs.json';

export const AGENTS: Record<AgentKind, { dir: string; entries: string[] }> = {
  claude: { dir: '.claude', entries: ['projects', 'file-history', 'history.jsonl'] },
  codex: {
    dir: '.codex',
    entries: [
      'sessions',
      'archived_sessions',
      'session_index.jsonl',
      'history.jsonl',
      'thread_history_1.sqlite',
    ],
  },
};

/** The new PC's own Codex index may already hold chats, so it is never replaced. */
const ONLY_IF_ABSENT = new Set(['thread_history_1.sqlite']);

export interface CopyStats {
  files: number;
  bytes: number;
  /** Files that could not be read, usually held open by a running agent. */
  failed: number;
}

export interface BundleTab {
  pathId: string;
  templateId: string;
  displayName: string;
  currentCwd: string | null;
  agent: AgentKind | null;
}

export interface BundleManifest {
  format: typeof FORMAT;
  version: typeof VERSION;
  createdAt: number;
  hostname: string;
  home: string;
  tabs: number;
  agents: Partial<Record<AgentKind, CopyStats>>;
}

const emptyStats = (): CopyStats => ({ files: 0, bytes: 0, failed: 0 });

async function exists(path: string): Promise<boolean> {
  return fs.stat(path).then(
    () => true,
    () => false,
  );
}

/** Calls visit for every file under path. Links are skipped so a loop cannot trap it. */
async function walk(path: string, visit: (file: string, size: number) => Promise<void>): Promise<void> {
  const info = await fs.lstat(path).catch(() => null);
  if (!info || info.isSymbolicLink()) return;
  if (info.isFile()) {
    await visit(path, info.size);
    return;
  }
  if (!info.isDirectory()) return;
  for (const name of await fs.readdir(path)) {
    await walk(join(path, name), visit);
  }
}

export async function measureAgentChats(home: string, agent: AgentKind): Promise<CopyStats> {
  const stats = emptyStats();
  const { dir, entries } = AGENTS[agent];
  for (const entry of entries) {
    await walk(join(home, dir, entry), async (_file, size) => {
      stats.files += 1;
      stats.bytes += size;
    });
  }
  return stats;
}

/** Copies keeping the timestamp, because agents sort chats by it. */
async function copyFile(from: string, to: string, stats: CopyStats, size: number): Promise<void> {
  try {
    await fs.mkdir(dirname(to), { recursive: true });
    await fs.copyFile(from, to);
    const { atime, mtime } = await fs.stat(from);
    await fs.utimes(to, atime, mtime);
    stats.files += 1;
    stats.bytes += size;
  } catch {
    stats.failed += 1;
  }
}

async function exportAgent(home: string, bundleDir: string, agent: AgentKind): Promise<CopyStats> {
  const stats = emptyStats();
  const { dir, entries } = AGENTS[agent];
  const root = join(home, dir);
  const target = join(bundleDir, 'agents', agent);
  for (const entry of entries) {
    await walk(join(root, entry), (file, size) =>
      copyFile(file, join(target, file.slice(root.length + 1)), stats, size),
    );
  }
  return stats;
}

/**
 * Claude Code files chats under a folder named after the project path, so a different
 * user name on the new PC means a different name. Only the home prefix changes.
 */
export function encodeClaudeProject(path: string): string {
  return path.replace(/[^a-zA-Z0-9]/g, '-');
}

export function remapClaudeProject(name: string, fromHome: string, toHome: string): string {
  const from = encodeClaudeProject(fromHome);
  const matches = name.toLowerCase() === from.toLowerCase()
    || name.toLowerCase().startsWith(`${from.toLowerCase()}-`);
  return matches ? encodeClaudeProject(toHome) + name.slice(from.length) : name;
}

export function remapHomePath(path: string, fromHome: string, toHome: string): string {
  const lower = path.toLowerCase();
  const prefix = fromHome.toLowerCase();
  if (lower === prefix || lower.startsWith(`${prefix}\\`) || lower.startsWith(`${prefix}/`)) {
    return toHome + path.slice(fromHome.length);
  }
  return path;
}

async function importAgent(
  bundleDir: string,
  home: string,
  sourceHome: string,
  agent: AgentKind,
): Promise<CopyStats> {
  const stats = emptyStats();
  const source = join(bundleDir, 'agents', agent);
  const root = join(home, AGENTS[agent].dir);
  await walk(source, async (file, size) => {
    const parts = file.slice(source.length + 1).split(/[\\/]/);
    const top = parts[0] ?? '';
    if (!AGENTS[agent].entries.includes(top)) return;
    if (agent === 'claude' && top === 'projects' && parts[1]) {
      parts[1] = remapClaudeProject(parts[1], sourceHome, home);
    }
    const target = join(root, ...parts);
    const existing = await fs.stat(target).catch(() => null);
    if (existing) {
      if (ONLY_IF_ABSENT.has(top)) return;
      const incoming = await fs.stat(file);
      if (existing.mtimeMs >= incoming.mtimeMs) return;
    }
    await copyFile(file, target, stats, size);
  });
  return stats;
}

/** Secrets stay out of the bundle, including ones that live inside settings. */
export function stripSecrets(archive: SettingsArchiveV1): SettingsArchiveV1 {
  const copy = JSON.parse(JSON.stringify(archive)) as SettingsArchiveV1;
  copy.settings.ai.apiKey = '';
  copy.settings.ai.nextPrompt.apiKey = '';
  copy.settings.link = { ...copy.settings.link, hostToken: '', hostEnabled: false };
  copy.settings.link.savedHosts = copy.settings.link.savedHosts.map((h) => ({ ...h, token: '' }));
  for (const t of copy.templates.templates) t.env = {};
  return copy;
}

/** Keeps this PC's keys and remote access setup, which the bundle never carries. */
export function withLocalSecrets(
  archive: SettingsArchiveV1,
  current: SettingsArchiveV1['settings'],
): SettingsArchiveV1 {
  const copy = JSON.parse(JSON.stringify(archive)) as SettingsArchiveV1;
  const ai = copy.settings.ai;
  ai.apiKey = current.ai.apiKey;
  ai.nextPrompt.apiKey = current.ai.nextPrompt.apiKey;
  if (!ai.apiKey) ai.statusRecheckEnabled = false;
  if (!ai.nextPrompt.apiKey) ai.nextPrompt.enabled = false;
  copy.settings.link = current.link;
  return copy;
}

export async function writeBundle(options: {
  dir: string;
  home: string;
  hostname: string;
  now: number;
  archive: SettingsArchiveV1;
  tabs: BundleTab[];
  agents: AgentKind[];
}): Promise<BundleManifest> {
  const { dir, home } = options;
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(join(dir, ARCHIVE), JSON.stringify(stripSecrets(options.archive), null, 2));
  await fs.writeFile(join(dir, TABS), JSON.stringify(options.tabs, null, 2));
  const agents: BundleManifest['agents'] = {};
  for (const agent of options.agents) {
    agents[agent] = await exportAgent(home, dir, agent);
  }
  const manifest: BundleManifest = {
    format: FORMAT,
    version: VERSION,
    createdAt: options.now,
    hostname: options.hostname,
    home,
    tabs: options.tabs.length,
    agents,
  };
  // Written last, so an interrupted export never looks complete.
  await fs.writeFile(join(dir, MANIFEST), JSON.stringify(manifest, null, 2));
  return manifest;
}

export async function readManifest(dir: string): Promise<BundleManifest> {
  const path = join(dir, MANIFEST);
  if (!(await exists(path))) {
    throw new Error('这个文件夹不是 Ceteris 导出,或导出没有完成(缺少 manifest.json)。');
  }
  const manifest = JSON.parse(await fs.readFile(path, 'utf-8')) as BundleManifest;
  if (manifest.format !== FORMAT || manifest.version !== VERSION) {
    throw new Error(`不支持的导出格式:${manifest.format} v${manifest.version}。请升级 Ceteris。`);
  }
  return manifest;
}

export async function readArchive(dir: string): Promise<SettingsArchiveV1> {
  return JSON.parse(await fs.readFile(join(dir, ARCHIVE), 'utf-8')) as SettingsArchiveV1;
}

/** Each agent found in the bundle goes back into that agent's own folder. */
export async function importAgents(
  dir: string,
  home: string,
  manifest: BundleManifest,
): Promise<Partial<Record<AgentKind, CopyStats>>> {
  const results: Partial<Record<AgentKind, CopyStats>> = {};
  for (const agent of Object.keys(AGENTS) as AgentKind[]) {
    if (await exists(join(dir, 'agents', agent))) {
      results[agent] = await importAgent(dir, home, manifest.home, agent);
    }
  }
  return results;
}

/** What to type so a reopened tab picks up its last chat in the same folder. */
export function resumeCommand(agent: AgentKind, cwd: string | null, pathId: string): string {
  const run = agent === 'claude' ? 'claude --continue' : 'codex resume --last';
  return cwd && cwd.toLowerCase() !== pathId.toLowerCase() ? `cd "${cwd}"; ${run}\r` : `${run}\r`;
}

export interface RestoredTab {
  pathId: string;
  templateId: string;
  displayName: string;
  /** Base64 keystrokes to send once the terminal exists; empty for a plain tab. */
  input: string;
}

/** Tabs that can reopen here, with paths moved to this PC's home folder. */
export async function readTabs(
  dir: string,
  home: string,
  sourceHome: string,
): Promise<{ tabs: RestoredTab[]; missing: number }> {
  const saved = JSON.parse(await fs.readFile(join(dir, TABS), 'utf-8')) as BundleTab[];
  const tabs: RestoredTab[] = [];
  let missing = 0;
  for (const tab of saved) {
    const pathId = remapHomePath(tab.pathId, sourceHome, home);
    if (!(await exists(pathId))) {
      missing += 1;
      continue;
    }
    const cwd = tab.currentCwd ? remapHomePath(tab.currentCwd, sourceHome, home) : null;
    tabs.push({
      pathId,
      // An agent reopens inside a shell, so leaving it returns to a working terminal.
      templateId: tab.agent ? 'shell' : tab.templateId,
      displayName: tab.displayName,
      input: tab.agent ? Buffer.from(resumeCommand(tab.agent, cwd, pathId)).toString('base64') : '',
    });
  }
  return { tabs, missing };
}
