#!/usr/bin/env node
/**
 * @file scripts/smoke-mac.mjs
 * @purpose Proves a packaged Mac build really runs: it starts, shows the Mac window, opens a
 *   terminal, runs a command and follows cd. CI runs this because nobody can do so by hand.
 *
 * Usage: node --experimental-websocket scripts/smoke-mac.mjs <path to Ceteris.app>
 * Exits non-zero when a check fails, which fails the workflow.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const bundle = process.argv[2];
if (!bundle) throw new Error('Pass the path to Ceteris.app');
const PORT = 9471;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ceteris-smoke-'));
const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ceteris-smoke-work-')));
const results = [];
const check = (name, ok, detail = '') => {
  results.push(Boolean(ok));
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  (${detail})`}`);
};

const exe = path.join(bundle, 'Contents', 'MacOS', 'Ceteris');
const app = spawn(exe, [`--user-data-dir=${data}`, `--remote-debugging-port=${PORT}`], {
  stdio: ['ignore', 'pipe', 'pipe'],
});
let appOutput = '';
app.stdout.on('data', (chunk) => { appOutput += chunk; });
app.stderr.on('data', (chunk) => { appOutput += chunk; });

let ws;
let nextId = 1;
const waiting = new Map();
const cdp = (method, params = {}) =>
  new Promise((resolve) => {
    const id = nextId++;
    waiting.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
const ev = async (expression) =>
  (await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result
    ?.result?.value;
const until = async (fn, ms = 15000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await sleep(300);
  }
  return null;
};

async function connect() {
  for (let i = 0; i < 80 && !ws; i += 1) {
    await sleep(500);
    try {
      const pages = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      const page = pages.find((t) => t.type === 'page' && !t.url.startsWith('devtools'));
      if (page) {
        ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => {
          ws.onopen = resolve;
          ws.onerror = reject;
        });
        ws.onmessage = (e) => {
          const message = JSON.parse(e.data);
          if (message.id) waiting.get(message.id)?.(message);
        };
      }
    } catch {
      ws = undefined;
    }
  }
}

try {
  await connect();
  check('the app starts and opens a window', ws);
  if (!ws) throw new Error('no window');
  check('the page loads', await until(() => ev(`!!document.querySelector('.sidebar')`)));
  check('it knows it is on a Mac', (await ev(`document.documentElement.dataset.platform`)) === 'darwin');
  check('it uses the Mac window style', await ev(`!!document.querySelector('.app-titlebar-macos')`));

  const J = JSON.stringify;
  const sessionId = await ev(
    `window.api.invoke('cmd:session:create',{pathId:${J(work)},templateId:'shell',shellId:'zsh',cols:100,rows:30}).then(r=>r.session.id).catch(e=>'ERROR '+e.message)`,
  );
  check('a terminal opens', sessionId && !sessionId.startsWith('ERROR'), sessionId ?? '');
  await sleep(3000);

  const screen = () =>
    ev(`window.api.invoke('cmd:session:get-scrollback',{sessionId:${J(sessionId)}}).then(r=>{
      const value = r.data || Object.values(r).find((x) => typeof x === 'string' && x.length > 20) || '';
      return new TextDecoder().decode(Uint8Array.from(atob(value), (c) => c.charCodeAt(0)));
    })`);
  const send = (text) =>
    ev(`window.api.invoke('cmd:session:send-input',{sessionId:${J(sessionId)},data:btoa(${J(text)})}).then(()=>1)`);

  await send('echo CETERIS_$((40+2))\n');
  check('a command runs', await until(async () => (await screen())?.includes('CETERIS_42')));

  await send('cd /usr/bin\n');
  const cwd = () =>
    ev(`window.api.invoke('cmd:app:get-snapshot').then(s=>s.sessions.find(x=>x.id===${J(sessionId)})?.currentCwd)`);
  check('the tab follows cd', await until(async () => (await cwd()) === '/usr/bin'), await cwd());

  const shot = await cdp('Page.captureScreenshot', { format: 'png' });
  if (shot.result?.data) {
    fs.writeFileSync(path.join(os.tmpdir(), 'ceteris-smoke.png'), Buffer.from(shot.result.data, 'base64'));
  }
} catch (err) {
  check('the run finished', false, err.message);
}

app.kill();
await sleep(1000);
if (!results.every(Boolean)) console.log(`--- app output ---\n${appOutput.slice(-3000)}`);
console.log(`${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
