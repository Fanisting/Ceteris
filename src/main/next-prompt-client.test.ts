import { describe, expect, it, vi } from 'vitest';
import {
  EMPTY_NEXT_PROMPT_USAGE,
  NEXT_PROMPT_DEFAULT_MODEL,
  NEXT_PROMPT_MAX_SCREEN_CHARS,
  addNextPromptUsage,
} from '@shared/next-prompt';
import { suggestNextPrompt } from './next-prompt-client';

const reply = (content: string, status = 200) =>
  new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status });

const CONFIG = { apiKey: 'test-key', baseURL: '', model: '' };

describe('suggestNextPrompt', () => {
  it('returns the cleaned guess', async () => {
    const fetchImpl = vi.fn(async () => reply('"Run the tests"'));
    await expect(suggestNextPrompt(CONFIG, 'screen', fetchImpl as never)).resolves.toBe('Run the tests');
  });

  it('uses the default model when none is set, and a set one otherwise', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => reply('ok'));
    await suggestNextPrompt(CONFIG, 's', fetchImpl as never);
    await suggestNextPrompt({ apiKey: 'k', baseURL: '', model: 'a/b' }, 's', fetchImpl as never);
    const models = fetchImpl.mock.calls.map((c) => JSON.parse(c[1].body as string).model);
    expect(models).toEqual([NEXT_PROMPT_DEFAULT_MODEL, 'a/b']);
  });

  it('sends only the end of the screen, which bounds the cost', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => reply('ok'));
    await suggestNextPrompt(CONFIG, `start${'x'.repeat(NEXT_PROMPT_MAX_SCREEN_CHARS)}`, fetchImpl as never);
    const sent = JSON.parse(fetchImpl.mock.calls[0]?.[1].body as string).messages[1].content;
    expect(sent).toHaveLength(NEXT_PROMPT_MAX_SCREEN_CHARS);
    expect(sent).not.toContain('start');
  });

  it('retries with reasoning left on for models that require it', async () => {
    const fetchImpl = vi
      .fn(async (_url: string, _init: RequestInit) => reply('ok'))
      .mockResolvedValueOnce(new Response('{}', { status: 400 }));
    await expect(suggestNextPrompt(CONFIG, 's', fetchImpl as never)).resolves.toBe('ok');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchImpl.mock.calls[1]?.[1].body as string).reasoning).toBeUndefined();
  });

  it('reports other failures', async () => {
    const fetchImpl = vi.fn(async () => new Response('no credit', { status: 402 }));
    await expect(suggestNextPrompt(CONFIG, 's', fetchImpl as never)).rejects.toThrow(/402/);
  });

  it('does not call out without a key', async () => {
    const fetchImpl = vi.fn();
    await expect(suggestNextPrompt({ apiKey: ' ', baseURL: '', model: '' }, 's', fetchImpl as never)).rejects.toThrow(
      /API Key/,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('custom API address', () => {
  const reply = (): Response =>
    new Response(JSON.stringify({ choices: [{ message: { content: 'run the tests' } }] }));

  it('posts to the address given, with or without the final path', async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(url);
      return reply();
    }) as unknown as typeof fetch;
    const config = { apiKey: 'k', model: 'm' };
    await suggestNextPrompt({ ...config, baseURL: '' }, 'x', fetchImpl);
    await suggestNextPrompt({ ...config, baseURL: 'https://api.example.com/v1/' }, 'x', fetchImpl);
    await suggestNextPrompt(
      { ...config, baseURL: 'https://api.example.com/v1/chat/completions' },
      'x',
      fetchImpl,
    );
    expect(urls).toEqual([
      'https://openrouter.ai/api/v1/chat/completions',
      'https://api.example.com/v1/chat/completions',
      'https://api.example.com/v1/chat/completions',
    ]);
  });

  it('sends no key to a local model that has none', async () => {
    let headers: Record<string, string> = {};
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      headers = init.headers as Record<string, string>;
      return reply();
    }) as unknown as typeof fetch;
    await suggestNextPrompt(
      { apiKey: '', baseURL: 'http://127.0.0.1:11434/v1', model: 'm' },
      'x',
      fetchImpl,
    );
    expect(headers).not.toHaveProperty('Authorization');
  });

  it('refuses an address that is not http', async () => {
    await expect(
      suggestNextPrompt({ apiKey: 'k', baseURL: 'file:///etc/passwd', model: 'm' }, 'x'),
    ).rejects.toThrow('http');
  });
});

describe('cost total', () => {
  it('adds priced calls, and counts a call with no price separately', () => {
    let total = EMPTY_NEXT_PROMPT_USAGE;
    total = addNextPromptUsage(total, { prompt_tokens: 100, completion_tokens: 10, cost: 0.002 });
    total = addNextPromptUsage(total, { prompt_tokens: 50, completion_tokens: 5 });
    total = addNextPromptUsage(total, undefined);
    expect(total).toEqual({
      calls: 3,
      inputTokens: 150,
      outputTokens: 15,
      costUsd: 0.002,
      unpricedCalls: 2,
    });
  });

  it('reports usage from a response, and asks only OpenRouter for the price', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string) as Record<string, unknown>);
      return new Response(
        JSON.stringify({ choices: [{ message: { content: 'go' } }], usage: { cost: 0.001 } }),
      );
    }) as unknown as typeof fetch;
    const seen: unknown[] = [];
    await suggestNextPrompt(CONFIG, 'x', fetchImpl, (u) => seen.push(u));
    await suggestNextPrompt({ ...CONFIG, baseURL: 'https://api.example.com/v1' }, 'x', fetchImpl);
    expect(seen).toEqual([{ cost: 0.001 }]);
    expect(bodies[0]).toHaveProperty('usage');
    expect(bodies[1]).not.toHaveProperty('usage');
  });
});
