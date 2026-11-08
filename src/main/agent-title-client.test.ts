import { describe, expect, it, vi } from 'vitest';
import { suggestAgentTitle } from './agent-title-client';

const request = {
  screen: '> fix login',
  currentTitle: '',
  agentTitle: null,
  guide: 'tiny',
  maxChars: 24,
};

function reply(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
}

describe('suggestAgentTitle (ADR-029)', () => {
  it('sends the guide to OpenRouter with the key and returns the cleaned title', async () => {
    const fetchImpl = vi.fn(async () => reply('"Fix login."'));
    const title = await suggestAgentTitle(
      { apiKey: 'k', baseURL: '', model: '' },
      request,
      fetchImpl as unknown as typeof fetch,
    );
    expect(title).toBe('Fix login');
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('openrouter.ai');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer k');
    expect(String(init.body)).toContain('tiny');
  });

  it('never sends the OpenRouter key to a custom address', async () => {
    const fetchImpl = vi.fn(async () => reply('KEEP'));
    const title = await suggestAgentTitle(
      { apiKey: 'k', baseURL: 'http://127.0.0.1:11434/v1', model: 'm' },
      request,
      fetchImpl as unknown as typeof fetch,
    );
    expect(title).toBeNull();
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });
});
