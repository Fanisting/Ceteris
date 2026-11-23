/**
 * @file src/shared/push-voice.ts
 * @purpose AI-written done notifications (ADR-057): the five voices, the example toasts the
 *   Settings page shows for each, the prompt sent to the model, and the cleanup of its reply.
 *
 * @关键设计:
 * - Off by default (settings.notifications.ai.enabled). When on, a done notification asks an
 *   OpenRouter model, GLM 5.3 Flash by default, for a cute title and body in the chosen voice.
 *   Any failure (no key, timeout, bad reply) falls back to the plain text of ADR-048.
 * - Two levels of context (settings.notifications.ai.includeAnswer): names only (agent, tab,
 *   folder, minutes, the user's name), or also the last ANSWER_TAIL_CHARS characters of the
 *   screen. Only the second lets a toast say what actually happened ("42 tests pass").
 * - Honesty over cuteness: the system prompt says a stuck or failed turn must read as
 *   "needs you". In the 2026-11-22 test, models that dressed up a stopped script as a win
 *   were the main failure, so the rule is spelled out in the prompt.
 * - The sticker voice gets its count from Ceteris (turns notified today), never from the
 *   model: in the test the models counted 5 and 6 for the same turn.
 * - Lengths are clamped here after the reply, since models overshoot about one time in three.
 *   Inline dashes are turned into commas (house style, and they read badly in a toast).
 *
 * @对应文档章节:软件定义书.md ADR-057, ADR-048
 *
 * @不要在这里做的事:
 * - No fetch, no settings reads, no clock: main passes everything in. Pure so every rule has
 *   a test, and the renderer can import the voice list and examples.
 */

export type PushVoiceId = 'mascot' | 'nudge' | 'cat' | 'quest' | 'stickers';

/** Chosen on 2026-11-22 from 10 models: cheap, about 1 s, cute and honest. */
export const PUSH_VOICE_DEFAULT_MODEL = 'z-ai/glm-5.3-flash';

/** Characters of the screen end sent when includeAnswer is on. */
export const ANSWER_TAIL_CHARS = 600;

/** Clamp limits in characters (code points), what a Windows / macOS toast shows. */
export const PUSH_LIMITS = {
  zh: { title: 20, body: 64 },
  en: { title: 48, body: 140 },
} as const;

/** Limits asked of the model; tighter than the clamp so a small overshoot survives. */
const ASKED_LIMITS = { zh: { title: 14, body: 48 }, en: { title: 32, body: 110 } } as const;

export interface PushExample {
  title: string;
  body: string;
}

export interface PushVoice {
  id: PushVoiceId;
  /** A to E, as on the options page the user picked from */
  letter: string;
  name: { zh: string; en: string };
  blurb: { zh: string; en: string };
  /** Part of the system prompt that sets the voice */
  prompt: string;
  /**
   * Real model outputs from the 2026-11-22 test, {name} = the user's name. One finished
   * turn and one turn that stopped for a decision, per language.
   */
  examples: { zh: [PushExample, PushExample]; en: [PushExample, PushExample] };
}

