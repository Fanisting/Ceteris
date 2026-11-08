/**
 * @file src/main/ai-client.ts
 * @purpose BETA-031:AI 助手主进程客户端。统一封装 Anthropic Messages API 与
 *   OpenAI 兼容的 Chat Completions API,提供 testConnection 与 recheckIdle 两个方法。
 *
 *   API key 来自 settings.ai.apiKey,运行时变更通过 getSettings() 每次现读。
 *   失败回退 throw,调用方决定后续行为(BETA-006 LLM 复核失败回退到原阈值,
 *   不阻塞主流程)。
 *
 *   为什么用 fetch 而不是官方 SDK(2026-11 起):两个 SDK 只为这里的两次非流式
 *   POST 打进安装包。请求和回复都很小,手写 fetch 只有几十行,与
 *   next-prompt-client.ts 同一写法,也省掉两个依赖。BETA-031 当初选 SDK 是为了
 *   以后的 streaming / function calling,这两项至今没有做。
 *
 *   Base URL 的含义与 SDK 时代保持一致,用户已填的地址不用改:
 *   - Anthropic:填到域名为止(默认 https://api.anthropic.com),本文件补 /v1/messages
 *   - OpenAI:填到 /v1 为止(默认 https://api.openai.com/v1),本文件补 /chat/completions
 *
 * @对应文档章节: 工单库 BETA-006 BETA-031(docs/archive/beta反馈工单库-20260515.md)
 *
 * @不要在这里做的事:
 * - 不要在这里放 next prompt 的请求(那是 next-prompt-client.ts,有自己的 key 和模型)
 * - 不要重试:recheckIdle 要低延迟,失败由 session-manager 回退到原阈值判定
 */
import type { Settings } from '@shared/types';
import { logger } from './logger';

const DEFAULT_ANTHROPIC_MODEL = 'claude-haiku-5-5';
const DEFAULT_OPENAI_MODEL = 'gpt-4o-mini';
const ANTHROPIC_DEFAULT_BASE_URL = 'https://api.anthropic.com';
const OPENAI_DEFAULT_BASE_URL = 'https://api.openai.com/v1';
/** Anthropic API 要求的版本头;Messages API 自 2023-06-01 起未变 */
const ANTHROPIC_VERSION = '2023-06-01';
/**
 * SDK 默认超时是 10 分钟。这里的请求只要几个 token,20 秒没回复就当失败,
 * 免得一个卡住的网关让 recheckIdle 一直挂着。
 */
const REQUEST_TIMEOUT_MS = 20_000;

type Provider = 'anthropic' | 'openai';

/**
 * 取 settings 中的 ai 配置;未设置时返回安全默认(provider null)。
 * SettingsManager 在 initialize 完成前调用本类是合理的(测试 / 早期 IPC)。
 */
function safeAi(s: Settings | undefined): {
  provider: Provider | null;
  apiKey: string;
  /** F6(beta 勘误2):自定义 endpoint;空串 = 官方默认地址 */
  baseURL: string;
  model: string;
} {
  const ai = s?.ai;
  return {
    provider: ai?.provider ?? null,
    apiKey: ai?.apiKey ?? '',
    baseURL: ai?.baseURL ?? '',
    model: ai?.model ?? '',
  };
}

/**
 * 拼出完整请求地址。空串走官方默认;去掉末尾斜杠,免得出现 `//v1/messages`。
 * 用户若已经把完整路径填进来(例如 `.../chat/completions`),不再重复追加。
 */
export function endpointFor(provider: Provider, baseURL: string): string {
  const fallback = provider === 'anthropic' ? ANTHROPIC_DEFAULT_BASE_URL : OPENAI_DEFAULT_BASE_URL;
  const base = (baseURL.trim() || fallback).replace(/\/+$/, '');
  const suffix = provider === 'anthropic' ? '/v1/messages' : '/chat/completions';
  return base.toLowerCase().endsWith(suffix) ? base : base + suffix;
}

interface ModelReply {
  /** 服务端回报的模型名;缺失时用请求里的模型名 */
  model: string;
  /** 首个文本块;没有文本时为空串 */
  text: string;
  /** 完整回复,给 llm 日志排障用 */
  raw: unknown;
}

