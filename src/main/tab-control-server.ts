/**
 * @file src/main/tab-control-server.ts
 * @purpose The pipe the ceteris-tabs Claude Code plugin talks to (ADR-024). Claude Code in a
 *   coordinator tab can list, open, close, rename, type into and read the other tabs of the
 *   folder it runs in, and show a file beside a tab (ADR-033). Any other tab is refused.
 *
 * @关键设计:
 * - The rule is checked on every request, against the session as it is now: the calling tab
 *   exists, has not exited, is marked coordinator, and the extension is on in Settings. So
 *   unmarking a tab, or turning the extension off, cuts it off at once.
 * - Scope is the caller's folder (its pathId). Tabs in other folders are not listed and cannot
 *   be named. A coordinator cannot close or type into itself, which would only loop.
 * - Tokens are random per tab and only map to a session id. They are issued at spawn and
 *   dropped when the session is destroyed. A token that leaks into a child process of a
 *   coordinator gives that process the coordinator's rights, which is the same trust as the
 *   tab itself.
 * - New tabs open with no owner window, so a window showing the coordinator keeps showing it;
 *   the user clicks the new tab to watch it. They take the coordinator's size until then.
 * - Typing: text first, then the named keys, then Enter after a short pause. Claude Code reads
 *   text and Enter that arrive in one chunk as a paste and inserts a newline instead of sending.
 *   Text with line breaks goes in as a bracketed paste when the tab has asked for that mode.
 * - Pipe name has the pid and a random part, like askpass-server.ts, so stable and beta never
 *   share a pipe and other users cannot guess it.
 * - Showing a file (ADR-033) only asks the windows to open it in the viewer next to a tab, the
 *   same viewer a click in the file tree opens. Main checks the type and that the file exists;
 *   the window reads the content itself. A relative path counts from the tab's current
 *   directory, because that is where the agent just wrote the file.
 * - open-file is open to every live tab, coordinator or not, extension on or off: the user
 *   asks their own Claude Code to "show the answer in Ceteris", and that tab must be able to
 *   do it without any setup. It shows nothing the user could not click in the file tree, and
 *   it only touches the tab that asks (or another tab of the same folder).
 *
 * @对应文档章节:软件定义书.md ADR-024、ADR-033;docs/ipc-protocol.md 附录 D
 *
 * @不要在这里做的事:
 * - Do not mark or unmark coordinators here; only the user does that, from the tab menu.
 * - Do not create sessions in SSH folders: their login needs the profile handling in ipc.ts.
 *
 * @常见问题排查:
 * - Plugin says "not a coordinator" → right-click the tab and mark it coordinator.
 * - Plugin says "unknown token" → the tab was opened by another Ceteris (stable vs beta), or
 *   before this Ceteris started. Open a new tab.
 * - main.log lines start with [TabControl].
 */
import { randomBytes } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { fileViewKind } from '@shared/file-tree';
import {
  TAB_CONTROL_ENV,
  TAB_CONTROL_KEYS,
  TAB_CONTROL_MAX_INPUT_CHARS,
  TAB_CONTROL_MAX_READ_LINES,
  TAB_CONTROL_MAX_REQUEST_BYTES,
  TAB_CONTROL_VERSION,
  decodeTabControlRequest,
  encodeTabControlReply,
  type TabControlErrorCode,
  type TabControlOpenFileResult,
  type TabControlReply,
  type TabControlRequest,
  type TabSummary,
} from '@shared/tab-control';
import type { SessionInfo, Template } from '@shared/types';
import { logger } from './logger';

/** Pause between typed text and the Enter that sends it. See the file header. */
export const SUBMIT_DELAY_MS = 150;
/** Pause between named keys, so a TUI handles each as its own key press. */
export const KEY_DELAY_MS = 40;
/** Screen rows a read returns when the request does not say. */
const DEFAULT_READ_LINES = 80;
/** A connection with no complete request after this long is dropped. */
const CONNECTION_DEADLINE_MS = 30_000;

