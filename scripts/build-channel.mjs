#!/usr/bin/env node
/**
 * @file scripts/build-channel.mjs
 * @purpose Builds one release channel into its own folder.
 *
 *   npm run build:stable   installer in release/stable, version from package.json
 *   npm run build:beta     folder in release/beta/<version>, version <package>-beta.<commits>
 *
 * Each channel has its own output folder so a build for one never touches files the
 * other is running from. Stable builds only the installer: a portable stable looks like
 * the same app, but it has its own data folder and an installed update never reaches it.
 * Beta is an unpacked folder, not a single-file portable exe. Launching one of those a
 * second time deletes files from under the running copy, which any right-click or second
 * launch would do. A new folder per version also means a build never touches a running
 * beta. Only the two newest are kept.
 * The beta version comes from the commit count, so every beta is newer than the last
 * without editing package.json.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

const channel = process.argv[2];
if (channel !== 'stable' && channel !== 'beta') {
  console.error('Usage: node scripts/build-channel.mjs stable|beta');
  process.exit(2);
}

const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
if (version.includes('-')) {
  console.error(
    `package.json version "${version}" is a prerelease. It should hold the stable version: ` +
      'beta versions are derived from it when building.',
  );
  process.exit(2);
}

const commits = execFileSync('git', ['rev-list', '--count', 'HEAD'], { encoding: 'utf8' }).trim();
const betaVersion = `${version}-beta.${commits}`;
const builderArgs =
  channel === 'stable'
    ? ['--config', 'electron-builder.yml', '-c.directories.output=release/stable']
    : [
        '--config',
        'electron-builder.beta.yml',
        `-c.directories.output=release/beta/${betaVersion}`,
        `-c.extraMetadata.version=${betaVersion}`,
      ];

function run(args) {
  console.log(`> npx ${args.join(' ')}`);
  const { status } = spawnSync('npx', args, { stdio: 'inherit', shell: true });
  if (status !== 0) process.exit(status ?? 1);
}

run(['electron-vite', 'build']);
const target = channel === 'stable' ? 'nsis' : 'dir';
run(['electron-builder', '--win', target, '--x64', '--publish', 'never', ...builderArgs]);
/** Keeps the two newest betas. One in use is locked, so it simply stays until next time. */
function pruneOldBetas() {
  const root = join('release', 'beta');
  const entries = readdirSync(root).map((name) => join(root, name));
  const folders = entries
    .filter((entry) => statSync(entry).isDirectory() && /^\d/.test(entry.split(/[\\/]/).pop()))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  const stale = [
    ...folders.slice(2),
    // Left by earlier builds, from before beta was a folder.
    ...entries.filter((entry) => /CeterisBeta-.*\.exe|win-unpacked|builder-/.test(entry)),
  ];
  for (const entry of stale) {
    try {
      rmSync(entry, { recursive: true, force: true });
    } catch {
      console.log(`Kept ${entry}: it is in use.`);
    }
  }
}

if (channel === 'beta') pruneOldBetas();
console.log(`\nBuilt ${channel} in release/${channel}`);