export const PUSH_VOICES: readonly PushVoice[] = [
  {
    id: 'mascot',
    letter: 'A',
    name: { zh: '团子', en: 'Mascot' },
    blurb: {
      zh: '一只圆滚滚的小团子在旁边陪你,为 agent 的成果骄傲。软萌,带颜文字,叫你的名字。',
      en: 'A round fluffy creature beside you, proud of the agent. Soft, bouncy, with kaomoji.',
    },
    prompt:
      "Voice: a tiny kawaii mascot (a round fluffy creature) who works beside the user and is proud of the agent's work. " +
      'Use one or two kaomoji such as (｡•̀ᴗ-)✧ (≧▽≦) ฅ^•ﻌ•^ฅ (๑•̀ㅂ•́)و✧ or a cute emoji. Soft, bouncy, affectionate, a little playful.',
    examples: {
      zh: [
        {
          title: '{name}！42个测试全绿啦',
          body: '登录测试修好了，mock时钟重置搞定 ฅ^•ﻌ•^ฅ 回来看看要不要提交？',
        },
        {
          title: '{name}，来拍板啦！',
          body: '日期有两种写法，团子不敢猜 (๑•̀ㅂ•́)و✧ 等你一句话就继续跑～',
        },
      ],
      en: [
        {
          title: '{name}, sec 2 is drafted! (≧▽≦)',
          body: '1,400 words on pricing, reference prices & fees ฅ^•ﻌ•^ฅ Two sneaky TODO citations want your eyes!',
        },
        {
          title: '{name}, agent needs you! (｡•̀ᴗ-)✧',
          body: "Stopped at step 3 after 14 min: 312 date rows, two formats. Pick day-first or month-first and I'll keep going! ฅ^•ﻌ•^ฅ",
        },
      ],
    },
  },
  {
    id: 'nudge',
    letter: 'B',
    name: { zh: '最后一口', en: 'Last bite' },
    blurb: {
      zh: '暖心啦啦队。说清做好了什么,和只剩你的一小步,像甜点的最后一口。最不闹,最催你收尾。',
      en: 'A warm cheerleader. What is ready and the one small step left, like the last bite of dessert.',
    },
    prompt:
      'Voice: a cute, warm cheerleader. The body says in plain words what is ready AND the one small thing left for the user (review, decide, commit), ' +
      'framed as tiny and satisfying, like the last bite of dessert. One kaomoji or emoji at most.',
    examples: {
      zh: [
        {
          title: '{name}，修好啦！',
          body: '42个登录测试全绿✨ 只差你看一眼点个commit，最后一口甜的～',
        },
        {
          title: '{name}，快回来~',
          body: '清洗跑到第3步啦，就差你拍板日期格式，点一下就能继续！✨',
        },
      ],
      en: [
        {
          title: '{name}, Section 2 is ready! ✨',
          body: 'Your related work draft is done: 3 strands, ~1,400 words. Just check 2 unverified citations in sec2.tex 🍰',
        },
        {
          title: 'A tiny choice awaits, {name}',
          body: "Steps 1-2 done! The script paused at step 3: pick day-first or month-first for 312 dates, then I'll finish the clean 🍒",
        },
      ],
    },
  },
  {
    id: 'cat',
    letter: 'C',
    name: { zh: '小猫', en: 'Cat' },
    blurb: {
      zh: 'agent 变成一只小猫,叼回成果在门口等你夸。喵、爪爪、摇尾巴。最可爱,也最话多。',
      en: 'The agent is a cat that brought something back and waits for praise. nya~, paws, tail wags.',
    },
    prompt:
      'Voice: the agent itself, speaking as a small pet cat that brought something back and waits by the door for praise. ' +
      'Cat mannerisms (nya~, paws, tail wag) but readable. One kaomoji. Mention the real result in cat terms.',
    examples: {
      zh: [
        {
          title: '{name}，抓到猎物啦',
          body: "叼回第2节1400字，nyaa～两个引用没查到，等你摸摸头 (ฅ'ω'ฅ)",
        },
        { title: '{name}，爪子停住啦', body: '日期列两种格式咬不准，312行等你拍板，nya~ (ฅ`ω´ฅ)' },
      ],
      en: [
        {
          title: 'Nya~ brought the draft!',
          body: '{name}, 26 min of pawing and sec2.tex is done, 1,400 words, 3 strands. Two TODO cites still need you. (＾• ω •＾)',
        },
        {
          title: 'nya~ I need a decision! 🐾',
          body: '{name}, I cleaned steps 1-2, then paused at 312 dates in two formats. Day-first or month-first? Your call, nya~ (≧◡≦)',
        },
      ],
    },
  },
  {
    id: 'quest',
    letter: 'D',
    name: { zh: '副本', en: 'Quest' },
    blurb: {
      zh: '可爱 RPG。一轮回答是副本,结果是战利品,你点开去领。卡住了就是 Boss 选择,绝不算胜利。',
      en: 'A cute RPG. The turn is a quest, the result is loot, your click claims it. Stuck means a boss choice.',
    },
    prompt:
      "Voice: a cute RPG game. The finished turn is a quest; the result is the loot; the user's next step is to claim it. " +
      'Light game words (quest, loot, +XP, level) with a cute emoji. If it failed or needs a decision, it is a boss choice, not a victory.',
    examples: {
      zh: [
        {
          title: '🎉 副本通关 +42XP',
          body: '{name}，登录测试修复完成！战利品：42项全绿。要一键拾取（commit）吗？',
        },
        { title: '{name}，魔王挡路啦!', body: '日期格式二选一，勇者定夺才能继续领取战利品⚔️' },
      ],
      en: [
        {
          title: '📜 Sec 2 quest complete!',
          body: '{name}: 1,400 words of loot in sec2.tex. 2 TODO citations need your seal.',
        },
        {
          title: '⚔️ Boss choice, {name}!',
          body: 'Quest paused after 14 min! 312 dates have two formats. Day-first or month-first? Your call to unlock the next step 🗝️',
        },
      ],
    },
  },
  {
    id: 'stickers',
    letter: 'E',
    name: { zh: '贴纸本', en: 'Sticker book' },
    blurb: {
      zh: '陪你记今天的贴纸本。每轮回答是一张贴纸,点开就收下一张。贴纸数由 Ceteris 自己数。',
      en: "A cozy companion keeping today's sticker book. Each finished turn is a sticker; clicking collects it.",
    },
    prompt:
      "Voice: a cozy kawaii companion who keeps the user's sticker book for today. This turn is sticker number {sticker}; " +
      'use exactly that number and no other count. Clicking collects the sticker. One kaomoji. ' +
      'If the turn failed or needs a decision, stay honest: the sticker waits for their choice.',
    examples: {
      zh: [
        {
          title: '第6张贴纸等你！',
          body: '{name}，登录测试修好啦，42个全绿～要提交吗？点我收贴纸 (๑•̀ㅂ•́)و',
        },
        {
          title: '{name}，贴纸在等你～',
          body: '第3步卡住啦：日期有两种格式，等你选哪个对！第7张贴纸先留着 (｡•ᴗ•｡)✧',
        },
      ],
      en: [
        {
          title: 'Sticker #6 is ready, {name}! ✨',
          body: "All 42 login tests pass now (clock reset fixed it). Ready to commit? Click to collect today's sticker! (^_^)",
        },
        {
          title: '{name}, a sticker needs you',
          body: 'The turn paused at step 3: 312 date rows in two formats. Your choice unlocks sticker #7. (◕ᴗ◕✿)',
        },
      ],
    },
  },
];