/** What the server needs from the rest of main. SessionManager and friends, or a fake. */
export interface TabControlHost {
  /** settings.extensions.tabControl */
  enabled(): boolean;
  list(): SessionInfo[];
  get(sessionId: string): SessionInfo | null;
  templates(): Template[];
  /** Opens a tab in a local folder with no owner window. */
  create(input: {
    pathId: string;
    templateId: string;
    cols: number;
    rows: number;
  }): Promise<SessionInfo>;
  close(sessionId: string): void;
  rename(sessionId: string, name: string): void;
  /** Writes to the PTY. Returns false when the session is gone or exited. */
  write(sessionId: string, text: string): boolean;
  /** The last rows of the rendered screen, oldest first. */
  screenTail(sessionId: string, rows: number): string;
  /** True when the program in the tab turned on bracketed paste (ESC [ ? 2004 h). */
  bracketedPaste(sessionId: string): boolean;
  /** True when an absolute path is an existing regular file. */
  isFile(path: string): Promise<boolean>;
  /** Asks every window to show the file in the viewer beside the tab (ADR-033). */
  showFile(input: { sessionId: string; name: string; path: string }): void;
}

class RequestError extends Error {
  constructor(
    readonly code: TabControlErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const sleep = (ms: number): Promise<void> =>
  ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();

export function summarize(session: SessionInfo, selfId: string): TabSummary {
  return {
    id: session.id,
    name: session.displayName,
    templateId: session.templateId,
    state: session.state,
    agentPhase: session.agentPhase ?? null,
    coordinator: session.coordinator === true,
    self: session.id === selfId,
    cwd: session.currentCwd,
    ...(session.exitCode !== undefined ? { exitCode: session.exitCode } : {}),
  };
}

/**
 * Answers requests. Pure apart from the host, so tests drive it without a pipe.
 */
export class TabControlService {
  private readonly tokens = new Map<string, string>();

  constructor(
    private readonly host: TabControlHost,
    private readonly delays: { submitMs: number; keyMs: number } = {
      submitMs: SUBMIT_DELAY_MS,
      keyMs: KEY_DELAY_MS,
    },
  ) {}

  /** A new token for a tab about to spawn. */
  issue(sessionId: string): string {
    const token = randomBytes(16).toString('hex');
    this.tokens.set(token, sessionId);
    return token;
  }

  /** Drops the tokens of a destroyed tab. */
  revoke(sessionId: string): void {
    for (const [token, id] of this.tokens) {
      if (id === sessionId) this.tokens.delete(token);
    }
  }

  async handle(request: TabControlRequest): Promise<TabControlReply> {
    try {
      const caller = this.authorize(request);
      const result = await this.run(caller, request);
      return { ok: true, result };
    } catch (err) {
      if (err instanceof RequestError) {
        logger.info('TabControl', `${request.op} refused: ${err.code} ${err.message}`);
        return { ok: false, code: err.code, message: err.message };
      }
      logger.error('TabControl', `${request.op} failed`, err);
      return {
        ok: false,
        code: 'failed',
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * The calling tab, if it may use the pipe right now. Controlling tabs needs the extension on
   * and a coordinator tab; open-file (ADR-033) needs only a live tab, see the file header.
   */
  private authorize(request: TabControlRequest): SessionInfo {
    if (request.v !== TAB_CONTROL_VERSION) {
      throw new RequestError(
        'bad-request',
        `protocol version ${request.v} is not ${TAB_CONTROL_VERSION}; update the ceteris-tabs plugin to match this Ceteris`,
      );
    }
    const anyTab = request.op === 'open-file';
    if (!anyTab && !this.host.enabled()) {
      throw new RequestError(
        'disabled',
        'Tab control is off. Turn it on in Ceteris Settings, Extensions, Coordinator tab control.',
      );
    }
    const callerId = this.tokens.get(request.token);
    const caller = callerId ? this.host.get(callerId) : null;
    if (!caller) {
      throw new RequestError(
        'unknown-token',
        'This tab is not known to the running Ceteris. Open Claude Code in a new Ceteris tab.',
      );
    }
    if (caller.state === 'exited') {
      throw new RequestError('not-coordinator', 'This tab has exited.');
    }
    if (!anyTab && caller.coordinator !== true) {
      throw new RequestError(
        'not-coordinator',
        'Only coordinator tabs may control tabs. Right-click this tab in Ceteris and tick Coordinator.',
      );
    }
    return caller;
  }

  private async run(caller: SessionInfo, request: TabControlRequest): Promise<unknown> {
    const args = request.args;
    switch (request.op) {
      case 'list':
        return {
          folder: caller.pathId,
          tabs: this.folderTabs(caller).map((s) => summarize(s, caller.id)),
        };
      case 'get':
        return summarize(this.target(caller, args.tab, { allowSelf: true }), caller.id);
      case 'templates':
        return this.host
          .templates()
          .map((t) => ({ id: t.id, name: t.name, command: t.command, args: t.args }));
      case 'create':
        return this.create(caller, args);
      case 'close': {
        const target = this.target(caller, args.tab);
        this.host.close(target.id);
        logger.info('TabControl', `close sid=${target.id} by coordinator ${caller.id}`);
        return { closed: target.id };
      }
      case 'rename': {
        const target = this.target(caller, args.tab, { allowSelf: true });
        const name = typeof args.name === 'string' ? args.name.trim() : '';
        if (!name) throw new RequestError('bad-request', 'name must be a non-empty string');
        this.host.rename(target.id, name.slice(0, 200));
        return summarize(this.host.get(target.id) ?? target, caller.id);
      }
      case 'input':
        return this.input(caller, args);
      case 'open-file':
        return this.openFile(caller, args);
      case 'read': {
        const target = this.target(caller, args.tab, { allowSelf: true });
        const lines = clampInt(args.lines, DEFAULT_READ_LINES, 1, TAB_CONTROL_MAX_READ_LINES);
        return {
          tab: summarize(target, caller.id),
          screen: this.host.screenTail(target.id, lines),
        };
      }
    }
  }

  /** Tabs in the caller's folder, in creation order. */
  private folderTabs(caller: SessionInfo): SessionInfo[] {
    return this.host
      .list()
      .filter((s) => s.pathId === caller.pathId)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  /**
   * Resolves a tab named by id, by a unique id prefix of 4 or more characters, or by its exact
   * name if only one tab has it. Only tabs in the caller's folder count.
   */
  private target(
    caller: SessionInfo,
    ref: unknown,
    options: { allowSelf?: boolean } = {},
  ): SessionInfo {
    if (typeof ref !== 'string' || !ref.trim()) {
      throw new RequestError('bad-request', 'tab must be a tab id or name from list_tabs');
    }
    const key = ref.trim();
    const tabs = this.folderTabs(caller);
    let matches = tabs.filter((s) => s.id === key);
    if (matches.length === 0 && key.length >= 4) {
      matches = tabs.filter((s) => s.id.startsWith(key));
    }
    if (matches.length === 0) matches = tabs.filter((s) => s.displayName === key);
    if (matches.length === 0) {
      throw new RequestError(
        'not-found',
        `No tab "${key}" in this folder. Call list_tabs for the current ids.`,
      );
    }
    if (matches.length > 1) {
      throw new RequestError(
        'ambiguous',
        `"${key}" matches ${matches.length} tabs; use the full id from list_tabs.`,
      );
    }
    const target = matches[0]!;
    if (target.id === caller.id && !options.allowSelf) {
      throw new RequestError('self', 'A coordinator cannot close or type into its own tab.');
    }
    return target;
  }

  private async create(caller: SessionInfo, args: Record<string, unknown>): Promise<TabSummary> {
    if (caller.pathId.startsWith('ssh:')) {
      throw new RequestError(
        'bad-request',
        'Opening tabs in an SSH folder is not supported; open them from the Ceteris window.',
      );
    }
    const templates = this.host.templates();
    const ref = typeof args.template === 'string' ? args.template.trim() : 'shell';
    const lower = ref.toLowerCase();
    const template =
      templates.find((t) => t.id === ref) ?? templates.find((t) => t.name.toLowerCase() === lower);
    if (!template) {
      throw new RequestError(
        'not-found',
        `No template "${ref}". Known: ${templates.map((t) => `${t.id} (${t.name})`).join(', ')}.`,
      );
    }
    const session = await this.host.create({
      pathId: caller.pathId,
      templateId: template.id,
      cols: caller.cols,
      rows: caller.rows,
    });
    logger.info(
      'TabControl',
      `create sid=${session.id} template=${template.id} in ${caller.pathId} by coordinator ${caller.id}`,
    );
    const name = typeof args.name === 'string' ? args.name.trim() : '';
    if (name) this.host.rename(session.id, name.slice(0, 200));
    return summarize(this.host.get(session.id) ?? session, caller.id);
  }

  /**
   * Shows a local file in the viewer beside a tab of the folder; the caller's own tab when
   * `tab` is not given. Only the kinds the viewer knows (fileViewKind) are accepted, so an
   * agent asking for a .ts file gets a clear refusal instead of a blank pane. Any live tab may
   * call this (see authorize); naming another tab still needs it to be in the same folder.
   */
  private async openFile(
    caller: SessionInfo,
    args: Record<string, unknown>,
  ): Promise<TabControlOpenFileResult> {
    if (caller.pathId.startsWith('ssh:')) {
      throw new RequestError(
        'bad-request',
        'Showing files in an SSH folder is not supported; open them from the file tree.',
      );
    }
    const target =
      args.tab === undefined ? caller : this.target(caller, args.tab, { allowSelf: true });
    const raw = typeof args.path === 'string' ? args.path.trim() : '';
    if (!raw) throw new RequestError('bad-request', 'path must be a non-empty string');
    const path = isAbsolute(raw) ? resolve(raw) : resolve(target.currentCwd, raw);
    const name = basename(path);
    const kind = fileViewKind(name);
    if (!kind) {
      throw new RequestError(
        'bad-request',
        `Ceteris cannot show "${name}". It shows .md, .txt, .json, .tex, .sql, .hive, .pdf and images.`,
      );
    }
    if (!(await this.host.isFile(path))) {
      throw new RequestError('not-found', `No file at ${path}. Write it first, then open it.`);
    }
    this.host.showFile({ sessionId: target.id, name, path });
    logger.info('TabControl', `open-file sid=${target.id} path=${path} by tab ${caller.id}`);
    return { tab: summarize(target, caller.id), path, name, kind };
  }

  private async input(
    caller: SessionInfo,
    args: Record<string, unknown>,
  ): Promise<{ tab: string; typed: number; keys: string[]; submitted: boolean }> {
    const target = this.target(caller, args.tab);
    if (target.state === 'exited') {
      throw new RequestError('failed', `Tab ${target.id} has exited; it takes no input.`);
    }
    const text = args.text === undefined ? '' : args.text;
    if (typeof text !== 'string') throw new RequestError('bad-request', 'text must be a string');
    if (text.length > TAB_CONTROL_MAX_INPUT_CHARS) {
      throw new RequestError(
        'bad-request',
        `text is ${text.length} characters; the limit is ${TAB_CONTROL_MAX_INPUT_CHARS}`,
      );
    }
    const keys = args.keys === undefined ? [] : args.keys;
    if (
      !Array.isArray(keys) ||
      keys.some((k) => typeof k !== 'string' || !(k in TAB_CONTROL_KEYS))
    ) {
      throw new RequestError(
        'bad-request',
        `keys must be a list of: ${Object.keys(TAB_CONTROL_KEYS).join(', ')}`,
      );
    }
    const submit = args.submit === undefined ? text.length > 0 : args.submit === true;
    if (!text && keys.length === 0 && !submit) {
      throw new RequestError('bad-request', 'Nothing to send: give text, keys or submit.');
    }

    const write = (data: string): void => {
      if (!this.host.write(target.id, data)) {
        throw new RequestError('failed', `Tab ${target.id} closed while typing.`);
      }
    };
    if (text) {
      const multiline = /[\r\n]/.test(text);
      write(multiline && this.host.bracketedPaste(target.id) ? `\x1b[200~${text}\x1b[201~` : text);
    }
    for (const [i, key] of (keys as string[]).entries()) {
      if (text || i > 0) await sleep(this.delays.keyMs);
      write(TAB_CONTROL_KEYS[key]!);
    }
    if (submit) {
      if (text || keys.length > 0) await sleep(this.delays.submitMs);
      write('\r');
    }
    logger.info(
      'TabControl',
      `input sid=${target.id} chars=${text.length} keys=${keys.length} submit=${submit} by coordinator ${caller.id}`,
    );
    return { tab: target.id, typed: text.length, keys: keys as string[], submitted: submit };
  }
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

/**
 * The pipe. One request per connection; see the file header.
 */
export class TabControlServer {
  readonly service: TabControlService;
  private server: Server | null = null;
  private readonly sockets = new Set<Socket>();
  private path: string | null = null;

  constructor(
    host: TabControlHost,
    private readonly nodePath: string,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {
    this.service = new TabControlService(host);
  }

  get pipePath(): string | null {
    return this.path;
  }

  /** Starts listening. Calling it again returns the same path. */
  async start(): Promise<string> {
    if (this.path) return this.path;
    const id = `${process.pid}-${randomBytes(8).toString('hex')}`;
    const path =
      this.platform === 'win32'
        ? `\\\\.\\pipe\\ceteris-control-${id}`
        : join(tmpdir(), `ceteris-control-${id}.sock`);
    const server = createServer((socket) => this.serve(socket));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(path, () => {
        server.off('error', reject);
        resolve();
      });
    });
    server.on('error', (err) => logger.error('TabControl', 'server error', err));
    this.server = server;
    this.path = path;
    logger.info('TabControl', `listening on ${path}`);
    return path;
  }

  /**
   * The env a new tab gets. Empty before the pipe listens: such a tab simply cannot be
   * controlled, and the plugin says Ceteris did not hand it a pipe.
   */
  envFor(sessionId: string): Record<string, string> {
    if (!this.path) return {};
    return {
      [TAB_CONTROL_ENV.pipe]: this.path,
      [TAB_CONTROL_ENV.token]: this.service.issue(sessionId),
      [TAB_CONTROL_ENV.node]: this.nodePath,
    };
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.path = null;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private serve(socket: Socket): void {
    this.sockets.add(socket);
    socket.setEncoding('utf8');
    let buffered = '';
    let handled = false;
    const deadline = setTimeout(() => socket.destroy(), CONNECTION_DEADLINE_MS);
    deadline.unref?.();
    const finish = (reply: TabControlReply): void => {
      if (!socket.destroyed) socket.end(encodeTabControlReply(reply));
    };
    socket.on('data', (chunk: string) => {
      if (handled) return;
      buffered += chunk;
      if (buffered.length > TAB_CONTROL_MAX_REQUEST_BYTES) {
        handled = true;
        finish({ ok: false, code: 'bad-request', message: 'request too large' });
        return;
      }
      const newline = buffered.indexOf('\n');
      if (newline < 0) return;
      handled = true;
      clearTimeout(deadline);
      const request = decodeTabControlRequest(buffered.slice(0, newline));
      if (!request) {
        finish({ ok: false, code: 'bad-request', message: 'malformed request' });
        return;
      }
      void this.service.handle(request).then(finish);
    });
    socket.on('error', (err) => logger.warn('TabControl', 'client socket error', err));
    socket.on('close', () => {
      clearTimeout(deadline);
      this.sockets.delete(socket);
    });
  }
}
