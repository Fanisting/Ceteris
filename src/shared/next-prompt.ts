/**
 * @file src/shared/next-prompt.ts
 * @purpose Rules for guessing the next prompt in a Claude Code or Codex terminal. Pure, so
 *   the renderer and main process share them and they can be tested without either.
 */

/** Chosen by benchmark on 2026-11-05: 156ms average, about $0.0000035 per suggestion. */
export const NEXT_PROMPT_DEFAULT_MODEL = 'meta-llama/llama-3.1-8b-instruct';

/** The end of the screen is what matters, and input size is the running cost. */
export const NEXT_PROMPT_MAX_SCREEN_CHARS = 4_000;

export const NEXT_PROMPT_DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';

/** Running totals, kept on the machine that makes the calls. */
export interface NextPromptUsage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  /** Calls whose provider gave no price, so costUsd is missing them. */
  unpricedCalls: number;
  /** Per local day, keyed YYYY-MM-DD, for the daily cost chart. Only the last 30 days. */
  daily: Record<string, NextPromptDay>;
}

export interface NextPromptDay {
  calls: number;
  costUsd: number;
  /** The same day split by model id. Missing in days saved before models were kept. */
  models?: Record<string, { calls: number; costUsd: number }>;
}

/** Days kept in NextPromptUsage.daily; older days drop out on the next call. */
export const NEXT_PROMPT_DAYS_KEPT = 30;

export const EMPTY_NEXT_PROMPT_USAGE: NextPromptUsage = {
  calls: 0,
  inputTokens: 0,
  outputTokens: 0,
  costUsd: 0,
  unpricedCalls: 0,
  daily: {},
};

