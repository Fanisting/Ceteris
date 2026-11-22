/**
 * @file extensions/ceteris-tabs/hooks/open-written.mjs
 * @purpose PostToolUse hook (ADR-058): a file Claude Code writes or edits, and a PDF one of its
 *   commands builds, opens in the Ceteris viewer beside the tab on its own, without the user
 *   asking for it and without the agent calling open_file.
 *
 * @关键设计:
 * - Write, Edit and MultiEdit name the file in tool_input.file_path: that file is shown.
 * - A Bash command names no output file Claude Code can see, so PDFs are found by rule: only a
 *   command that runs a document builder (latexmk, pdflatex, typst, pandoc, quarto, ...) counts.
 *   The candidates are the .pdf files it names, the PDF next to each source it names
 *   (paper.tex -> paper.pdf, also in -outdir / --output-directory), or, when it names none (a
 *   bare `latexmk`), every PDF in the tab's folder. The newest one changed in the last
 *   BUILD_WINDOW_MS (the Bash tool's longest timeout) opens. A failed build therefore shows the
 *   previous PDF, which is still the document being worked on.
 * - Agent bookkeeping is never shown: files under ~/.claude, ~/.codex and the temp folder
 *   (memory, plans, scratch files), and anything inside a .git or .omc folder.
 * - Ceteris decides what the viewer can show (fileViewKind) and refuses the rest; this hook
 *   ignores every reply. Showing the same file again is harmless: the viewer reloads it.
 * - hooks.json runs this with "async": true, so Claude Code never waits for it. Outside Ceteris
 *   (no pipe in the env) it exits at once; any failure exits 0 and prints nothing.
 * - No dependencies; the request is op `open-file` of src/shared/tab-control.ts.
 *
 * @对应文档章节: 软件定义书.md ADR-058, ADR-033; ipc-protocol.md appendix D
 *
 * @不要在这里做的事:
 * - Do not write to stdout: hook output can reach Claude's context.
 * - Do not open more than one file per tool call: the viewer shows one file per tab.
 */
/* global process, setTimeout */
import { readdirSync, statSync } from 'node:fs';
import { connect } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const PROTOCOL_VERSION = 1;
const TIMEOUT_MS = 3000;
/** The Bash tool's longest timeout: a build that started inside it finished inside it. */
export const BUILD_WINDOW_MS = 10 * 60 * 1000;

