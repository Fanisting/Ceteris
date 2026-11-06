/**
 * @file scripts/after-pack.cjs
 * @purpose Fixes two things in a packaged Mac app before it goes into the dmg.
 *
 * - node-pty's prebuilt spawn-helper arrives without its execute bit. Every terminal then
 *   fails with "posix_spawnp failed", though the app itself starts normally.
 * - With no Apple certificate electron-builder skips signing, which leaves Electron's
 *   signature broken by the packaged changes. Apple Silicon reports such an app as damaged,
 *   so it gets an ad hoc signature. Gatekeeper still asks on first open.
 *
 * Runs on every platform through electron-builder.yml, and only acts on Mac builds.
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function findHelpers(dir, found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) findHelpers(full, found);
    else if (entry.name === 'spawn-helper') found.push(full);
  }
  return found;
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const name = `${context.packager.appInfo.productFilename}.app`;
  const app = path.join(context.appOutDir, name);
  const unpacked = path.join(app, 'Contents', 'Resources', 'app.asar.unpacked');
  const helpers = findHelpers(unpacked);
  if (helpers.length === 0) {
    throw new Error(`[after-pack] no spawn-helper under ${unpacked}. Terminals would not start.`);
  }
  for (const helper of helpers) fs.chmodSync(helper, 0o755);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
  console.log(`[after-pack] fixed ${helpers.length} spawn-helper files and signed ${name}`);
};
