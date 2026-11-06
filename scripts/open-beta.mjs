#!/usr/bin/env node
/**
 * @file scripts/open-beta.mjs
 * @purpose npm run beta: opens the newest beta build from a terminal in stable.
 *
 * It starts detached, so closing that terminal leaves the beta running. Variables that
 * describe the launching app are removed: a beta started from a stable terminal must not
 * inherit stable's identity, and a leftover PORTABLE_EXECUTABLE_DIR changes the build type.
 */
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const FOLDER = join('release', 'beta');

function newestBeta() {
  let names = [];
  try {
    names = readdirSync(FOLDER);
  } catch {
    return null;
  }
  const builds = names
    .map((name) => join(FOLDER, name, 'win-unpacked', 'CeterisBeta.exe'))
    .filter((exe) => existsSync(exe))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return builds[0] ?? null;
}

const exe = newestBeta();
if (!exe) {
  console.error(`No beta build in ${FOLDER}. Run npm run build:beta first.`);
  process.exit(1);
}

const env = { ...process.env };
for (const name of Object.keys(env)) {
  if (/^(TERM_PROGRAM|CETERIS_|PORTABLE_EXECUTABLE_|ELECTRON_|CLAUDE)/.test(name)) delete env[name];
}

spawn(exe, [], { detached: true, stdio: 'ignore', env }).unref();
console.log(`Opened ${exe}`);
