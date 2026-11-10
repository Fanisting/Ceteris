/**
 * @file extensions/ceteris-tabs/hooks/announce-session.mjs
 * @purpose SessionStart hook: tells Ceteris the id of this Claude Code session (ADR-036), so
 *   that a tab put in the shelf can come back with `claude --resume <id>`.
 *
 * @关键设计:
 * - Claude Code writes `{ session_id, cwd, source, ... }` to stdin. Only session_id is sent.
 * - Runs on every SessionStart (startup, resume, /clear, compact), so Ceteris always has the
 *   current id: after /clear the shelf resumes the new conversation, not the old one.
 * - Outside Ceteris (no pipe in the env) it exits at once. Any failure exits 0 and prints
 *   nothing: a hook must never slow down or interrupt Claude Code over a bookkeeping detail.
 * - No dependencies; the request format is src/shared/tab-control.ts, op `agent-session`.
 *
 * @不要在这里做的事:
 * - Do not write to stdout: SessionStart hook stdout is added to Claude's context.
 */
/* global process, setTimeout */
import { connect } from 'node:net';

const PROTOCOL_VERSION = 1;
const TIMEOUT_MS = 3000;

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
    setTimeout(() => resolve(data), TIMEOUT_MS).unref();
  });
}

function send(pipe, request) {
  return new Promise((resolve) => {
    const socket = connect(pipe);
    const done = () => {
      socket.destroy();
      resolve();
    };
    socket.setTimeout(TIMEOUT_MS, done);
    socket.on('error', done);
    socket.on('data', done);
    socket.on('close', () => resolve());
    socket.write(`${JSON.stringify(request)}\n`);
  });
}

async function main() {
  const pipe = process.env.CETERIS_CONTROL_PIPE;
  const token = process.env.CETERIS_CONTROL_TOKEN;
  if (!pipe || !token) return;
  let sessionId = '';
  try {
    const input = JSON.parse(await readStdin());
    sessionId = typeof input.session_id === 'string' ? input.session_id : '';
  } catch {
    return;
  }
  if (!sessionId) return;
  await send(pipe, {
    v: PROTOCOL_VERSION,
    token,
    op: 'agent-session',
    args: { agent: 'claude-code', sessionId },
  });
}

main()
  .catch(() => undefined)
  .finally(() => process.exit(0));
