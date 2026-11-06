import { describe, expect, it, vi } from 'vitest';
import { NEXT_PROMPT_DEFAULT_MODEL, NEXT_PROMPT_MAX_SCREEN_CHARS } from '@shared/next-prompt';
import { suggestNextPrompt } from './next-prompt-client';

const reply = (content: string, status = 200) =>
  new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status });

const CONFIG = { apiKey: 'test-key', model: '' };

describe('suggestNextPrompt', () => {
  it('returns the cleaned guess', async () => {
    const fetchImpl = vi.fn(async () => reply('"Run the tests"'));
    await expect(suggestNextPrompt(CONFIG, 'screen', fetchImpl as never)).resolves.toBe('Run the tests');
  });

  it('uses the default model when none is set, and a set one otherwise', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => reply('ok'));
    await suggestNextPrompt(CONFIG, 's', fetchImpl as never);
    await suggestNextPrompt({ apiKey: 'k', model: 'a/b' }, 's', fetchImpl as never);
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
    await expect(suggestNextPrompt({ apiKey: ' ', model: '' }, 's', fetchImpl as never)).rejects.toThrow(
      /API Key/,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
