/**
 * @file src/main/next-prompt-client.ts
 * @purpose Asks an OpenAI compatible API, OpenRouter by default, to guess the next prompt for
 *   a coding agent. The user may set the address, the key and the model. Separate from
 *   ai-client.ts because this has its own key and model, and goes out on every idle
 *   moment, so it stays a small bounded request.
 *
 * It runs on the machine that owns the settings, which for a remote view is the Host.
 */
import {
  cleanSuggestion,
  NEXT_PROMPT_DEFAULT_MODEL,
  NEXT_PROMPT_MAX_SCREEN_CHARS,
  NEXT_PROMPT_SYSTEM,
  nextPromptConfigured,
  nextPromptEndpoint,
} from '@shared/next-prompt';

const TIMEOUT_MS = 8_000;
const MAX_REPLY_TOKENS = 60;

export interface NextPromptConfig {
  apiKey: string;
  baseURL: string;
  model: string;
}

async function post(
  config: NextPromptConfig,
  screen: string,
  disableReasoning: boolean,
  fetchImpl: typeof fetch,
): Promise<Response> {
  const key = config.apiKey.trim();
  return fetchImpl(nextPromptEndpoint(config.baseURL), {
    method: 'POST',
    headers: {
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.model.trim() || NEXT_PROMPT_DEFAULT_MODEL,
      max_tokens: MAX_REPLY_TOKENS,
      temperature: 0.3,
      ...(disableReasoning ? { reasoning: { enabled: false } } : {}),
      messages: [
        { role: 'system', content: NEXT_PROMPT_SYSTEM },
        { role: 'user', content: screen.slice(-NEXT_PROMPT_MAX_SCREEN_CHARS) },
      ],
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

/** @returns text to offer, or null when the model has no useful guess */
export async function suggestNextPrompt(
  config: NextPromptConfig,
  screen: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  if (!nextPromptConfigured(config)) throw new Error('未填写 API Key 或 API 地址');

  let res = await post(config, screen, true, fetchImpl);
  // Reasoning only slows this down, but some models refuse to switch it off.
  if (res.status === 400) res = await post(config, screen, false, fetchImpl);
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 200);
    throw new Error(`API 返回 ${res.status}:${detail}`);
  }
  const body = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return cleanSuggestion(body.choices?.[0]?.message?.content ?? '');
}
