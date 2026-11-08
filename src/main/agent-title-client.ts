/**
 * @file src/main/agent-title-client.ts
 * @purpose Asks the next prompt API (OpenRouter by default) for a short tab title (ADR-029).
 *   Uses the same address, key and model as next prompt suggestions, so one OpenRouter
 *   connection in Settings covers both.
 *
 * @不要在这里做的事:
 * - No timing or per-tab state; agent-titler.ts decides when to ask
 * - Never send the key to an address other than OpenRouter (sendsOpenRouterKey)
 */
import {
  NEXT_PROMPT_DEFAULT_BASE_URL,
  NEXT_PROMPT_DEFAULT_MODEL,
  nextPromptEndpoint,
  sendsOpenRouterKey,
} from '@shared/next-prompt';
import { agentTitleSystem, agentTitleUser, cleanAgentTitle } from '@shared/agent-title';
import type { NextPromptConfig } from './next-prompt-client';

const TIMEOUT_MS = 10_000;
const MAX_REPLY_TOKENS = 40;

export interface AgentTitleRequest {
  /** The end of the tab's rendered screen */
  screen: string;
  /** The tab's name now */
  currentTitle: string;
  /** The last title the agent set itself (OSC 0), or null */
  agentTitle: string | null;
  /** The user's rules from Settings; empty uses the default guide */
  guide: string;
  maxChars: number;
}

async function post(
  config: NextPromptConfig,
  request: AgentTitleRequest,
  disableReasoning: boolean,
  fetchImpl: typeof fetch,
): Promise<Response> {
  const url = nextPromptEndpoint(config.baseURL);
  const key = config.apiKey.trim();
  return fetchImpl(url, {
    method: 'POST',
    headers: {
      ...(key && sendsOpenRouterKey(url) ? { Authorization: `Bearer ${key}` } : {}),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.model.trim() || NEXT_PROMPT_DEFAULT_MODEL,
      max_tokens: MAX_REPLY_TOKENS,
      temperature: 0.2,
      ...(url.startsWith(NEXT_PROMPT_DEFAULT_BASE_URL) ? { usage: { include: true } } : {}),
      ...(disableReasoning ? { reasoning: { enabled: false } } : {}),
      messages: [
        { role: 'system', content: agentTitleSystem(request.guide, request.maxChars) },
        { role: 'user', content: agentTitleUser(request) },
      ],
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

/**
 * @param onUsage receives each successful response's usage field, for the cost total
 * @returns the new title, or null when the model says to keep the current one
 * @throws Error when nothing is connected, the API refuses, or it does not answer in time
 */
export async function suggestAgentTitle(
  config: NextPromptConfig,
  request: AgentTitleRequest,
  fetchImpl: typeof fetch = fetch,
  onUsage?: (usage: unknown) => void,
): Promise<string | null> {
  if (!config.baseURL.trim() && !config.apiKey.trim()) {
    throw new Error(
      '[AgentTitle] No OpenRouter key and no API address. Connect OpenRouter in Settings, AI Assistant, or set a local model address.',
    );
  }
  let res = await post(config, request, true, fetchImpl);
  // Some models refuse to switch reasoning off; ask again without that field.
  if (res.status === 400) res = await post(config, request, false, fetchImpl);
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 200);
    throw new Error(
      `[AgentTitle] API ${nextPromptEndpoint(config.baseURL)} returned ${res.status}: ${detail}. ` +
        'Possible causes: (1) the OpenRouter key was revoked, (2) the model name is wrong, ' +
        '(3) the account has no credit.',
    );
  }
  const body = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: unknown;
  };
  onUsage?.(body.usage);
  return cleanAgentTitle(body.choices?.[0]?.message?.content ?? '', request.maxChars);
}
