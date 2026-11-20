/**
 * @file src/main/agent-skills.test.ts
 * @purpose Rules of agent-skills.ts (ADR-053): which folders Claude Code and Codex skills are
 *   read from, plugin enabling and scope, the parent walk, duplicates and broken files.
 *   Every file lives in a temp folder that stands in for the home folder.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listAgentSkills, type SkillDirs } from './agent-skills';

let home: string;
let dirs: SkillDirs;
let repo: string;
let cwd: string;

async function skill(
  folder: string,
  name: string,
  description = `${name} does things`,
): Promise<void> {
  await mkdir(folder, { recursive: true });
  await writeFile(
    join(folder, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n`,
  );
}

async function json(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, JSON.stringify(value));
}

/** Names per group, the shape the panel shows. */
function shape(groups: Awaited<ReturnType<typeof listAgentSkills>>): string[][] {
  return groups.map((g) => [g.kind, ...g.skills.map((s) => s.name)]);
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'ceteris-skills-'));
  dirs = { home, claudeDir: join(home, '.claude'), codexDir: join(home, '.codex') };
  repo = join(home, 'work', 'repo');
  cwd = join(repo, 'src');
  await mkdir(join(repo, '.git'), { recursive: true });
  await mkdir(cwd, { recursive: true });
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('Claude Code', () => {
  it('lists nothing when no skill folder exists', async () => {
    expect(await listAgentSkills('claude-code', cwd, dirs)).toEqual([]);
  });

  it('lists project skills from the folder and its parents up to the git root, then personal', async () => {
    await skill(join(cwd, '.claude', 'skills', 'near'), 'near');
    await skill(join(repo, '.claude', 'skills', 'root'), 'root');
    // Above the git root: not part of this project.
    await skill(join(home, 'work', '.claude', 'skills', 'outside'), 'outside');
    await skill(join(dirs.claudeDir, 'skills', 'mine-b'), 'mine-b');
    await skill(join(dirs.claudeDir, 'skills', 'mine-a'), 'mine-a');
    const groups = await listAgentSkills('claude-code', cwd, dirs);
    expect(shape(groups)).toEqual([
      ['project', 'near'],
      ['project', 'root'],
      ['personal', 'mine-a', 'mine-b'],
    ]);
    expect(groups[0]?.label).toBe(cwd);
    expect(groups[2]?.skills[0]?.path).toBe(join(dirs.claudeDir, 'skills', 'mine-a', 'SKILL.md'));
  });

  it('never reads the home folder as a project, even when home is a git repository', async () => {
    await mkdir(join(home, '.git'), { recursive: true });
    await rm(join(repo, '.git'), { recursive: true });
    await skill(join(dirs.claudeDir, 'skills', 'mine'), 'mine');
    expect(shape(await listAgentSkills('claude-code', cwd, dirs))).toEqual([['personal', 'mine']]);
    expect(shape(await listAgentSkills('claude-code', home, dirs))).toEqual([['personal', 'mine']]);
  });

  it('reads only the tab folder when it is not inside a git repository', async () => {
    await rm(join(repo, '.git'), { recursive: true });
    await skill(join(cwd, '.claude', 'skills', 'here'), 'here');
    await skill(join(repo, '.claude', 'skills', 'parent'), 'parent');
    expect(shape(await listAgentSkills('claude-code', cwd, dirs))).toEqual([['project', 'here']]);
  });

  it('skips dot folders and folders without a SKILL.md', async () => {
    await skill(join(dirs.claudeDir, 'skills', '.omc'), 'hidden');
    await mkdir(join(dirs.claudeDir, 'skills', 'empty'), { recursive: true });
    await skill(join(dirs.claudeDir, 'skills', 'real'), 'real');
    expect(shape(await listAgentSkills('claude-code', cwd, dirs))).toEqual([['personal', 'real']]);
  });

  it('lists a skill whose SKILL.md has no front matter under its folder name', async () => {
    await mkdir(join(dirs.claudeDir, 'skills', 'bare'), { recursive: true });
    await writeFile(join(dirs.claudeDir, 'skills', 'bare', 'SKILL.md'), '# no header');
    const [group] = await listAgentSkills('claude-code', cwd, dirs);
    expect(group?.skills).toEqual([
      { name: 'bare', description: '', path: join(dirs.claudeDir, 'skills', 'bare', 'SKILL.md') },
    ]);
  });

  describe('plugins', () => {
    const install = join('plugins', 'cache', 'mk', 'tools', '1.0.0');

    beforeEach(async () => {
      const path = join(dirs.claudeDir, install);
      await skill(join(path, 'skills', 'plan'), 'plan');
      await skill(join(path, 'extra', 'verify'), 'verify');
      await json(join(path, '.claude-plugin', 'plugin.json'), {
        name: 'tools',
        skills: ['./extra/verify/', '../../escape'],
      });
      await skill(join(path, '..', '..', 'escape'), 'escape');
      await json(join(dirs.claudeDir, 'plugins', 'installed_plugins.json'), {
        version: 2,
        plugins: { 'tools@mk': [{ scope: 'user', installPath: path }] },
      });
    });

    it('lists an enabled plugin from skills/ and its manifest paths, never outside its folder', async () => {
      await json(join(dirs.claudeDir, 'settings.json'), { enabledPlugins: { 'tools@mk': true } });
      const groups = await listAgentSkills('claude-code', cwd, dirs);
      expect(shape(groups)).toEqual([['plugin', 'plan', 'verify']]);
      expect(groups[0]?.label).toBe('tools');
    });

    it('skips a plugin that is installed but disabled or not mentioned', async () => {
      expect(await listAgentSkills('claude-code', cwd, dirs)).toEqual([]);
      await json(join(dirs.claudeDir, 'settings.json'), { enabledPlugins: { 'tools@mk': false } });
      expect(await listAgentSkills('claude-code', cwd, dirs)).toEqual([]);
    });

    it('lets project settings override the user setting, local settings last', async () => {
      await json(join(dirs.claudeDir, 'settings.json'), { enabledPlugins: { 'tools@mk': true } });
      await json(join(repo, '.claude', 'settings.json'), { enabledPlugins: { 'tools@mk': false } });
      expect(await listAgentSkills('claude-code', cwd, dirs)).toEqual([]);
      await json(join(repo, '.claude', 'settings.local.json'), {
        enabledPlugins: { 'tools@mk': true },
      });
      expect(shape(await listAgentSkills('claude-code', cwd, dirs))).toEqual([
        ['plugin', 'plan', 'verify'],
      ]);
    });

    it('applies a project scope install only inside its project folder', async () => {
      await json(join(dirs.claudeDir, 'settings.json'), { enabledPlugins: { 'tools@mk': true } });
      await json(join(dirs.claudeDir, 'plugins', 'installed_plugins.json'), {
        version: 2,
        plugins: {
          'tools@mk': [
            { scope: 'project', projectPath: repo, installPath: join(dirs.claudeDir, install) },
          ],
        },
      });
      expect(shape(await listAgentSkills('claude-code', cwd, dirs))).toHaveLength(1);
      const elsewhere = join(home, 'other');
      await mkdir(elsewhere, { recursive: true });
      expect(await listAgentSkills('claude-code', elsewhere, dirs)).toEqual([]);
    });

    it('takes a manifest skills path given as one string', async () => {
      const path = join(dirs.claudeDir, install);
      await json(join(path, '.claude-plugin', 'plugin.json'), {
        name: 'tools',
        skills: './extra/verify',
      });
      await json(join(dirs.claudeDir, 'settings.json'), { enabledPlugins: { 'tools@mk': true } });
      expect(shape(await listAgentSkills('claude-code', cwd, dirs))).toEqual([
        ['plugin', 'plan', 'verify'],
      ]);
    });

    it('applies a local scope install only inside its project folder', async () => {
      await json(join(dirs.claudeDir, 'settings.json'), { enabledPlugins: { 'tools@mk': true } });
      await json(join(dirs.claudeDir, 'plugins', 'installed_plugins.json'), {
        version: 2,
        plugins: {
          'tools@mk': [
            {
              scope: 'local',
              projectPath: join(home, 'other'),
              installPath: join(dirs.claudeDir, install),
            },
          ],
        },
      });
      expect(await listAgentSkills('claude-code', cwd, dirs)).toEqual([]);
    });

    it('survives broken settings and plugin list files', async () => {
      await mkdir(dirs.claudeDir, { recursive: true });
      await writeFile(join(dirs.claudeDir, 'settings.json'), '{ not json');
      await writeFile(join(dirs.claudeDir, 'plugins', 'installed_plugins.json'), '[]');
      await skill(join(dirs.claudeDir, 'skills', 'mine'), 'mine');
      expect(shape(await listAgentSkills('claude-code', cwd, dirs))).toEqual([
        ['personal', 'mine'],
      ]);
    });
  });
});