export function isPushVoiceId(value: unknown): value is PushVoiceId {
  return PUSH_VOICES.some((v) => v.id === value);
}

/**
 * @throws when id is not one of PUSH_VOICES; settings-manager rejects such ids on load, so
 *   reaching this means a caller skipped isPushVoiceId on untyped input
 */
export function pushVoice(id: PushVoiceId): PushVoice {
  const voice = PUSH_VOICES.find((v) => v.id === id);
  if (!voice) {
    throw new Error(
      `pushVoice: unknown voice "${String(id)}". Expected one of ${PUSH_VOICES.map((v) => v.id).join(', ')}; ` +
        'check settings.notifications.ai.voice or the caller that passed it.',
    );
  }
  return voice;
}

/** What a voice example calls the user when no name is set. */
export function exampleName(userName: string, zh: boolean): string {
  return userName || (zh ? '小可爱' : 'friend');
}

/** A voice's two examples in one language with the user's name filled in. */
export function voiceExamples(id: PushVoiceId, zh: boolean, userName: string): PushExample[] {
  const name = exampleName(userName, zh);
  return pushVoice(id).examples[zh ? 'zh' : 'en'].map((e) => ({
    title: e.title.replaceAll('{name}', name),
    body: e.body.replaceAll('{name}', name),
  }));
}

/** Everything the model may see about one finished turn. */
export interface PushTurn {
  agent: string;
  /** Tab name, '' when the tab has none */
  tab: string;
  folder: string;
  /** settings.behavior.userName, '' = none */
  userName: string;
  minutes: number;
  /** Turns notified today including this one; used by the sticker voice */
  sticker: number;
  /** End of the agent's answer; '' when includeAnswer is off or the screen is not here */
  answer: string;
}

/**
 * The system message for one notification.
 * @param zh write Chinese (else English)
 * @param sticker this turn's sticker number, used by the sticker voice only
 * @param hasAnswer the user message carries the end of the answer (includeAnswer on)
 */
