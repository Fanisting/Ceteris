/**
 * @file src/shared/push-voice.test.ts
 * @purpose One test per rule of the AI voice notifications (ADR-057): reply parsing, length
 *   clamps, dashes, screen tail, prompts and the Settings examples.
 */
import { describe, expect, it } from 'vitest';
import {
  ANSWER_TAIL_CHARS,
  answerTail,
  isPushVoiceId,
  parsePushReply,
  PUSH_LIMITS,
  PUSH_VOICES,
  pushSystemPrompt,
  pushUserMessage,
  sampleTurn,
  voiceExamples,
} from './push-voice';

describe('parsePushReply', () => {
  it('reads plain JSON', () => {
    expect(parsePushReply('{"title":"修好啦","body":"42个测试全绿"}', true)).toEqual({
      title: '修好啦',
      body: '42个测试全绿',
    });
  });

  it('reads JSON inside a code fence or with text around it', () => {
    const raw = 'Sure!\n```json\n{"title": "Done", "body": "All green"}\n```';
    expect(parsePushReply(raw, false)).toEqual({ title: 'Done', body: 'All green' });
  });

  it('gives null for no JSON, broken JSON, missing or empty fields', () => {
    expect(parsePushReply('no json here', false)).toBeNull();
    expect(parsePushReply('{"title": "x", "body": ', false)).toBeNull();
    expect(parsePushReply('{"title": "x"}', false)).toBeNull();
    expect(parsePushReply('{"title": 1, "body": "b"}', false)).toBeNull();
    expect(parsePushReply('{"title": "  ", "body": "b"}', false)).toBeNull();
  });

  it('clamps to the toast limits with an ellipsis, counting characters not bytes', () => {
    const long = '喵'.repeat(100);
    const zh = parsePushReply(JSON.stringify({ title: long, body: long }), true);
    expect(Array.from(zh?.title ?? '')).toHaveLength(PUSH_LIMITS.zh.title);
    expect(Array.from(zh?.body ?? '')).toHaveLength(PUSH_LIMITS.zh.body);
    expect(zh?.title.endsWith('…')).toBe(true);
    const en = parsePushReply(
      JSON.stringify({ title: 'a'.repeat(200), body: 'b'.repeat(300) }),
      false,
    );
    expect(en?.title.length).toBe(PUSH_LIMITS.en.title);
    expect(en?.body.length).toBe(PUSH_LIMITS.en.body);
  });

  it('turns inline dashes into commas and keeps hyphens inside words', () => {
    const r = parsePushReply(
      '{"title":"Done — nya","body":"Steps 1-2 done – the day-first pick is yours - go"}',
      false,
    );
    expect(r).toEqual({
      title: 'Done, nya',
      body: 'Steps 1-2 done, the day-first pick is yours, go',
    });
  });

  it('collapses newlines and runs of spaces', () => {
    expect(parsePushReply('{"title":"a\\n b","body":"c   d"}', false)).toEqual({
      title: 'a b',
      body: 'c d',
    });
  });
});

describe('answerTail', () => {
  it('drops empty lines, borders and bare prompt markers', () => {
    const screen = ['All 42 tests pass.', '', '────────────', '│ > │', '>', 'Commit?', '  '].join(
      '\n',
    );
    expect(answerTail(screen)).toBe('All 42 tests pass.\nCommit?');
  });

  it('keeps only the last ANSWER_TAIL_CHARS characters', () => {
    const tail = answerTail('x'.repeat(1000) + 'END');
    expect(Array.from(tail)).toHaveLength(ANSWER_TAIL_CHARS);
    expect(tail.endsWith('END')).toBe(true);
  });

  it('gives an empty string for an empty screen', () => {
    expect(answerTail('')).toBe('');
  });
});

describe('prompts', () => {
  it('the system prompt carries the voice, the language and the honesty rule', () => {
    const zh = pushSystemPrompt('cat', true, 1, true);
    expect(zh).toContain('cat');
    expect(zh).toContain('Simplified Chinese');
    expect(zh).toMatch(/never call it done/);
    expect(pushSystemPrompt('cat', false, 1, true)).toContain('English only');
  });

  it('the sticker voice gets the count from Ceteris', () => {
    expect(pushSystemPrompt('stickers', false, 6, true)).toContain('sticker number 6');
    expect(pushSystemPrompt('mascot', false, 6, true)).not.toContain('sticker number');
  });

  it('names only forbids claiming a result; with the answer it asks for the real one', () => {
    const namesOnly = pushSystemPrompt('quest', false, 1, false);
    expect(namesOnly).toContain('Never say done, complete, fixed, finished');
    expect(namesOnly).not.toContain('Use the answer text');
    const withAnswer = pushSystemPrompt('quest', false, 1, true);
    expect(withAnswer).toContain('Use the answer text');
    expect(withAnswer).not.toContain('Never say done, complete');
  });

  it('states the language first and last, so a Chinese tab name does not switch it', () => {
    const lines = pushSystemPrompt('nudge', false, 1, true).split('\n');
    expect(lines[0]).toMatch(/^Language: English only/);
    expect(lines[lines.length - 1]).toBe(lines[0]);
  });

  it('the user message says when the answer is not shared', () => {
    const turn = { ...sampleTurn('Alex', false, 1), answer: '' };
    const msg = pushUserMessage(turn);
    expect(msg).toContain("User's name: Alex");
    expect(msg).toContain('The answer text is not shared.');
    expect(pushUserMessage(sampleTurn('', false, 1))).toContain('All 42 tests pass now.');
  });

  it('rounds minutes and shows at least 1', () => {
    expect(pushUserMessage({ ...sampleTurn('', false, 1), minutes: 0.2 })).toContain(
      'Turn length: 1 minutes',
    );
  });
});

describe('voices', () => {
  it('has five voices A to E with ids that pass isPushVoiceId', () => {
    expect(PUSH_VOICES.map((v) => v.letter)).toEqual(['A', 'B', 'C', 'D', 'E']);
    for (const v of PUSH_VOICES) expect(isPushVoiceId(v.id)).toBe(true);
    expect(isPushVoiceId('kitten')).toBe(false);
    expect(isPushVoiceId(undefined)).toBe(false);
  });

  it('fills the user name into the examples, or a friendly word when there is none', () => {
    const [done] = voiceExamples('mascot', true, 'Alex');
    expect(done?.title).toContain('Alex');
    expect(voiceExamples('mascot', true, '')[0]?.title).toContain('小可爱');
    expect(voiceExamples('cat', false, '')[0]?.body).toContain('friend');
    for (const v of PUSH_VOICES) {
      for (const e of [
        ...voiceExamples(v.id, true, 'Alex'),
        ...voiceExamples(v.id, false, 'Alex'),
      ]) {
        expect(e.title + e.body).not.toContain('{name}');
      }
    }
  });

  it('every example fits the toast limits, so the preview matches what can pop up', () => {
    for (const v of PUSH_VOICES) {
      for (const zh of [true, false]) {
        const lim = PUSH_LIMITS[zh ? 'zh' : 'en'];
        for (const e of voiceExamples(v.id, zh, 'Alexandra')) {
          expect(Array.from(e.title).length).toBeLessThanOrEqual(lim.title);
          expect(Array.from(e.body).length).toBeLessThanOrEqual(lim.body);
        }
      }
    }
  });
});
