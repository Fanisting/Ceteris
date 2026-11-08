#!/usr/bin/env node
/**
 * @file scripts/dev-queue.mjs
 * @purpose Merge queue for the local dev build. Sessions working in parallel worktrees queue a
 * finished branch; `merge` folds every queued branch into the dev-build worktree one at a time,
 * checks each merge, and makes sure the dev window is running.
 *
 * Usage (from any worktree):
 *   node scripts/dev-queue.mjs add [branch] [--merge]   queue a branch at its current tip
 *                                                        (default: the current branch);
 *                                                        --merge also runs the queue now
 *   node scripts/dev-queue.mjs list                      queued branches and recent results
 *   node scripts/dev-queue.mjs merge [--no-checks] [--allow-deps] [--no-open]
 *   node scripts/dev-queue.mjs open                      start the dev window if it is not running
 *   node scripts/dev-queue.mjs restart                   stop and start the dev window
 *
 * Environment:
 *   CETERIS_DEV_WT      integration worktree (default D:/ceteris-wt-preview)
 *   CETERIS_DEV_BRANCH  branch checked out there (default dev-build)
 *   CETERIS_DEV_QUEUE   folder for the queue, log, lock and dev window data (default ~/.ceteris-dev)
 *
 * @关键设计:
 * - The queue lives outside every worktree, so any session can add to it and nothing is committed.
 * - Each branch is merged on its own and checked before the next one: a failure is attributed to
 *   one branch and undone with `git reset --hard` to the commit before that merge.
 * - Checks per merge, in order: branch tip still matches the queued sha; branch contains
 *   origin/main; no dependency change unless --allow-deps (new packages need the user's approval,
 *   AGENTS.md boundary 2); merge without conflicts; material.css brace depth still 0; no new
 *   duplicate ADR heading or version row in 软件定义书.md; typecheck, lint, npm test.
 * - The dev window runs `electron-vite dev --watch`, so merged code reloads by itself. The window
 *   is restarted only after a dependency change, and started if none is running.
 *
 * @不要在这里做的事:
 * - Do not push or touch main; the dev build is local.
 * - Do not resolve conflicts automatically; the branch owner rebases and queues again.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WT = path.resolve(process.env.CETERIS_DEV_WT ?? 'D:/ceteris-wt-preview');
const BRANCH = process.env.CETERIS_DEV_BRANCH ?? 'dev-build';
const QDIR = path.resolve(process.env.CETERIS_DEV_QUEUE ?? path.join(os.homedir(), '.ceteris-dev'));
const QUEUE = path.join(QDIR, 'queue.json');
const LOG = path.join(QDIR, 'log.txt');
const LOCK = path.join(QDIR, 'merge.lock');
const CHECK_LOGS = path.join(QDIR, 'check-logs');
const DEV_DATA = path.join(QDIR, 'devdata');
const DEV_LOG = path.join(QDIR, 'dev.log');

const MATERIAL_CSS = 'src/renderer/styles/material.css';
const SPEC_DOC = 'docs/软件定义书.md';
const DEP_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
  'overrides',
];
const CHECKS = [
  ['typecheck', ['run', 'typecheck']],
  ['lint', ['run', 'lint']],
  ['test', ['test']],
];

// ---------- small helpers ----------

function git(args, cwd = WT) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function tryGit(args, cwd = WT) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
}

const isAncestor = (a, b) => tryGit(['merge-base', '--is-ancestor', a, b]).ok;
const short = (sha) => sha.slice(0, 7);
const stamp = () => new Date().toISOString().slice(0, 16).replace('T', ' ');

function readQueue() {
  try {
    return JSON.parse(fs.readFileSync(QUEUE, 'utf8'));
  } catch {
    return [];
  }
}

// Write to a temp file and rename, so a session reading the queue never sees half a file.
function writeQueue(entries) {
  fs.mkdirSync(QDIR, { recursive: true });
  const tmp = `${QUEUE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(entries, null, 2));
  fs.renameSync(tmp, QUEUE);
}

function log(line) {
  fs.mkdirSync(QDIR, { recursive: true });
  fs.appendFileSync(LOG, `${stamp()} ${line}\n`);
  console.log(line);
}

/** File content at a commit, or null when the file does not exist there. */
function show(rev, file) {
  const r = tryGit(['show', `${rev}:${file}`]);
  return r.ok ? r.out : null;
}

// ---------- static checks ----------

