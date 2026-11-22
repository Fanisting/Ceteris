/**
 * @file src/main/push-voice-client.test.ts
 * @purpose One test per rule of writePushVoice (ADR-057). fetch is a stub; nothing leaves
 *   the machine.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PUSH_VOICE_DEFAULT_MODEL, sampleTurn } from '@shared/push-voice';
import {
  resetPushVoiceModelsForTest,
  writePushVoice,
  type PushVoiceRequest,
} from './push-voice-client';

function req(extra: Partial<PushVoiceRequest> = {}): PushVoiceRequest {
  return {
    apiKey: 'sk-or-test',
    model: '',
    voice: 'mascot',
    zh: false,
    turn: sampleTurn('Alex', false, 1),
    ...extra,
  };
}

function reply(content: string, status = 200): Response {
  return new Response(
    status === 200 ? JSON.stringify({ choices: [{ message: { content } }] }) : content,
    { status },
  );
}

function bodyOf(fetchImpl: ReturnType<typeof vi.fn>, call: number): Record<string, unknown> {
  const init = fetchImpl.mock.calls[call]?.[1] as RequestInit;
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

describe('writePushVoice (ADR-057)', () => {
  beforeEach(() => resetPushVoiceModelsForTest());

  it('without a key it does not call out and says why', async () => {
    const fetchImpl = vi.fn();
    const r = await writePushVoice(req({ apiKey: '  ' }), fetchImpl);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(r).toEqual({ note: null, error: 'no OpenRouter key connected' });
  });

  it('posts to OpenRouter with the key and returns the parsed note', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(reply('{"title":"Yay","body":"42 green"}'));
    const r = await writePushVoice(req(), fetchImpl);
    expect(r).toEqual({ note: { title: 'Yay', body: '42 green' }, error: '' });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-or-test');
  });

  it('the default model (GLM) gets low reasoning from the first call', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(reply('{"title":"a","body":"b"}'));
    await writePushVoice(req(), fetchImpl);
    expect(bodyOf(fetchImpl, 0)).toMatchObject({
      model: PUSH_VOICE_DEFAULT_MODEL,
      reasoning: { effort: 'low', exclude: true },
    });
  });

  it('other models start with reasoning off; a 400 retries with low reasoning, remembered', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(reply('Reasoning is mandatory', 400))
      .mockResolvedValue(reply('{"title":"a","body":"b"}'));
    const r = await writePushVoice(req({ model: 'x/other' }), fetchImpl);
    expect(r.note).toEqual({ title: 'a', body: 'b' });
    expect(bodyOf(fetchImpl, 0).reasoning).toEqual({ enabled: false });
    expect(bodyOf(fetchImpl, 1).reasoning).toEqual({ effort: 'low', exclude: true });
    await writePushVoice(req({ model: 'x/other' }), fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(bodyOf(fetchImpl, 2).reasoning).toEqual({ effort: 'low', exclude: true });
  });

  it('an error status gives null with the status and detail', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(reply('rate limited', 429));
    const r = await writePushVoice(req(), fetchImpl);
    expect(r.note).toBeNull();
    expect(r.error).toBe('OpenRouter 429: rate limited');
  });

  it('a reply that is not a title and body gives null', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(reply('I cannot do that'));
    expect(await writePushVoice(req(), fetchImpl)).toEqual({
      note: null,
      error: 'reply was not a title and body',
    });
  });

  it('gives up after the time budget instead of waiting', async () => {
    const fetchImpl = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    const r = await writePushVoice(req(), fetchImpl as unknown as typeof fetch, 20);
    expect(r).toEqual({ note: null, error: 'no reply within 20 ms' });
  });

  it('a network error gives null with its message', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('getaddrinfo ENOTFOUND'));
    expect((await writePushVoice(req(), fetchImpl)).error).toBe('getaddrinfo ENOTFOUND');
  });
});
