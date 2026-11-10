/**
 * @file extensions/ceteris-tabs/server/ceteris-tabs-mcp.mjs
 * @purpose MCP server that lets Claude Code in a Ceteris coordinator tab control the other tabs
 *   of its folder: list, open, close, rename, type into, read, and wait for them (Ceteris
 *   ADR-024), and show a file it wrote beside a tab (ADR-033).
 *
 * @关键设计:
 * - No dependencies. It speaks MCP over stdio (one JSON-RPC message per line) by hand, and talks
 *   to Ceteris over the pipe named in CETERIS_CONTROL_PIPE with this tab's CETERIS_CONTROL_TOKEN.
 *   The wire format is src/shared/tab-control.ts in the Ceteris repository; keep the two equal.
 * - Ceteris decides who may do what, on every request. This server only forwards and formats.
 *   Outside Ceteris (no pipe in the env) it offers no tools at all, so other terminals pay no
 *   context for it.
 * - Waiting is done here by polling "get" once a second, so the pipe stays one short request
 *   per connection.
 * - Runs under Ceteris's own executable with ELECTRON_RUN_AS_NODE=1 (see ../.mcp.json), or any
 *   Node.js 18+.
 *
 * @不要在这里做的事:
 * - Do not write to stdout except MCP messages; logs go to stderr.
 */
/* global process, setTimeout, clearTimeout */
import { connect } from 'node:net';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

export const PROTOCOL_VERSION = 1;
export const SERVER_VERSION = '0.2.0';
const SUPPORTED_MCP_VERSIONS = ['2024-11-05', '2025-03-26', '2025-06-18'];
const AGENT_TEMPLATES = new Set(['claude-code', 'codex']);
const POLL_MS = 1000;
const REQUEST_TIMEOUT_MS = 20_000;

const INSTRUCTIONS = [
  'These tools control the other terminal tabs in this Ceteris folder.',
  'They work only while this tab is marked as coordinator in Ceteris; otherwise every call says so.',
  'Typical loop: list_tabs; open_tab with template "claude-code" and a prompt to start a worker;',
  'wait_for_tab until it is done or blocked; read_tab to see its answer; send_input to answer an',
  'approval prompt (keys) or give the next prompt (text); close_tab when it is finished.',
  'Tabs are named by the id from list_tabs (a unique prefix of 4+ characters works) or by exact name.',
  'To show the user a result, write it to a .md (or .txt, .json, .tex, .pdf, image) file and call',
  'open_file with its path: Ceteris displays it next to your tab.',
].join(' ');

export const KEY_NAMES = [
  'enter',
  'escape',
  'tab',
  'shift-tab',
  'backspace',
  'space',
  'up',
  'down',
  'right',
  'left',
  'ctrl-c',
  'ctrl-d',
  'ctrl-l',
];

const TAB = {
  type: 'string',
  description: 'Tab id from list_tabs, a unique id prefix, or exact tab name',
};