/** Brace depth at the end of a CSS file, ignoring comments and strings. */
function braceDepth(css) {
  const stripped = css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '');
  let depth = 0;
  for (const ch of stripped) {
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
  }
  return depth;
}

/** ADR numbers and version rows that appear more than once in the spec document. */
function specDuplicates(doc) {
  const dups = new Set();
  const count = (re, label) => {
    const seen = new Map();
    for (const m of doc.matchAll(re)) seen.set(m[1], (seen.get(m[1]) ?? 0) + 1);
    for (const [k, n] of seen) if (n > 1) dups.add(`${label} ${k}`);
  };
  count(/^#{2,6} ADR-(\d+)/gm, 'ADR');
  count(/^\| (\d+\.\d+) \|/gm, 'version row');
  return dups;
}

function depsOf(rev) {
  const text = show(rev, 'package.json');
  if (!text) return '';
  const pkg = JSON.parse(text);
  return JSON.stringify(DEP_FIELDS.map((f) => pkg[f] ?? null));
}

/** Problems a merge introduced: compares the merged tree with the commit before the merge. */
function staticProblems(before, after) {
  const problems = [];
  const cssBefore = show(before, MATERIAL_CSS);
  const cssAfter = show(after, MATERIAL_CSS);
  if (
    cssAfter !== null &&
    braceDepth(cssAfter) !== 0 &&
    (cssBefore === null || braceDepth(cssBefore) === 0)
  ) {
    problems.push(`${MATERIAL_CSS} brace depth is ${braceDepth(cssAfter)}, not 0`);
  }
  const docBefore = show(before, SPEC_DOC);
  const docAfter = show(after, SPEC_DOC);
  if (docAfter !== null) {
    const old = docBefore === null ? new Set() : specDuplicates(docBefore);
    const fresh = [...specDuplicates(docAfter)].filter((d) => !old.has(d));
    if (fresh.length) {
      problems.push(
        `${SPEC_DOC} now has duplicate ${fresh.join(', ')}; claim a free number in the ADR registry`,
      );
    }
  }
  return problems;
}

// ---------- npm ----------

function npm(args, logFile) {
  const out = logFile ? fs.openSync(logFile, 'w') : 'ignore';
  // npm is npm.cmd on Windows, which needs a shell. The args are the fixed lists in CHECKS,
  // so passing one command string is safe.
  const r =
    process.platform === 'win32'
      ? spawnSync(`npm ${args.join(' ')}`, { cwd: WT, stdio: ['ignore', out, out], shell: true })
      : spawnSync('npm', args, { cwd: WT, stdio: ['ignore', out, out] });
  if (typeof out === 'number') fs.closeSync(out);
  return r.status === 0;
}

// After a dependency change Vite's prebundled deps go stale and React can load twice
// ("Invalid hook call", blank window), so they are cleared along with the reinstall.
function reinstall() {
  fs.rmSync(path.join(WT, 'node_modules', '.vite', 'deps'), { recursive: true, force: true });
  return npm(['ci'], path.join(CHECK_LOGS, 'npm-ci.log'));
}

// ---------- dev window ----------

const norm = (p) => p.replace(/\\/g, '/').toLowerCase();

/** PIDs of electron-vite dev processes started from the integration worktree. */
function devPids() {
  let rows = [];
  if (process.platform === 'win32') {
    const ps =
      'Get-CimInstance Win32_Process -Filter "Name=\'node.exe\'" | ' +
      "Where-Object { $_.CommandLine -like '*electron-vite*' } | " +
      'ForEach-Object { "$($_.ProcessId)`t$($_.CommandLine)" }';
    const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8' });
    rows = (r.stdout ?? '').split(/\r?\n/);
  } else {
    const r = spawnSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' });
    rows = (r.stdout ?? '').split('\n').map((l) => l.trim().replace(/\s+/, '\t'));
  }
  const wt = norm(WT);
  return rows
    .map((row) => row.split('\t'))
    .filter(([, cmd]) => cmd && / dev\b/.test(cmd) && norm(cmd).includes(wt))
    .map(([pid]) => Number(pid));
}

function startDev() {
  const bin = path.join(WT, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js');
  if (!fs.existsSync(bin)) {
    console.log(`No electron-vite in ${WT}; run npm ci there first.`);
    return;
  }
  fs.mkdirSync(DEV_DATA, { recursive: true });
  // Variables describing the launching app must not leak into the dev copy (same as open-beta.mjs).
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (/^(TERM_PROGRAM|CETERIS_|PORTABLE_EXECUTABLE_|ELECTRON_|CLAUDE)/.test(name))
      delete env[name];
  }
  const out = fs.openSync(DEV_LOG, 'w');
  const child = spawn(
    process.execPath,
    [bin, 'dev', '--watch', '--', `--user-data-dir=${DEV_DATA}`],
    {
      cwd: WT,
      env,
      detached: true,
      stdio: ['ignore', out, out],
      windowsHide: true,
    },
  );
  child.unref();
  console.log(`Started the dev window from ${WT} (pid ${child.pid}); output in ${DEV_LOG}.`);
}

function stopDev(pids) {
  for (const pid of pids) {
    if (process.platform === 'win32')
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    else {
      try {
        process.kill(pid);
      } catch {
        /* already gone */
      }
    }
  }
}

function ensureDev({ restart = false } = {}) {
  const pids = devPids();
  if (pids.length && !restart) {
    console.log(
      `Dev window already running from ${WT} (pid ${pids.join(', ')}); it hot reloads merged code.`,
    );
    return;
  }
  if (pids.length) stopDev(pids);
  startDev();
}

// ---------- lock ----------

function takeLock() {
  fs.mkdirSync(QDIR, { recursive: true });
  try {
    fs.mkdirSync(LOCK);
  } catch {
    let owner = NaN;
    try {
      owner = Number(fs.readFileSync(path.join(LOCK, 'pid'), 'utf8'));
    } catch {
      /* lock folder without a pid file: treat as stale below */
    }
    let alive = false;
    try {
      alive = Number.isFinite(owner) && process.kill(owner, 0);
    } catch {
      alive = false;
    }
    if (alive) return false;
    fs.rmSync(LOCK, { recursive: true, force: true });
    fs.mkdirSync(LOCK);
  }
  fs.writeFileSync(path.join(LOCK, 'pid'), String(process.pid));
  return true;
}

const releaseLock = () => fs.rmSync(LOCK, { recursive: true, force: true });

// ---------- commands ----------

function add(args) {
  const name = args.find((a) => !a.startsWith('--'));
  const cwd = process.cwd();
  const branch = name ?? git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  if (branch === 'HEAD') throw new Error('Detached HEAD: name the branch to queue.');
  const sha = git(['rev-parse', '--verify', `refs/heads/${branch}^{commit}`], cwd);
  if (!name && git(['status', '--porcelain', '--untracked-files=no'], cwd)) {
    console.log('Note: this worktree has uncommitted changes; only committed work is queued.');
  }
  const queue = readQueue().filter((e) => e.branch !== branch);
  queue.push({ branch, sha, addedAt: new Date().toISOString() });
  writeQueue(queue);
  log(`queued ${branch} ${short(sha)} (position ${queue.length})`);
  if (args.includes('--merge')) merge(args);
}

function list() {
  const queue = readQueue();
  console.log(queue.length ? 'Queued:' : 'Queue is empty.');
  for (const e of queue)
    console.log(`  ${e.branch} ${short(e.sha)}  added ${e.addedAt.slice(0, 16)}`);
  if (fs.existsSync(LOG)) {
    console.log('\nRecent results:');
    console.log(
      fs
        .readFileSync(LOG, 'utf8')
        .trim()
        .split('\n')
        .slice(-15)
        .map((l) => `  ${l}`)
        .join('\n'),
    );
  }
  const pids = devPids();
  console.log(`\nDev window: ${pids.length ? `running (pid ${pids.join(', ')})` : 'not running'}`);
}

/** Merges one queued entry. Returns 'merged', 'present' or 'skipped'; the reason goes to the log. */
function mergeOne({ branch, sha }, opts) {
  const skip = (reason) => {
    log(`skipped ${branch} ${short(sha)}: ${reason}`);
    return 'skipped';
  };
  const tip = tryGit(['rev-parse', '--verify', '-q', `refs/heads/${branch}^{commit}`]);
  if (!tip.ok) return skip('branch no longer exists');
  if (tip.out !== sha)
    return skip(`branch moved to ${short(tip.out)} after it was queued; queue it again`);
  if (isAncestor(sha, 'HEAD')) {
    log(`already in ${BRANCH}: ${branch} ${short(sha)}`);
    return 'present';
  }
  if (opts.hasOriginMain && !isAncestor('origin/main', sha)) {
    return skip(
      `not based on origin/main ${short(git(['rev-parse', 'origin/main']))}; rebase it and queue again`,
    );
  }

  const before = git(['rev-parse', 'HEAD']);
  const base = git(['merge-base', before, sha]);
  const depsChanged = depsOf(base) !== depsOf(sha);
  if (depsChanged && !opts.allowDeps) {
    return skip(
      "changes dependencies in package.json; new packages need the user's approval, then run merge --allow-deps",
    );
  }

  const merged = tryGit([
    'merge',
    '--no-ff',
    '--no-edit',
    '-m',
    `Merge branch '${branch}' into ${BRANCH}`,
    sha,
  ]);
  if (!merged.ok) {
    const files = tryGit(['diff', '--name-only', '--diff-filter=U'])
      .out.split('\n')
      .filter(Boolean);
    tryGit(['merge', '--abort']);
    return skip(
      `conflicts with ${BRANCH} in ${files.join(', ') || '(see git output)'}; merge ${BRANCH} into the branch, resolve, and queue again`,
    );
  }

  // From here on any failure undoes this one merge and nothing else.
  const undo = (reason) => {
    git(['reset', '--hard', before]);
    if (depsChanged) reinstall();
    return skip(reason);
  };

  const problems = staticProblems(before, 'HEAD');
  if (problems.length) return undo(problems.join('; '));

  if (depsChanged && !reinstall())
    return undo(`npm ci failed; see ${path.join(CHECK_LOGS, 'npm-ci.log')}`);

  if (opts.checks) {
    const slug = branch.replace(/[^\w.-]+/g, '_');
    for (const [label, args] of CHECKS) {
      const file = path.join(CHECK_LOGS, `${slug}-${label}.log`);
      console.log(`  ${branch}: ${label}...`);
      if (!npm(args, file)) return undo(`${label} failed after the merge; see ${file}`);
    }
  }
  log(
    `merged ${branch} ${short(sha)} -> ${BRANCH} ${short(git(['rev-parse', 'HEAD']))}${depsChanged ? ' (dependencies changed)' : ''}`,
  );
  opts.depsMerged ||= depsChanged;
  return 'merged';
}

function merge(args) {
  const opts = {
    checks: !args.includes('--no-checks'),
    allowDeps: args.includes('--allow-deps'),
    open: !args.includes('--no-open'),
    depsMerged: false,
    hasOriginMain: false,
  };
  if (!fs.existsSync(WT))
    throw new Error(`Integration worktree ${WT} does not exist; set CETERIS_DEV_WT.`);
  const current = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (current !== BRANCH)
    throw new Error(
      `${WT} is on ${current}, expected ${BRANCH}; set CETERIS_DEV_BRANCH or switch it back.`,
    );
  if (git(['status', '--porcelain', '--untracked-files=no'])) {
    throw new Error(
      `${WT} has uncommitted changes; commit or move them before merging, nothing was merged.`,
    );
  }
  if (!takeLock()) {
    console.log('Another merge is running; it picks up newly queued branches before it finishes.');
    return;
  }
  fs.mkdirSync(CHECK_LOGS, { recursive: true });
  let mergedAny = false;
  try {
    tryGit(['fetch', '-q', 'origin']);
    opts.hasOriginMain = tryGit(['rev-parse', '--verify', '-q', 'origin/main']).ok;
    // Loop until the queue is empty, so a branch queued during a long check run is not left behind.
    const done = new Set();
    for (;;) {
      const pending = readQueue().filter((e) => !done.has(`${e.branch} ${e.sha}`));
      if (!pending.length) break;
      for (const entry of pending) {
        if (mergeOne(entry, opts) === 'merged') mergedAny = true;
        done.add(`${entry.branch} ${entry.sha}`);
      }
      writeQueue(readQueue().filter((e) => !done.has(`${e.branch} ${e.sha}`)));
    }
  } finally {
    releaseLock();
  }
  if (mergedAny && opts.open) ensureDev({ restart: opts.depsMerged });
}

const [cmd, ...rest] = process.argv.slice(2);
try {
  if (cmd === 'add') add(rest);
  else if (cmd === 'list') list();
  else if (cmd === 'merge') merge(rest);
  else if (cmd === 'open') ensureDev();
  else if (cmd === 'restart') ensureDev({ restart: true });
  else {
    console.log(
      'Usage: node scripts/dev-queue.mjs add [branch] [--merge] | list | merge [--no-checks] [--allow-deps] [--no-open] | open | restart',
    );
    process.exit(cmd ? 1 : 0);
  }
} catch (err) {
  console.error(`[dev-queue] ${err.message}`);
  process.exit(1);
}