/** The local calendar day as YYYY-MM-DD, so a day ends at the user's midnight, not UTC's. */
export function localDay(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Key of the stacked segment that folds models past the chart's colour slots. */
export const OTHER_MODELS = 'other';
/** Key for cost from days saved before models were kept. */
export const UNKNOWN_MODEL = 'unknown';

export interface DailyCostChart {
  /**
   * Segment keys from the bottom of each bar up: model ids in the order they first
   * appear in the window, then OTHER_MODELS if any were folded. A model keeps its
   * place, and so its colour, from one day to the next.
   */
  series: string[];
  days: Array<{
    day: string;
    calls: number;
    costUsd: number;
    parts: Array<{ key: string; calls: number; costUsd: number }>;
  }>;
}

/**
 * The last `days` days ending today, oldest first, each split into one part per model.
 *
 * @param today the day the chart ends on; days are stepped by date so DST is safe
 * @param maxModels models drawn in their own colour; the rest fold into OTHER_MODELS,
 *   since a chart can only keep so many colours apart
 */
export function dailyCostChart(
  usage: NextPromptUsage,
  today: Date,
  days = 14,
  maxModels = 4,
): DailyCostChart {
  const window: Array<{ day: string; hit: NextPromptDay | undefined }> = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = localDay(new Date(today.getFullYear(), today.getMonth(), today.getDate() - i));
    window.push({ day, hit: usage.daily?.[day] });
  }
  const split = (hit: NextPromptDay): Record<string, { calls: number; costUsd: number }> =>
    hit.models ?? { [UNKNOWN_MODEL]: { calls: hit.calls, costUsd: hit.costUsd } };

  const order: string[] = [];
  for (const { hit } of window) {
    if (!hit) continue;
    const models = split(hit);
    // Within a day, the bigger spender first, so the order does not hang on key order.
    for (const m of Object.keys(models).sort((x, y) => models[y]!.costUsd - models[x]!.costUsd)) {
      if (!order.includes(m)) order.push(m);
    }
  }
  const named = order.slice(0, maxModels);
  const folded = order.length > maxModels;
  const series = folded ? [...named, OTHER_MODELS] : named;

  return {
    series,
    days: window.map(({ day, hit }) => {
      const parts = series.map((key) => ({ key, calls: 0, costUsd: 0 }));
      if (hit) {
        for (const [m, v] of Object.entries(split(hit))) {
          const part = parts[named.includes(m) ? named.indexOf(m) : named.length]!;
          part.calls += v.calls;
          part.costUsd += v.costUsd;
        }
      }
      return { day, calls: hit?.calls ?? 0, costUsd: hit?.costUsd ?? 0, parts };
    }),
  };
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

/**
 * Adds one response's usage field to the totals. Only OpenRouter reports a price, so
 * another provider counts as a call and its tokens with no cost.
 *
 * @param day localDay() of the call; it also gets the call, and days past the last
 *   NEXT_PROMPT_DAYS_KEPT are dropped
 * @param model the model id the call asked for, for the per model split of the day
 */
export function addNextPromptUsage(
  total: NextPromptUsage,
  usage: unknown,
  day: string,
  model: string,
): NextPromptUsage {
  const u = (typeof usage === 'object' && usage !== null ? usage : {}) as Record<string, unknown>;
  const priced = typeof u['cost'] === 'number' && Number.isFinite(u['cost']) && u['cost'] >= 0;
  const cost = count(u['cost']);
  const before = total.daily?.[day] ?? { calls: 0, costUsd: 0 };
  // A day saved before models were kept has no split; its earlier calls stay unattributed.
  const models = before.models ?? (before.calls > 0 ? { [UNKNOWN_MODEL]: { calls: before.calls, costUsd: before.costUsd } } : {});
  const m = models[model] ?? { calls: 0, costUsd: 0 };
  const daily = {
    ...total.daily,
    [day]: {
      calls: before.calls + 1,
      costUsd: before.costUsd + cost,
      models: { ...models, [model]: { calls: m.calls + 1, costUsd: m.costUsd + cost } },
    },
  };
  // YYYY-MM-DD sorts as text in date order.
  const kept = Object.keys(daily).sort().slice(-NEXT_PROMPT_DAYS_KEPT);
  return {
    daily: Object.fromEntries(kept.map((k) => [k, daily[k]!])),
    calls: total.calls + 1,
    inputTokens: total.inputTokens + count(u['prompt_tokens']),
    outputTokens: total.outputTokens + count(u['completion_tokens']),
    costUsd: total.costUsd + count(u['cost']),
    unpricedCalls: total.unpricedCalls + (priced ? 0 : 1),
  };
}

/**
 * The chat completions URL for a base address. Accepts the address as a provider's docs
 * give it, with or without the final path.
 *
 * @param baseURL undefined in settings saved before this option existed
 * @throws Error the address is not http or https
 */
export function nextPromptEndpoint(baseURL: string | undefined): string {
  const base = (baseURL?.trim() || NEXT_PROMPT_DEFAULT_BASE_URL).replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(base)) {
    throw new Error(`API 地址必须以 http:// 或 https:// 开头:${base}`);
  }
  return /\/chat\/completions$/i.test(base) ? base : `${base}/chat/completions`;
}

/**
 * OpenRouter needs a connected account; a custom address is taken to need no key, since it
 * is usually a local model server.
 */
export function nextPromptConfigured(config: { keySaved: boolean; baseURL?: string }): boolean {
  return config.baseURL?.trim() ? true : config.keySaved;
}

/**
 * Whether a request to this endpoint may carry the OpenRouter key. The key is OpenRouter's,
 * so a custom address never receives it.
 */
export function sendsOpenRouterKey(endpoint: string): boolean {
  return endpoint.startsWith(`${NEXT_PROMPT_DEFAULT_BASE_URL}/`);
}

const MAX_SUGGESTION_CHARS = 160;

export const NEXT_PROMPT_SYSTEM =
  'You predict the next message a developer will send to their AI coding agent. ' +
  'You are given the end of the terminal screen. Reply with only that message: one short ' +
  'direct instruction of at most 15 words, in the language the developer writes in. ' +
  'No quotes, no explanation. If no next step is clear, reply NONE.';

/** A message the developer has sent to Claude Code or Codex several times. */
export interface FrequentPrompt {
  text: string;
  count: number;
}

