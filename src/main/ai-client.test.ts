import { describe, expect, it, vi } from 'vitest';
import type { Settings } from '@shared/types';
import { AIClient, endpointFor } from './ai-client';

type Ai = Settings['ai'];

const settingsWith = (ai: Partial<Ai>): (() => Settings) => {
  const full: Ai = { provider: null, apiKey: '', baseURL: '', model: '', ...ai } as Ai;
  return () => ({ ai: full }) as unknown as Settings;
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const anthropicReply = (text: string) =>
  json({ model: 'claude-x', content: [{ type: 'text', text }] });
const openaiReply = (content: string) =>
  json({ model: 'gpt-x', choices: [{ message: { content } }] });

describe('endpointFor', () => {
  it('keeps the SDK meaning of Base URL: Anthropic up to the host, OpenAI up to /v1', () => {
    expect(endpointFor('anthropic', '')).toBe('https://api.anthropic.com/v1/messages');
    expect(endpointFor('openai', '')).toBe('https://api.openai.com/v1/chat/completions');
    expect(endpointFor('anthropic', 'https://gw.example/')).toBe('https://gw.example/v1/messages');
    expect(endpointFor('openai', 'https://gw.example/v1/chat/completions')).toBe(
      'https://gw.example/v1/chat/completions',
    );
  });
});

describe('AIClient.testConnection', () => {
  it('sends the Anthropic key and version headers and reports the model', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => anthropicReply('pong'));
    const client = new AIClient(
      settingsWith({ provider: 'anthropic', apiKey: 'k1' }),
      fetchImpl as never,
    );
    await expect(client.testConnection()).resolves.toEqual({
      ok: true,
      message: 'Anthropic claude-x 响应 OK',
    });
    const headers = fetchImpl.mock.calls[0]?.[1].headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('k1');
    expect(headers['anthropic-version']).toBe('2023-06-01');
  });

  it('returns the HTTP status as the message instead of throwing', async () => {
    const fetchImpl = vi.fn(async () => json({ error: 'bad key' }, 401));
    const client = new AIClient(
      settingsWith({ provider: 'openai', apiKey: 'k' }),
      fetchImpl as never,
    );
    const res = await client.testConnection();
    expect(res.ok).toBe(false);
    expect(res.message).toContain('401');
  });
});

describe('AIClient.recheckIdle', () => {
  it('asks OpenAI compatible providers to switch reasoning off, with a bearer key', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => openaiReply('active'));
    const client = new AIClient(
      settingsWith({ provider: 'openai', apiKey: 'k2' }),
      fetchImpl as never,
    );
    await expect(client.recheckIdle('tail')).resolves.toBe('keep-active');
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer k2');
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      reasoning_effort: 'minimal',
      thinking: { type: 'disabled' },
      enable_thinking: false,
    });
  });

  it('counts only the exact word active as working', async () => {
    const fetchImpl = vi.fn(async () => anthropicReply('idle, not active'));
    const client = new AIClient(
      settingsWith({ provider: 'anthropic', apiKey: 'k' }),
      fetchImpl as never,
    );
    await expect(client.recheckIdle('tail')).resolves.toBe('go-idle');
  });

  it('throws on an HTTP error so the caller falls back to the timer', async () => {
    const fetchImpl = vi.fn(async () => json({}, 500));
    const client = new AIClient(
      settingsWith({ provider: 'anthropic', apiKey: 'k' }),
      fetchImpl as never,
    );
    await expect(client.recheckIdle('tail')).rejects.toThrow('500');
  });
});
