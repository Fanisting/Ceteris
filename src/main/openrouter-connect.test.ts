import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

vi.mock('./logger', () => ({ logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

import { cancelOpenRouterConnect, ConnectCancelled, connectOpenRouter } from './openrouter-connect';

/** Plays the browser: reads the auth URL, then hits the callback the way OpenRouter would. */
function browser(visit: (callback: string, state: string, auth: URL) => Promise<void>) {
  return async (raw: string): Promise<void> => {
    const auth = new URL(raw);
    const callback = auth.searchParams.get('callback_url') ?? '';
    setTimeout(() => void visit(callback, auth.searchParams.get('state') ?? '', auth), 0);
  };
}

describe('connectOpenRouter', () => {
  it('ignores a callback with the wrong state, then exchanges the real code with a matching PKCE verifier', async () => {
    let challenge = '';
    const exchange = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { code: string; code_verifier: string };
      expect(body.code).toBe('real-code');
      expect(createHash('sha256').update(body.code_verifier).digest('base64url')).toBe(challenge);
      return new Response(JSON.stringify({ key: 'sk-or-new' }));
    });
    const open = browser(async (callback, state, auth) => {
      challenge = auth.searchParams.get('code_challenge') ?? '';
      expect(callback).toMatch(/^http:\/\/localhost:\d+\/callback$/);
      const forged = await fetch(`${callback}?code=forged&state=nope`);
      expect(forged.status).toBe(400);
      await fetch(`${callback}?code=real-code&state=${state}`);
    });
    await expect(connectOpenRouter(open, exchange as unknown as typeof fetch)).resolves.toBe(
      'sk-or-new',
    );
    expect(exchange).toHaveBeenCalledTimes(1);
  });

  it('fails on a denial, and ends a cancel as ConnectCancelled without calling OpenRouter', async () => {
    const exchange = vi.fn();
    const deny = browser(async (callback) => {
      await fetch(`${callback}?error=access_denied`);
    });
    await expect(connectOpenRouter(deny, exchange as never)).rejects.toThrow(/同意/);

    const idle = async (): Promise<void> => {
      setTimeout(cancelOpenRouterConnect, 0);
    };
    await expect(connectOpenRouter(idle, exchange as never)).rejects.toBeInstanceOf(
      ConnectCancelled,
    );
    expect(exchange).not.toHaveBeenCalled();
  });
});