const BUILDER =
  /(^|[\s;&|("'`])(latexmk|pdflatex|xelatex|lualatex|tectonic|typst|pandoc|quarto|marp|weasyprint|wkhtmltopdf)(\.exe)?(?=$|[\s;&|)"'`])|rmarkdown::render|bookdown::render_book/i;
const SOURCE_EXTENSIONS = new Set(['.tex', '.typ', '.md', '.markdown', '.qmd', '.rmd', '.html']);
const PATH_TOKEN = /[^\s'"`=(),;|&<>]+\.(?:pdf|tex|typ|md|markdown|qmd|rmd|html)(?![\w.])/gi;
const LEADING_CD = /^\s*cd\s+("([^"]+)"|'([^']+)'|([^\s;&]+))\s*(?:&&|;)/;
const OUT_DIR =
  /(?:^|\s)-{1,2}(?:outdir|output-directory|output-dir|aux-directory)[=\s]+("([^"]+)"|'([^']+)'|(\S+))/gi;

function normal(path) {
  return resolve(path).replace(/\\/g, '/').toLowerCase();
}

/**
 * Whether a path is agent bookkeeping that should never pop up beside the tab.
 *
 * @param home the user's home folder; @param temp the OS temp folder
 */
export function isAgentBookkeeping(path, home, temp) {
  const p = normal(path);
  const under = (root) => {
    const r = normal(root).replace(/\/+$/, '');
    return p === r || p.startsWith(`${r}/`);
  };
  if (under(join(home, '.claude')) || under(join(home, '.codex')) || under(temp)) return true;
  return /\/\.(git|omc)\//.test(p);
}

function strip(token) {
  return token.replace(/^\.\//, '');
}

/**
 * The PDF a build command made, or null. Pure apart from the injected fs calls.
 *
 * @param command the Bash command line
 * @param cwd the folder it ran in
 * @param now Date.now() at the time of the check
 * @param fs { mtime(path) -> ms or null, list(dir) -> file names }
 */
export function builtPdf(command, cwd, now, fs) {
  if (typeof command !== 'string' || !BUILDER.test(command)) return null;
  // `cd paper && latexmk main.tex` is how agents build in a subfolder.
  const cd = LEADING_CD.exec(command);
  const base = cd ? resolve(cwd, cd[2] ?? cd[3] ?? cd[4]) : cwd;
  const at = (p) => (isAbsolute(p) ? resolve(p) : resolve(base, p));
  const outDirs = [...command.matchAll(OUT_DIR)].map((m) => at(m[2] ?? m[3] ?? m[4]));
  const candidates = new Set();
  for (const raw of command.match(PATH_TOKEN) ?? []) {
    const token = at(strip(raw));
    const ext = extname(token).toLowerCase();
    if (ext === '.pdf') {
      candidates.add(token);
    } else if (SOURCE_EXTENSIONS.has(ext)) {
      const pdf = `${basename(token, extname(token))}.pdf`;
      candidates.add(join(dirname(token), pdf));
      for (const dir of outDirs) candidates.add(join(dir, pdf));
    }
  }
  if (candidates.size === 0) {
    for (const dir of [at('.'), ...outDirs]) {
      for (const name of fs.list(dir)) {
        if (name.toLowerCase().endsWith('.pdf')) candidates.add(join(dir, name));
      }
    }
  }
  let best = null;
  let bestTime = now - BUILD_WINDOW_MS;
  for (const path of candidates) {
    const time = fs.mtime(path);
    if (time !== null && time >= bestTime) {
      best = path;
      bestTime = time;
    }
  }
  return best;
}

/**
 * The file to show for one PostToolUse event, or null.
 *
 * @param input the hook's stdin JSON: { tool_name, tool_input, cwd }
 * @param env { now, home, temp, fs } (see builtPdf for fs)
 */
export function fileToOpen(input, env) {
  const tool = input?.tool_name;
  const args = input?.tool_input ?? {};
  const cwd = typeof input?.cwd === 'string' && input.cwd ? input.cwd : process.cwd();
  let path = null;
  if (tool === 'Write' || tool === 'Edit' || tool === 'MultiEdit') {
    path =
      typeof args.file_path === 'string' && args.file_path ? resolve(cwd, args.file_path) : null;
  } else if (tool === 'Bash') {
    path = builtPdf(args.command, cwd, env.now, env.fs);
  }
  if (!path || isAgentBookkeeping(path, env.home, env.temp)) return null;
  return path;
}

const realFs = {
  mtime(path) {
    try {
      const s = statSync(path);
      return s.isFile() ? s.mtimeMs : null;
    } catch {
      return null;
    }
  },
  list(dir) {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  },
};

function readStdin() {
  return new Promise((done) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => done(data));
    process.stdin.on('error', () => done(data));
    setTimeout(() => done(data), TIMEOUT_MS).unref();
  });
}

function send(pipe, request) {
  return new Promise((done) => {
    const socket = connect(pipe);
    const finish = () => {
      socket.destroy();
      done();
    };
    socket.setTimeout(TIMEOUT_MS, finish);
    socket.on('error', finish);
    socket.on('data', finish);
    socket.on('close', () => done());
    socket.write(`${JSON.stringify(request)}\n`);
  });
}

async function main() {
  const pipe = process.env.CETERIS_CONTROL_PIPE;
  const token = process.env.CETERIS_CONTROL_TOKEN;
  if (!pipe || !token) return;
  let input;
  try {
    input = JSON.parse(await readStdin());
  } catch {
    return;
  }
  const path = fileToOpen(input, {
    now: Date.now(),
    home: homedir(),
    temp: tmpdir(),
    fs: realFs,
  });
  if (!path) return;
  await send(pipe, { v: PROTOCOL_VERSION, token, op: 'open-file', args: { path } });
}

// Run only as the hook, not when a test imports the functions above.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .catch(() => undefined)
    .finally(() => process.exit(0));
}