export const TOOLS = [
  {
    name: 'list_tabs',
    description:
      'List the tabs in this folder with id, name, template, state (active/idle/exited), agentPhase (working/blocked/done for Claude Code and Codex, null for shells), and which one is you.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'list_templates',
    description:
      'List the launch templates open_tab accepts (for example shell, claude-code, codex).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'open_tab',
    description:
      'Open a new tab in this folder. With a prompt, waits until the agent is ready, types the prompt and presses Enter. The tab opens in the background; the user clicks it to watch.',
    inputSchema: {
      type: 'object',
      properties: {
        template: { type: 'string', description: 'Template id or name; default "shell"' },
        name: { type: 'string', description: 'Tab name shown in Ceteris' },
        prompt: { type: 'string', description: 'First prompt or command to send once ready' },
        ready_timeout_seconds: {
          type: 'number',
          description:
            'How long to wait for the agent to be ready before sending the prompt; default 60',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'send_input',
    description:
      'Type into a tab: text first, then the named keys in order, then Enter if submit is true (default true when text is given). Use keys to answer prompts, for example ["escape"] to interrupt or ["down","enter"] to pick the second option.',
    inputSchema: {
      type: 'object',
      properties: {
        tab: TAB,
        text: { type: 'string' },
        keys: { type: 'array', items: { type: 'string', enum: KEY_NAMES } },
        submit: { type: 'boolean' },
      },
      required: ['tab'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_tab',
    description: "Read the last lines of a tab's screen as plain text, with its state.",
    inputSchema: {
      type: 'object',
      properties: {
        tab: TAB,
        lines: {
          type: 'number',
          description: 'How many rows from the end; default 80, at most 2000',
        },
      },
      required: ['tab'],
      additionalProperties: false,
    },
  },
  {
    name: 'wait_for_tab',
    description:
      'Wait until a tab needs attention: an agent is done or blocked on an approval, a shell has gone quiet, or the tab exited. Returns its state and the last screen lines.',
    inputSchema: {
      type: 'object',
      properties: {
        tab: TAB,
        timeout_seconds: { type: 'number', description: 'Default 300, at most 1800' },
        lines: { type: 'number', description: 'Screen rows to return; default 40' },
      },
      required: ['tab'],
      additionalProperties: false,
    },
  },
  {
    name: 'rename_tab',
    description: 'Rename a tab in this folder, including your own.',
    inputSchema: {
      type: 'object',
      properties: { tab: TAB, name: { type: 'string' } },
      required: ['tab', 'name'],
      additionalProperties: false,
    },
  },
  {
    name: 'close_tab',
    description: 'Close a tab in this folder and end its process. You cannot close your own tab.',
    inputSchema: {
      type: 'object',
      properties: { tab: TAB },
      required: ['tab'],
      additionalProperties: false,
    },
  },
  {
    name: 'open_file',
    description:
      'Show a file in the Ceteris viewer beside a tab (your own by default): Markdown rendered as a page, .txt/.json/.tex as text, PDFs and images as themselves. Write the file first, then call this with its path; a relative path counts from the current directory of the tab.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path, absolute or relative to the tab' },
        tab: { ...TAB, description: `${TAB.description}; default your own tab` },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
];

class ControlError extends Error {}

/**
 * Sends one request to Ceteris and returns its result, or throws ControlError with Ceteris's
 * message.
 *
 * @param env process.env, or a stand-in in tests
 */
export function callCeteris(env, op, args = {}) {
  const pipe = env.CETERIS_CONTROL_PIPE;
  const token = env.CETERIS_CONTROL_TOKEN;
  if (!pipe || !token) {
    return Promise.reject(
      new ControlError(
        'This Claude Code is not running in a Ceteris tab, so there are no tabs to control.',
      ),
    );
  }
  return new Promise((resolve, reject) => {
    const socket = connect(pipe);
    let buffered = '';
    let settled = false;
    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      fn(value);
    };
    const timer = setTimeout(
      () =>
        done(
          reject,
          new ControlError(`Ceteris did not answer "${op}" within ${REQUEST_TIMEOUT_MS / 1000} s.`),
        ),
      REQUEST_TIMEOUT_MS,
    );
    socket.setEncoding('utf8');
    socket.on('connect', () => {
      socket.write(`${JSON.stringify({ v: PROTOCOL_VERSION, token, op, args })}\n`);
    });
    socket.on('data', (chunk) => {
      buffered += chunk;
      const newline = buffered.indexOf('\n');
      if (newline < 0) return;
      let reply;
      try {
        reply = JSON.parse(buffered.slice(0, newline));
      } catch {
        done(
          reject,
          new ControlError('Ceteris sent a reply this plugin cannot read; update the plugin.'),
        );
        return;
      }
      if (reply.ok) done(resolve, reply.result);
      else done(reject, new ControlError(`${reply.message} (${reply.code})`));
    });
    socket.on('error', (err) =>
      done(
        reject,
        new ControlError(
          `Cannot reach Ceteris at ${pipe} (${err.code ?? err.message}). If Ceteris restarted, open Claude Code in a new tab.`,
        ),
      ),
    );
    socket.on('close', () =>
      done(reject, new ControlError('Ceteris closed the connection without answering.')),
    );
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function clamp(value, fallback, min, max) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
}

/** True when a tab is waiting for someone; see wait_for_tab. */
export function needsAttention(tab, quietPolls) {
  if (tab.state === 'exited') return true;
  if (tab.agentPhase === 'done' || tab.agentPhase === 'blocked') return true;
  // A shell has no phase; two quiet polls in a row count as finished.
  return tab.agentPhase === null && !AGENT_TEMPLATES.has(tab.templateId) && quietPolls >= 2;
}

/**
 * Polls a tab until it needs attention or the time runs out.
 *
 * @param settleMs right after send_input an agent still shows the "done" of its last turn for
 *   a moment (Ceteris reads the phase about 300 ms after output). A done seen before settleMs
 *   counts only once the tab has been seen busy.
 * @returns { tab, timedOut }
 */
export async function waitForTab(env, tabRef, timeoutMs, pollMs = POLL_MS, settleMs = 0) {
  const start = Date.now();
  const deadline = start + timeoutMs;
  let quietPolls = 0;
  let seenBusy = false;
  for (;;) {
    const tab = await callCeteris(env, 'get', { tab: tabRef });
    quietPolls = tab.state === 'idle' ? quietPolls + 1 : 0;
    const attention = needsAttention(tab, quietPolls);
    if (!attention) seenBusy = true;
    const settled = seenBusy || Date.now() - start >= settleMs || tab.state === 'exited';
    if (attention && settled) return { tab, timedOut: false };
    if (Date.now() + pollMs > deadline) return { tab, timedOut: true };
    await sleep(pollMs);
  }
}

function describeTab(tab) {
  const phase = tab.agentPhase ? ` ${tab.agentPhase}` : '';
  const flags = [tab.self ? 'you' : '', tab.coordinator ? 'coordinator' : '']
    .filter(Boolean)
    .join(', ');
  const exit =
    tab.state === 'exited' && tab.exitCode !== undefined ? ` (exit ${tab.exitCode})` : '';
  return `${tab.id}  "${tab.name}"  ${tab.templateId}  ${tab.state}${phase}${exit}${flags ? `  [${flags}]` : ''}`;
}

/** Runs one tool call. Returns MCP tool result content. */
export async function runTool(env, name, args = {}, options = {}) {
  const pollMs = options.pollMs ?? POLL_MS;
  switch (name) {
    case 'list_tabs': {
      const { folder, tabs } = await callCeteris(env, 'list');
      return `Folder: ${folder}\n${tabs.map(describeTab).join('\n')}`;
    }
    case 'list_templates': {
      const templates = await callCeteris(env, 'templates');
      return templates
        .map(
          (t) =>
            `${t.id}  "${t.name}"${t.command ? `  runs ${[t.command, ...t.args].join(' ')}` : '  plain shell'}`,
        )
        .join('\n');
    }
    case 'open_tab': {
      const tab = await callCeteris(env, 'create', {
        ...(args.template !== undefined ? { template: args.template } : {}),
        ...(args.name !== undefined ? { name: args.name } : {}),
      });
      if (!args.prompt) return `Opened ${describeTab(tab)}`;
      const timeoutMs = clamp(args.ready_timeout_seconds, 60, 1, 600) * 1000;
      const ready = await waitForTab(env, tab.id, timeoutMs, pollMs);
      if (ready.timedOut || ready.tab.state === 'exited' || ready.tab.agentPhase === 'blocked') {
        const screen = await callCeteris(env, 'read', { tab: tab.id, lines: 30 }).catch(() => null);
        return (
          `Opened ${describeTab(ready.tab)} but did not send the prompt: ` +
          `${ready.timedOut ? 'it was not ready in time' : `it is ${ready.tab.agentPhase ?? ready.tab.state}`}.\n` +
          (screen ? `Screen:\n${screen.screen}` : '')
        );
      }
      await callCeteris(env, 'input', { tab: tab.id, text: args.prompt, submit: true });
      return `Opened ${describeTab(ready.tab)} and sent the prompt.`;
    }
    case 'send_input': {
      const sent = await callCeteris(env, 'input', {
        tab: args.tab,
        ...(args.text !== undefined ? { text: args.text } : {}),
        ...(args.keys !== undefined ? { keys: args.keys } : {}),
        ...(args.submit !== undefined ? { submit: args.submit } : {}),
      });
      const parts = [];
      if (sent.typed) parts.push(`${sent.typed} characters`);
      if (sent.keys.length) parts.push(`keys ${sent.keys.join(', ')}`);
      if (sent.submitted) parts.push('Enter');
      return `Sent ${parts.join(', then ')} to ${sent.tab}.`;
    }
    case 'read_tab': {
      const { tab, screen } = await callCeteris(env, 'read', { tab: args.tab, lines: args.lines });
      return `${describeTab(tab)}\n----\n${screen}`;
    }
    case 'wait_for_tab': {
      const timeoutMs = clamp(args.timeout_seconds, 300, 1, 1800) * 1000;
      const { tab, timedOut } = await waitForTab(
        env,
        args.tab,
        timeoutMs,
        pollMs,
        options.settleMs ?? 2500,
      );
      const { screen } = await callCeteris(env, 'read', {
        tab: tab.id,
        lines: clamp(args.lines, 40, 1, 2000),
      });
      return `${timedOut ? 'Still busy after the timeout: ' : ''}${describeTab(tab)}\n----\n${screen}`;
    }
    case 'rename_tab': {
      const tab = await callCeteris(env, 'rename', { tab: args.tab, name: args.name });
      return `Renamed: ${describeTab(tab)}`;
    }
    case 'close_tab': {
      const { closed } = await callCeteris(env, 'close', { tab: args.tab });
      return `Closed ${closed}.`;
    }
    case 'open_file': {
      const { tab, path, kind } = await callCeteris(env, 'open-file', {
        path: args.path,
        ...(args.tab !== undefined ? { tab: args.tab } : {}),
      });
      return `Showing ${path} (${kind}) beside ${describeTab(tab)}`;
    }
    default:
      throw new ControlError(`Unknown tool ${name}`);
  }
}

/**
 * Answers one JSON-RPC message. Returns the reply object, or null for a notification.
 */
export async function handleMessage(env, message, options = {}) {
  const { id, method, params } = message;
  const isRequest = id !== undefined && id !== null;
  const reply = (result) => ({ jsonrpc: '2.0', id, result });
  const inCeteris = Boolean(env.CETERIS_CONTROL_PIPE && env.CETERIS_CONTROL_TOKEN);
  switch (method) {
    case 'initialize': {
      const asked = params?.protocolVersion;
      return reply({
        protocolVersion: SUPPORTED_MCP_VERSIONS.includes(asked)
          ? asked
          : SUPPORTED_MCP_VERSIONS.at(-1),
        capabilities: { tools: {} },
        serverInfo: { name: 'ceteris-tabs', version: SERVER_VERSION },
        instructions: inCeteris ? INSTRUCTIONS : 'Not in a Ceteris tab; no tools.',
      });
    }
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: inCeteris ? TOOLS : [] });
    case 'tools/call': {
      try {
        const text = await runTool(env, params?.name, params?.arguments ?? {}, options);
        return reply({ content: [{ type: 'text', text }] });
      } catch (err) {
        const text = err instanceof ControlError ? err.message : `Failed: ${err?.message ?? err}`;
        return reply({ content: [{ type: 'text', text }], isError: true });
      }
    }
    default:
      if (!isRequest) return null; // notifications/initialized and friends
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      };
  }
}

function main() {
  const rl = createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })}\n`,
      );
      return;
    }
    void handleMessage(process.env, message).then((reply) => {
      if (reply) process.stdout.write(`${JSON.stringify(reply)}\n`);
    });
  });
  rl.on('close', () => process.exit(0));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