describe('Codex', () => {
  it('lists project, personal (~/.codex and ~/.agents) and built-in system skills', async () => {
    await skill(join(repo, '.agents', 'skills', 'proj-a'), 'proj-a');
    await skill(join(repo, '.codex', 'skills', 'proj-b'), 'proj-b');
    await skill(join(dirs.codexDir, 'skills', 'mine'), 'mine');
    await skill(join(home, '.agents', 'skills', 'shared'), 'shared');
    await skill(join(dirs.codexDir, 'skills', '.system', 'imagegen'), 'imagegen');
    // Claude Code folders are not Codex's.
    await skill(join(dirs.claudeDir, 'skills', 'claude-only'), 'claude-only');
    expect(shape(await listAgentSkills('codex', cwd, dirs))).toEqual([
      ['project', 'proj-a', 'proj-b'],
      ['personal', 'mine', 'shared'],
      ['system', 'imagegen'],
    ]);
  });
});

describe('duplicates', () => {
  it('lists a skill reached through a link once, in the first group', async () => {
    await skill(join(home, '.agents', 'skills', 'shared'), 'shared');
    await mkdir(join(dirs.codexDir, 'skills'), { recursive: true });
    try {
      await symlink(
        join(home, '.agents', 'skills', 'shared'),
        join(dirs.codexDir, 'skills', 'shared'),
        'junction',
      );
    } catch {
      return; // No link rights on this machine; the rule cannot be set up here.
    }
    expect(shape(await listAgentSkills('codex', cwd, dirs))).toEqual([['personal', 'shared']]);
  });
});
