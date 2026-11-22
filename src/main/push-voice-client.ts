/**
 * @file src/main/push-voice-client.ts
 * @purpose Asks OpenRouter for one cute done notification (ADR-057). Returns null on any
 *   failure, so the caller shows the plain ADR-048 text instead.
 *
 * @关键设计:
 * - OpenRouter only, with the key connected for next prompt (ADR-025, SecretStore). No key,
 *   no call: the feature needs no address or key of its own.
 * - Hard time budget (PUSH_VOICE_TIMEOUT_MS). A notification that arrives late is worse
 *   than a plain one. With provider sort "latency", GLM 5.3 Flash answered 40 live calls in
 *   0.7 s median, 1.5 s at most (2026-11-22); the budget leaves room for a slow provider.
 * - Reasoning: switched off where the model allows. Some models (GLM 5.3 Flash, the default)
 *   refuse that with a 400; those get low effort with the reasoning text left out, and the
 *   model id is remembered so later calls skip the failed first try.
 *
 * @对应文档章节:软件定义书.md ADR-057
 *
 * @不要在这里做的事:
 * - Do not show the notification here; done-notifier.ts decides when and what to show.
 * - Do not retry after a timeout; the plain text goes out instead.
 */
import { NEXT_PROMPT_DEFAULT_BASE_URL } from '@shared/next-prompt';
import {
  PUSH_VOICE_DEFAULT_MODEL,
  parsePushReply,
  pushSystemPrompt,
  pushUserMessage,
  type PushExample,
  type PushTurn,
  type PushVoiceId,
} from '@shared/push-voice';
import { logger } from './logger';

export const PUSH_VOICE_TIMEOUT_MS = 5_000;
/** Includes hidden reasoning tokens for models that must reason. */
const MAX_TOKENS = 1_500;

const ENDPOINT = `${NEXT_PROMPT_DEFAULT_BASE_URL}/chat/completions`;

/** Models that answered 400 to reasoning: off. Seeded with the default, learned for others. */
const mustReason = new Set<string>([PUSH_VOICE_DEFAULT_MODEL]);

export interface PushVoiceRequest {
  /** The OpenRouter key from SecretStore, '' when none is connected */
  apiKey: string;
  /** OpenRouter model id, '' = PUSH_VOICE_DEFAULT_MODEL */
  model: string;
  voice: PushVoiceId;
  zh: boolean;
  turn: PushTurn;
}

export interface PushVoiceResult {
  note: PushExample | null;
  /** Why note is null, for the log and the Settings test; '' when it is not */
  error: string;
}

/**
 * @returns the notification text, or null with a reason; never throws
 */
export async function writePushVoice(
  req: PushVoiceRequest,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = PUSH_VOICE_TIMEOUT_MS,
): Promise<PushVoiceResult> {
  const key = req.apiKey.trim();
  if (!key) return { note: null, error: 'no OpenRouter key connected' };
  const model = req.model.trim() || PUSH_VOICE_DEFAULT_MODEL;
  const signal = AbortSignal.timeout(timeoutMs);
  const started = Date.now();
  try {
    let res = await post(req, key, model, mustReason.has(model), fetchImpl, signal);
    if (res.status === 400 && !mustReason.has(model)) {
      mustReason.add(model);
      res = await post(req, key, model, true, fetchImpl, signal);
    }
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 200);
      return { note: null, error: `OpenRouter ${res.status}: ${detail}` };
    }
    const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const note = parsePushReply(body.choices?.[0]?.message?.content ?? '', req.zh);
    logger.debug(
      'PushVoice',
      `model=${model} voice=${req.voice} ms=${Date.now() - started} ok=${!!note}`,
    );
    return note ? { note, error: '' } : { note: null, error: 'reply was not a title and body' };
  } catch (err) {
    const timedOut = signal.aborted;
    return {
      note: null,
      error: timedOut
        ? `no reply within ${timeoutMs} ms`
        : err instanceof Error
          ? err.message
          : String(err),
    };
  }
}

function post(
  req: PushVoiceRequest,
  key: string,
  model: string,
  reason: boolean,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
): Promise<Response> {
  return fetchImpl(ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      max_tokens: MAX_TOKENS,
      temperature: 0.9,
      reasoning: reason ? { effort: 'low', exclude: true } : { enabled: false },
      // Several providers serve each model; the fastest one keeps the note on time
      provider: { sort: 'latency' },
      messages: [
        {
          role: 'system',
          content: pushSystemPrompt(req.voice, req.zh, req.turn.sticker, req.turn.answer !== ''),
        },
        { role: 'user', content: pushUserMessage(req.turn) },
      ],
    }),
    signal,
  });
}

/** Tests only: forget learned models. */
export function resetPushVoiceModelsForTest(): void {
  mustReason.clear();
  mustReason.add(PUSH_VOICE_DEFAULT_MODEL);
}