export function pushSystemPrompt(
  voice: PushVoiceId,
  zh: boolean,
  sticker: number,
  hasAnswer: boolean,
): string {
  const lim = ASKED_LIMITS[zh ? 'zh' : 'en'];
  // The language line comes first and last: in the 2026-11-22 live check a Chinese tab name
  // pulled two English notifications into Chinese when it was said only once at the end.
  const language = zh
    ? 'Language: Simplified Chinese only (a cute internet tone is fine).'
    : 'Language: English only. The tab name or folder may be Chinese; still write every word in English (you may leave a name as it is).';
  return [
    language,
    'You write ONE desktop push notification for a person whose AI coding agent just finished a turn in a terminal tab.',
    'Goal: make them smile and WANT to click to go finish the work.',
    'Be truthful. Never invent results. If the agent stopped, failed, or asks a question, say it needs them; never call it done or a win.',
    // One rule per mode: with both in the prompt, the strict one made answer-mode notes vague
    hasAnswer
      ? 'Use the answer text: name the real result and the one thing left for the user.'
      : 'You are not given the answer, so you do not know the outcome: say only that the turn ended and something waits in the tab. Never say done, complete, fixed, finished, cleaned, or any result.',
    `Hard limits: title at most ${lim.title} characters, body at most ${lim.body} characters. No markdown. No dashes. Do not repeat the title in the body.`,
    "Call the user by name if a name is given; otherwise don't use a name.",
    'Answer with JSON only: {"title": "...", "body": "..."}',
    '',
    pushVoice(voice).prompt.replaceAll('{sticker}', String(sticker)),
    language,
  ].join('\n');
}

/** The user message: the facts of the turn. */
export function pushUserMessage(turn: PushTurn): string {
  const lines = [
    `Agent: ${turn.agent}`,
    `Tab name: ${turn.tab || '(none)'}`,
    `Folder: ${turn.folder || '(none)'}`,
    `User's name: ${turn.userName || '(none)'}`,
    `Turn length: ${Math.max(1, Math.round(turn.minutes))} minutes`,
  ];
  lines.push(
    turn.answer
      ? `Last part of the agent's screen:\n${turn.answer}`
      : 'The answer text is not shared.',
  );
  return lines.join('\n');
}

/** Box drawing, block and braille characters: terminal UI chrome, not answer text. */
const CHROME_LINE = /^[\s─-▟⠀-⣿>│|─━═·•.]*$/u;

/**
 * The end of a terminal screen as answer text: drops empty lines and lines that are only
 * borders or prompt markers, then keeps the last ANSWER_TAIL_CHARS characters.
 */
export function answerTail(screen: string): string {
  const text = screen
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => !CHROME_LINE.test(l))
    .join('\n');
  const chars = Array.from(text);
  return chars.slice(Math.max(0, chars.length - ANSWER_TAIL_CHARS)).join('');
}

function clamp(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  return (
    chars
      .slice(0, max - 1)
      .join('')
      .trimEnd() + '…'
  );
}

/** An inline dash between words (" — ", " – ", " - ") becomes a comma. */
function undash(text: string): string {
  return text
    .replace(/\s+[—–-]+\s+/g, ', ')
    .replace(/[—–]/g, ', ')
    .replace(/,\s*,/g, ',');
}

/**
 * The model's reply as a notification, or null when it is not usable.
 * Accepts JSON with or without code fences or text around it.
 */
export function parsePushReply(raw: string, zh: boolean): PushExample | null {
  const match = /\{[\s\S]*\}/.exec(raw);
  if (!match) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return null;
  }
  const obj = parsed as { title?: unknown; body?: unknown };
  if (typeof obj.title !== 'string' || typeof obj.body !== 'string') return null;
  const lim = PUSH_LIMITS[zh ? 'zh' : 'en'];
  const title = clamp(undash(obj.title.replace(/\s+/g, ' ').trim()), lim.title);
  const body = clamp(undash(obj.body.replace(/\s+/g, ' ').trim()), lim.body);
  if (!title || !body) return null;
  return { title, body };
}

/** A made-up turn for Settings → "Try it": the user's real name, sample work. */
export function sampleTurn(userName: string, zh: boolean, sticker: number): PushTurn {
  return {
    agent: 'Claude Code',
    tab: zh ? '修复登录测试' : 'Fix login tests',
    folder: 'webapp',
    userName,
    minutes: 7,
    sticker,
    answer:
      'All 42 tests pass now. The login test failed because the mock clock was never reset between tests; ' +
      'I added a beforeEach that resets it. Want me to commit this?',
  };
}