/**
 * 发一次非流式请求,返回首个文本块。
 *
 * @param extra 合并进请求体的额外字段(OpenAI 侧的跨厂商关推理字段)
 * @throws HTTP 非 2xx、超时、网络错误、回复不是 JSON 时都会抛,message 里带状态码和回复开头
 */
async function callModel(
  fetchImpl: typeof fetch,
  provider: Provider,
  apiKey: string,
  baseURL: string,
  model: string,
  prompt: string,
  maxTokens: number,
  extra: Record<string, unknown> = {},
): Promise<ModelReply> {
  const url = endpointFor(provider, baseURL);
  const headers: Record<string, string> =
    provider === 'anthropic'
      ? { 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION }
      : { Authorization: `Bearer ${apiKey}` };
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
      ...extra,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    throw new Error(
      `[AIClient] ${provider} 请求 ${url} 返回 ${res.status}:${detail}。` +
        '可能原因:(1) API key 无效或过期;(2) 模型名不存在;' +
        '(3) Base URL 指向的服务与所选 provider 的协议不兼容。',
    );
  }
  const body = (await res.json()) as {
    model?: string;
    content?: Array<{ type?: string; text?: string }>;
    choices?: Array<{ message?: { content?: string | null } }>;
  };
  // Anthropic 的 content 是 block 数组,取首个 text block;OpenAI 取首个 choice
  const text =
    provider === 'anthropic'
      ? (body.content?.find((b) => b.type === 'text')?.text ?? '')
      : (body.choices?.[0]?.message?.content ?? '');
  return { model: body.model ?? model, text, raw: body };
}

export interface TestConnectionResult {
  ok: boolean;
  /** 成功时:provider 显示名;失败时:错误描述 */
  message: string;
}

