/**
 * @file src/main/openrouter-connect.ts
 * @purpose "Connect OpenRouter": gets an API key through OpenRouter's OAuth PKCE sign in, so
 *   the user approves in the browser instead of copying a key into Ceteris.
 *
 * @关键设计:
 * Flow (https://openrouter.ai/docs/use-cases/oauth-pkce, read 2026-11-08):
 *   1. Listen on a random localhost port. OpenRouter accepts localhost callbacks on any port.
 *   2. Open https://openrouter.ai/auth?callback_url=...&code_challenge=...&state=... in the
 *      user's browser. The user signs in and approves a new key.
 *   3. OpenRouter redirects to http://localhost:<port>/callback?code=...&state=...
 *   4. POST the code with the PKCE verifier to /api/v1/auth/keys; the reply is { key }.
 * - PKCE means a stolen code is useless without the verifier, which never leaves this
 *   process. state ties the callback to this attempt, so another page cannot inject a code.
 * - The server listens on 127.0.0.1 and ::1 only, never on the network, and closes after
 *   one callback, a cancel, or five minutes.
 * - Only one attempt at a time: a new one cancels the old.
 *
 * @对应文档章节:docs/软件定义书.md ADR-021
 *
 * @不要在这里做的事:
 * - 不要保存 key,那是 SecretStore 的事;这里只负责拿到它
 * - 不要把 code、verifier 或 key 写进日志
 */
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { logger } from './logger';

const AUTH_URL = 'https://openrouter.ai/auth';
const EXCHANGE_URL = 'https://openrouter.ai/api/v1/auth/keys';
const TIMEOUT_MS = 5 * 60_000;
const KEY_LABEL = 'Ceteris next prompt';

export class ConnectCancelled extends Error {
  constructor() {
    super('已取消连接 OpenRouter');
    this.name = 'ConnectCancelled';
  }
}

function base64url(buffer: Buffer): string {
  return buffer.toString('base64url');
}

/** The verifier and its S256 challenge, as RFC 7636 defines them. */
export function makePkce(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

export function authorizeUrl(port: number, challenge: string, state: string): string {
  const url = new URL(AUTH_URL);
  url.searchParams.set('callback_url', `http://localhost:${port}/callback`);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('key_label', KEY_LABEL);
  url.searchParams.set('state', state);
  return url.toString();
}

/** The page the browser shows after the redirect. */
function page(ok: boolean): string {
  const [zh, en] = ok
    ? ['已连接 Ceteris,可以关闭这个页面。', 'Ceteris is connected. You can close this tab.']
    : ['没有连接成功,请回到 Ceteris 再试一次。', 'Not connected. Go back to Ceteris and try again.'];
  return (
    '<!doctype html><meta charset="utf-8"><title>Ceteris</title>' +
    '<body style="font:16px system-ui;margin:3em;color:#333">' +
    `<p>${zh}</p><p>${en}</p></body>`
  );
}

interface Pending {
  cancel: () => void;
}
let pending: Pending | null = null;

/** Stops a connect that is waiting for the browser. Does nothing when none is. */
export function cancelOpenRouterConnect(): void {
  pending?.cancel();
}

/**
 * Runs the whole sign in and returns the new key.
 *
 * @param openExternal opens a URL in the default browser (Electron shell.openExternal)
 * @throws ConnectCancelled the user cancelled, or started another connect
 * @throws Error the user denied access, five minutes passed, or the exchange failed
 */
export async function connectOpenRouter(
  openExternal: (url: string) => Promise<void>,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = TIMEOUT_MS,
): Promise<string> {
  cancelOpenRouterConnect();
  const { verifier, challenge } = makePkce();
  const state = base64url(randomBytes(16));

  const code = await new Promise<string>((resolve, reject) => {
    const servers: Server[] = [];
    let timer: NodeJS.Timeout | undefined;
    let done = false;
    const finish = (err: Error | null, value?: string): void => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      for (const s of servers) s.close();
      pending = null;
      if (err) reject(err);
      else resolve(value as string);
    };
    pending = { cancel: () => finish(new ConnectCancelled()) };

    const onRequest = (req: IncomingMessage, res: ServerResponse): void => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname !== '/callback') {
        res.writeHead(404).end();
        return;
      }
      const got = url.searchParams.get('code');
      // A callback with no code is a denial; one with another state is not ours.
      const ok = !!got && url.searchParams.get('state') === state;
      res.writeHead(ok ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8' }).end(page(ok));
      if (ok) finish(null, got);
      else if (!got) finish(new Error('OpenRouter 上没有同意授权,未连接'));
      else logger.warn('OpenRouterConnect', 'ignored a callback with the wrong state');
    };

    const first = createServer(onRequest);
    servers.push(first);
    first.once('error', (err) => finish(new Error(`无法在本机开启回调端口:${err.message}`)));
    first.listen(0, '127.0.0.1', () => {
      const { port } = first.address() as AddressInfo;
      // Browsers may try ::1 first for "localhost". Same port; skipped where IPv6 is off.
      const v6 = createServer(onRequest);
      v6.once('error', () => undefined);
      v6.listen(port, '::1');
      servers.push(v6);

      timer = setTimeout(
        () => finish(new Error('5 分钟内没有在浏览器里完成授权,请再试一次')),
        timeoutMs,
      );
      logger.info('OpenRouterConnect', `waiting for the browser on port ${port}`);
      openExternal(authorizeUrl(port, challenge, state)).catch((err: unknown) =>
        finish(new Error(`无法打开浏览器:${err instanceof Error ? err.message : String(err)}`)),
      );
    });
  });

  const res = await fetchImpl(EXCHANGE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: 'S256' }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 200);
    throw new Error(
      `OpenRouter 换取 key 失败(${res.status}):${detail}。` +
        '可能是授权超过 10 分钟已过期,或网络被代理拦截;请重新连接',
    );
  }
  const body = (await res.json()) as { key?: unknown };
  if (typeof body.key !== 'string' || !body.key) {
    throw new Error('OpenRouter 的回复里没有 key,请重新连接;若反复出现,看日志并反馈');
  }
  logger.info('OpenRouterConnect', 'connected');
  return body.key;
}
