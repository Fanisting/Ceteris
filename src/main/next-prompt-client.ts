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
  NEXT_PROMPT_DEFAULT_BASE_URL,
  NEXT_PROMPT_DEFAULT_MODEL,
  NEXT_PROMPT_MAX_SCREEN_CHARS,
  nextPromptEndpoint,
  nextPromptSystem,
  parseModelList,
  sendsOpenRouterKey,
  type FrequentPrompt,
  type NextPromptModelOption,
} from '@shared/next-prompt';

const TIMEOUT_MS = 8_000;
const MAX_REPLY_TOKENS = 60;

export interface NextPromptConfig {
  /** The connected OpenRouter key from SecretStore, '' when none. */
  apiKey: string;
  baseURL: string;
  model: string;
}

/** The OpenRouter key goes to OpenRouter only; a custom address gets no key at all. */
function authHeaders(config: NextPromptConfig, url: string): Record<string, string> {
  const key = config.apiKey.trim();
  return key && sendsOpenRouterKey(url) ? { Authorization: `Bearer ${key}` } : {};
}

async function post(
  config: NextPromptConfig,
  screen: string,
  frequent: readonly FrequentPrompt[],
  disableReasoning: boolean,
  fetchImpl: typeof fetch,
): Promise<Response> {
  const url = nextPromptEndpoint(config.baseURL);
  return fetchImpl(url, {
    method: 'POST',
    headers: { ...authHeaders(config, url), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.model.trim() || NEXT_PROMPT_DEFAULT_MODEL,
      max_tokens: MAX_REPLY_TOKENS,
      temperature: 0.3,
      // Asks OpenRouter for the price. Another provider may refuse the unknown field.
      ...(url.startsWith(NEXT_PROMPT_DEFAULT_BASE_URL)
        ? { usage: { include: true } }
        : {}),
      ...(disableReasoning ? { reasoning: { enabled: false } } : {}),
      messages: [
        { role: 'system', content: nextPromptSystem(frequent) },
        { role: 'user', content: screen.slice(-NEXT_PROMPT_MAX_SCREEN_CHARS) },
      ],
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

/**
 * @param onUsage receives each successful response's usage field, for the cost total
 * @param frequent messages the user often sends, offered to the model to reuse word for word
 * @returns text to offer, or null when the model has no useful guess
 */
export async function suggestNextPrompt(
  config: NextPromptConfig,
  screen: string,
  fetchImpl: typeof fetch = fetch,
  onUsage?: (usage: unknown) => void,
  frequent: readonly FrequentPrompt[] = [],
): Promise<string | null> {
  if (!config.baseURL.trim() && !config.apiKey.trim()) {
    throw new Error('还没有连接 OpenRouter:在设置 → AI 助手里点"连接 OpenRouter",或填写本地模型地址');
  }

  let res = await post(config, screen, frequent, true, fetchImpl);
  // Reasoning only slows this down, but some models refuse to switch it off.
  if (res.status === 400) res = await post(config, screen, frequent, false, fetchImpl);
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 200);
    throw new Error(`API 返回 ${res.status}:${detail}`);
  }
  const body = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: unknown;
  };
  onUsage?.(body.usage);
  return cleanSuggestion(body.choices?.[0]?.message?.content ?? '');
}

/**
 * The models the configured address offers, from its GET /models. OpenRouter answers
 * without a key; local servers such as Ollama and LM Studio answer the same way.
 *
 * @throws Error the address is not http, the server refused, or it did not answer in time
 */
export async function listNextPromptModels(
  config: NextPromptConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<NextPromptModelOption[]> {
  const url = nextPromptEndpoint(config.baseURL).replace(/\/chat\/completions$/i, '/models');
  const res = await fetchImpl(url, {
    headers: authHeaders(config, url),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 200);
    throw new Error(
      `读取模型列表失败:${url} 返回 ${res.status}:${detail}。` +
        '可能是这个地址不提供 /models,或需要登录;可以选"其他"手动填写模型名',
    );
  }
  return parseModelList(await res.json());
}