/** Sent with every guess, so a few lines are worth their tokens and many are not. */
export const FREQUENT_PROMPT_LIMIT = 10;
/** Below this a message is a one off, not a habit. */
const FREQUENT_PROMPT_MIN_COUNT = 3;
/** Longer messages are task descriptions that will not repeat word for word. */
const FREQUENT_PROMPT_MAX_CHARS = 100;
/**
 * Agent commands that leave, switch or configure the session. Frequent, but never the
 * next message after the agent stops, so they would only push real habits off the list.
 */
const SESSION_COMMANDS = /^\/(exit|quit|resume|model|login|logout|config|status|help|theme|settings)\b/i;

/**
 * The messages a developer repeats, most frequent first. Case and spacing are ignored when
 * counting; the most recent spelling is the one kept.
 *
 * @param prompts oldest first, as the history files store them
 */
export function topFrequentPrompts(
  prompts: readonly string[],
  limit = FREQUENT_PROMPT_LIMIT,
): FrequentPrompt[] {
  const seen = new Map<string, { text: string; count: number; last: number }>();
  prompts.forEach((raw, index) => {
    const trimmed = raw.trim();
    // Multi line messages and pastes are one off content, not habits.
    if (!trimmed || trimmed.includes('\n') || /\[Pasted text|\[Image #/i.test(trimmed)) return;
    const text = trimmed.replace(/\s+/g, ' ');
    if (text.length > FREQUENT_PROMPT_MAX_CHARS || SESSION_COMMANDS.test(text)) return;
    const key = text.toLowerCase();
    seen.set(key, { text, count: (seen.get(key)?.count ?? 0) + 1, last: index });
  });
  return [...seen.values()]
    .filter((e) => e.count >= FREQUENT_PROMPT_MIN_COUNT)
    .sort((a, b) => b.count - a.count || b.last - a.last)
    .slice(0, limit)
    .map(({ text, count }) => ({ text, count }));
}

/** The system message, with the developer's habits added when there are any. */
export function nextPromptSystem(frequent: readonly FrequentPrompt[]): string {
  if (frequent.length === 0) return NEXT_PROMPT_SYSTEM;
  const lines = frequent.map((f) => `- ${f.text} (${f.count} times)`).join('\n');
  return (
    `${NEXT_PROMPT_SYSTEM}\n\nThis developer often sends these exact messages:\n${lines}\n` +
    'When one of them fits what the screen shows, reply with it word for word.'
  );
}

/**
 * The message in one line of a history file. Claude Code writes {"display": ...} to
 * ~/.claude/history.jsonl and Codex writes {"text": ...} to ~/.codex/history.jsonl.
 */
export function promptFromHistoryLine(line: string): string | null {
  try {
    const entry = JSON.parse(line) as Record<string, unknown>;
    const text = entry['display'] ?? entry['text'];
    return typeof text === 'string' ? text : null;
  } catch {
    // The first line of a tail read is usually cut in half.
    return null;
  }
}

/** One choice in the model list of the settings page. */
export interface NextPromptModelOption {
  id: string;
  /** What the provider calls it, e.g. "Meta: Llama 3.1 8B Instruct". */
  name: string;
  /** US dollars per million tokens, undefined when the provider does not say. */
  inputPrice?: number | undefined;
  outputPrice?: number | undefined;
}

/**
 * Suggested for OpenRouter, with the reason for each. A guess goes out on every idle
 * moment, so cheap and fast matter more than clever. Shown even when the live list cannot
 * be fetched. Ids checked against openrouter.ai/api/v1/models on 2026-11-07.
 */
export const RECOMMENDED_NEXT_PROMPT_MODELS: ReadonlyArray<{
  id: string;
  zh: string;
  en: string;
}> = [
  {
    id: NEXT_PROMPT_DEFAULT_MODEL,
    zh: 'Llama 3.1 8B:默认,最快最便宜,约 0.16 秒',
    en: 'Llama 3.1 8B: default, fastest and cheapest, about 0.16s',
  },
  {
    id: 'mistralai/ministral-8b-2512',
    zh: 'Ministral 3 8B:同样小而便宜,更新',
    en: 'Ministral 3 8B: also small and cheap, newer',
  },
  {
    id: 'qwen/qwen3.7-flash',
    zh: 'Qwen3.7 Flash:便宜,中文更好',
    en: 'Qwen3.7 Flash: cheap, better at Chinese',
  },
  {
    id: 'google/gemini-2.5-flash-lite',
    zh: 'Gemini 2.5 Flash Lite:快,读屏更准',
    en: 'Gemini 2.5 Flash Lite: fast, reads the screen better',
  },
  {
    id: 'anthropic/claude-haiku-5.5',
    zh: 'Claude Haiku 5.5:最懂代码,价格略高',
    en: 'Claude Haiku 5.5: best at code, costs a little more',
  },
];

function perMillion(value: unknown): number | undefined {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n * 1_000_000 : undefined;
}

/**
 * Reads a GET /models reply. OpenRouter gives names and prices; Ollama, LM Studio and most
 * others give only ids, so the name falls back to the id. Cheapest first, then by name,
 * since price matters most for a call made this often.
 */
export function parseModelList(body: unknown): NextPromptModelOption[] {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return [];
  const models: NextPromptModelOption[] = [];
  for (const item of data as Array<Record<string, unknown> | null>) {
    const id = item?.['id'];
    if (!item || typeof id !== 'string' || !id) continue;
    // OpenRouter also lists image and audio models, which cannot answer in text.
    const outputs = (item['architecture'] as { output_modalities?: unknown } | undefined)
      ?.output_modalities;
    if (Array.isArray(outputs) && !outputs.includes('text')) continue;
    const pricing = (item['pricing'] ?? {}) as Record<string, unknown>;
    const name = typeof item['name'] === 'string' && item['name'] ? item['name'] : id;
    models.push({
      id,
      name,
      inputPrice: perMillion(pricing['prompt']),
      outputPrice: perMillion(pricing['completion']),
    });
  }
  const price = (m: NextPromptModelOption): number => m.inputPrice ?? Infinity;
  return models.sort((a, b) => price(a) - price(b) || a.name.localeCompare(b.name));
}

/** Input and output price per million tokens, "$0.050 / $0.080", or '' when unknown. */
export function formatModelPrice(model: NextPromptModelOption): string {
  if (model.inputPrice === undefined || model.outputPrice === undefined) return '';
  const fmt = (n: number): string => `$${n < 0.1 ? n.toFixed(3) : n.toFixed(2)}`;
  return `${fmt(model.inputPrice)} / ${fmt(model.outputPrice)}`;
}

export type AgentKind = 'claude' | 'codex';

const CLAUDE_SCREEN = /\? for shortcuts|shift\+tab to cycle/i;
const CODEX_SCREEN = /Ask Codex|app=codex|ctrl\s*\+\s*t\s+transcript|context left|OpenAI Codex/i;

/**
 * Which agent is on screen. Sessions are often plain shells where the user typed
 * "claude", so the template alone misses them and the screen has to be read too.
 */
export function detectAgent(templateId: string, screen: string): AgentKind | null {
  if (templateId === 'claude-code') return 'claude';
  // Codex first: its screen also says "? for shortcuts".
  if (templateId === 'codex' || CODEX_SCREEN.test(screen)) return 'codex';
  return CLAUDE_SCREEN.test(screen) ? 'claude' : null;
  return null;
}

/** Turn a model reply into text fit to type, or null when there is nothing to offer. */
export function cleanSuggestion(reply: string): string | null {
  const firstLine = reply.trim().split(/\r?\n/)[0] ?? '';
  const text = firstLine
    .replace(/^[>›❯\s]+/, '')
    .replace(/^["'“‘`]+|["'”’`]+$/g, '')
    .trim();
  if (!text || /^none\.?$/i.test(text) || text.length > MAX_SUGGESTION_CHARS) return null;
  return text;
}
