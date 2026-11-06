#!/usr/bin/env node
/**
 * @file scripts/build-channel.mjs
 * @purpose Builds one release channel into its own folder.
 *
 *   npm run build:stable   installer in release/stable, version from package.json
 *   npm run build:beta     portable exe in release/beta, version <package>-beta.<commits>
 *
 * Each channel has its own output folder so a build for one never touches files the
 * other is running from. The beta version comes from the commit count, so every beta is
 * newer than the last without editing package.json.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

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
const builderArgs =
  channel === 'stable'
    ? ['--config', 'electron-builder.yml', '-c.directories.output=release/stable']
    : [
        '--config',
        'electron-builder.beta.yml',
        '-c.directories.output=release/beta',
        `-c.extraMetadata.version=${version}-beta.${commits}`,
      ];

function run(args) {
  console.log(`> npx ${args.join(' ')}`);
  const { status } = spawnSync('npx', args, { stdio: 'inherit', shell: true });
  if (status !== 0) process.exit(status ?? 1);
}

run(['electron-vite', 'build']);
run(['electron-builder', '--win', '--x64', '--publish', 'never', ...builderArgs]);
console.log(`\nBuilt ${channel} in release/${channel}`);