export class AIClient {
  /**
   * @param getSettings 注入 settings 读取函数,SettingsManager.get() 直接传过来。
   *   每次调用现读,避免 settings 改了客户端不刷新的问题。
   * @param fetchImpl 测试注入用;生产走全局 fetch
   */
  constructor(
    private readonly getSettings: () => Settings | undefined,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** 当前是否可用(已选 provider + 已填 key) */
  isConfigured(): boolean {
    const { provider, apiKey } = safeAi(this.getSettings());
    return !!provider && apiKey.trim().length > 0;
  }

  /**
   * 跑一次最小请求验证 key 有效。
   * 错误细节走 message 字段返回,不抛;调用方(IPC handler)直接转给 UI。
   */
  async testConnection(): Promise<TestConnectionResult> {
    const { provider, apiKey, baseURL, model } = safeAi(this.getSettings());
    if (!provider) return { ok: false, message: '未选择 provider' };
    if (!apiKey.trim()) return { ok: false, message: 'API key 为空' };
    const name = provider === 'anthropic' ? 'Anthropic' : 'OpenAI';
    const modelUsed =
      model || (provider === 'anthropic' ? DEFAULT_ANTHROPIC_MODEL : DEFAULT_OPENAI_MODEL);
    try {
      const reply = await callModel(
        this.fetchImpl,
        provider,
        apiKey,
        baseURL,
        modelUsed,
        'ping',
        8,
      );
      return { ok: true, message: `${name} ${reply.model} 响应 OK` };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn('AIClient', 'testConnection failed', err);
      return { ok: false, message: msg };
    }
  }

  /**
   * BETA-006 v2:active→idle 跃迁前给 LLM 看一眼终端尾部,问它"用户该不
   * 该回来看一眼了" — 因为 Ceteris 的主要用途是监控多个后台 Agent,旧 tab
   * 在后台跑、状态点是用户判断"该不该回去检查"的唯一信号。
   *
   * 返回 'keep-active' = 任务还在跑,先别打扰用户;'go-idle' = 任务停了 /
   * 出错 / 在等人输入,该让状态点亮起来。
   *
   * 出错时 throw — 调用方应当 try/catch 并回退到原阈值判定。
   *
   * @param scrollbackTail 终端末尾几十行,headless buffer 翻译后的纯文本
   * @param meta 输入元数据(BETA-006 v2.1 / v2.2):
   *   - enterAgeMs:用户上次按 Enter 距今 ms,null = 从未按过
   *   - inputAgeMs:用户上次任何输入距今 ms,null = 从未输入
   *   - recentKeys:最近 N 个按键事件(类别 + 距今 ms),**无内容,仅类别**
   *
   *   LLM 用前两个区分"长命令在跑"vs"用户打字未提交";recentKeys 让它再看
   *   一眼最近的输入节奏 — scrollback 末尾两种情况文本相同,LLM 单看 tail
   *   无法区分,需要本侧补元数据。
   *
   *   **隐私保证**:recentKeys 永远只有时间戳和类别(char/enter/backspace/other),
   *   绝不包含按键内容。session-manager.classifyInput 在源头保证。
   */
  async recheckIdle(
    scrollbackTail: string,
    meta?: {
      enterAgeMs: number | null;
      inputAgeMs: number | null;
      recentKeys?: Array<{
        ageMs: number;
        kind: 'char' | 'enter' | 'backspace' | 'other';
      }>;
    },
  ): Promise<'keep-active' | 'go-idle'> {
    const { provider, apiKey, baseURL, model } = safeAi(this.getSettings());
    if (!provider) throw new Error('AI provider 未配置');
    if (!apiKey.trim()) throw new Error('AI apiKey 未填');

    // Prompt 极简化(2026-05-16):一句话提问,例子全删。
    //
    // 旧 prompt 列了 8 个 "active 信号" + "idle 信号" 的具体例子,反而把
    // LLM 推进自相矛盾:Claude Code 首屏既匹配 "TUI in normal operation"
    // (active)又匹配 "shell prompt as last line"(idle),模型卡在两条规则
    // 之间反复推理 → 36s 延迟 + 同输入两次相反判定(详见 2026-05-16 日志)。
    //
    // 新策略:只问一句"在工作 vs 等人输入",让模型自己判断。配合下面
    // OpenAI 分支里 reasoning_effort / thinking / enable_thinking
    // 三套跨厂商关推理字段,目标延迟 < 1s。
    //
    // prompt 明确禁止 chain-of-thought,双保险 — 某些 provider 关推理字段
    // 不生效时(字段名对不上厂商约定),靠 prompt 也能压制大段输出。
    // BETA-006 v2.1:把上次 Enter / 上次任意输入距今多久拼成一行元数据。
    // 关键解谜信号 — scrollback 末尾"prompt> some text"两种情况完全同形:
    //   (a) 命令在跑(用户已按 Enter)→ active
    //   (b) 用户在打字未提交 → idle
    // LLM 单看 tail 区分不开,有了 enterAge / inputAge 就能判。
    //
    // BETA-006 v2.2:再附最近按键事件时间线(类别+距今,无内容)。让 LLM
    // 看节奏 — 连续 char 流 = 在打字;只 1 个 enter 后归零 = 命令在跑。
    const fmtAge = (ms: number | null): string =>
      ms === null ? 'NEVER' : `${(ms / 1000).toFixed(1)}s ago`;
    const enterAgeStr = fmtAge(meta?.enterAgeMs ?? null);
    const inputAgeStr = fmtAge(meta?.inputAgeMs ?? null);

    // 按键时间线:最新在前。空 buffer → 一句简短占位。
    const recentKeys = meta?.recentKeys ?? [];
    const keyTimelineStr =
      recentKeys.length === 0
        ? '(no keystrokes in last 30 seconds)'
        : [...recentKeys]
            .reverse()
            .map((k) => `  ${(k.ageMs / 1000).toFixed(1)}s ago: ${k.kind}`)
            .join('\n');

    const prompt =
      'You are a low-latency classifier. Look at the terminal tail and ' +
      'input metadata below and decide: is the foreground program still ' +
      'WORKING on its own, or is it WAITING for the user to do/type ' +
      'something?\n\n' +
      'Reply with EXACTLY ONE word — `active` (working) or `idle` (waiting). ' +
      'No reasoning, no chain-of-thought, no explanation, no preamble.\n\n' +
      'Key disambiguation: the terminal tail alone CANNOT tell you whether ' +
      'the last visible line is "a command running" or "text the user is ' +
      'typing but has not submitted yet" — both look identical. Use the ' +
      'input metadata:\n' +
      '  * Recent steady stream of `char` keystrokes, no recent `enter` ' +
      '→ user is composing → `idle`\n' +
      '  * Last `enter` recent + no newer keystrokes ' +
      '→ command really running → `active`\n' +
      '  * No keystrokes recently + tail shows a fresh prompt ' +
      '→ session is idle waiting → `idle`\n\n' +
      '--- terminal tail ---\n' +
      scrollbackTail +
      '\n--- end ---\n\n' +
      '--- input metadata ---\n' +
      `Last Enter pressed by user: ${enterAgeStr}\n` +
      `Last keystroke by user: ${inputAgeStr}\n` +
      'Recent keystroke timeline (most recent first; CATEGORIES ONLY, ' +
      'no characters logged):\n' +
      keyTimelineStr +
      '\nLegend: `char`=printable key, `enter`=Enter/Return, ' +
      '`backspace`=delete, `other`=arrows / ctrl shortcuts / paste\n' +
      '--- end metadata ---\n\n' +
      'One word:';

    // BETA-006 排障日志:把喂给 LLM 的 tail 完整落盘。排"为什么 sleep
    // 被判 idle"这类问题必须看到 LLM 收到的原始字节(含 ANSI/控制符,
    // JSON 序列化里会 \uXXXX 转义)。tail 上限 2KB,一次约 2-3KB。
    // 走 logger.llm → 独立 llm-YYYY-MM-DD.log,不与 main 抢配额。
    const modelUsed =
      model || (provider === 'anthropic' ? DEFAULT_ANTHROPIC_MODEL : DEFAULT_OPENAI_MODEL);
    logger.llm(
      'AIClient',
      `recheckIdle → ${provider} ${modelUsed} tail.len=${scrollbackTail.length}` +
        ` enter=${enterAgeStr} input=${inputAgeStr} keys=${recentKeys.length}`,
      { tail: scrollbackTail, recentKeys },
    );

    // max_tokens 64(2026-05-16 从 8192 降):推理已通过下面关推理字段关掉,
    // answer 只需 1-3 token("active"/"idle"),64 给点余量。若某 provider
    // 没认领关推理字段、模型仍在思考,64 会截断 CoT → content 空 → 下面
    // normalized 判定走 go-idle 兜底(保守:误报 idle 提醒用户看,代价低于
    // 漏报 keep-active)。
    const maxTokens = 64;
    // Claude 默认不开 extended thinking(thinking 是 opt-in 字段,不传就关),
    // 所以 Anthropic 分支无需额外字段。
    //
    // OpenAI 兼容协议下未识别字段大多被忽略,所以一次把三家约定都发出去,
    // 谁认领谁生效:
    //   - reasoning_effort: 'minimal'  → OpenAI o-series / GPT-5
    //   - thinking: { type: 'disabled' } → Kimi K2.5/K2.6, DeepSeek V4/R1
    //   - enable_thinking: false        → Qwen (DashScope), Hunyuan
    // 严格模式 provider 如果对未识别字段 400,这里会进 catch,
    // recheckIdle throw → session-manager 回退到原阈值判定(不阻塞)。
    const extra =
      provider === 'openai'
        ? { reasoning_effort: 'minimal', thinking: { type: 'disabled' }, enable_thinking: false }
        : {};

    let text: string;
    try {
      const reply = await callModel(
        this.fetchImpl,
        provider,
        apiKey,
        baseURL,
        modelUsed,
        prompt,
        maxTokens,
        extra,
      );
      // 完整回复落盘:排"为什么 content 为空"要看 stop_reason / finish_reason /
      // usage / reasoning_content 等非标字段
      logger.llm('AIClient', `recheckIdle ← ${provider} raw res`, { res: reply.raw });
      text = reply.text;
    } catch (err) {
      logger.warn('AIClient', 'recheckIdle LLM call threw', err);
      throw err;
    }

    // 严格相等判定:旧版用 includes('active'),会把 "idle, not active" 也算
    // keep-active(子串误判)。新 prompt 要求"EXACTLY ONE word",严格等比
    // 子串安全。命中不到 active 就 go-idle:LLM 偶尔啰嗦也偏保守地"让
    // 状态点亮起来"(idle 一侧是"提醒用户看",误报代价低于漏报)。
    const normalized = text.trim().toLowerCase();
    const verdict: 'keep-active' | 'go-idle' = normalized === 'active' ? 'keep-active' : 'go-idle';
    logger.llm('AIClient', `recheckIdle ← raw=${JSON.stringify(text)} verdict=${verdict}`);
    return verdict;
  }
}
