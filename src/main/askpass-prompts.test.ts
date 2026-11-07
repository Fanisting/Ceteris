/**
 * @file src/main/askpass-prompts.test.ts
 * @purpose PromptBroker:提示送达窗口、答案配对、超时、中止、窗口不存在。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EVENT_CHANNELS, type AskpassPromptPayload } from '@shared/protocol';
import { PromptBroker, type PromptRequest } from './askpass-prompts';

vi.mock('./logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const payload: PromptRequest['payload'] = {
  profileId: 'p1',
  profileName: 'PARCC',
  host: 'hpc.example',
  username: 'me',
  kind: 'text',
  prompt: 'Passcode or option (1-3): ',
  detail: '1. Duo Push',
};

function createBroker(deliverable = true) {
  const sent: Array<{ windowId: string; channel: string; payload: unknown }> = [];
  const broker = new PromptBroker({
    send: (windowId, channel, p) => {
      sent.push({ windowId, channel, payload: p });
      return deliverable;
    },
  });
  return { broker, sent };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('PromptBroker', () => {
  it('把提示发给指定窗口,答案按 promptId 配对', async () => {
    const { broker, sent } = createBroker();
    const asking = broker.ask({ windowId: 'w1', payload });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ windowId: 'w1', channel: EVENT_CHANNELS.SSH_ASKPASS_PROMPT });
    const { promptId } = sent[0]?.payload as AskpassPromptPayload;
    expect(sent[0]?.payload).toMatchObject(payload);
    expect(broker.pendingCount).toBe(1);
    expect(broker.answer(promptId, '1')).toBe(true);
    expect(await asking).toBe('1');
    expect(broker.pendingCount).toBe(0);
  });

  it('用户取消时答案为 null', async () => {
    const { broker, sent } = createBroker();
    const asking = broker.ask({ windowId: 'w1', payload });
    const { promptId } = sent[0]?.payload as AskpassPromptPayload;
    broker.answer(promptId, null);
    expect(await asking).toBeNull();
  });

  it('错误的、重复的和迟到的答案忽略', async () => {
    const { broker, sent } = createBroker();
    const asking = broker.ask({ windowId: 'w1', payload });
    const { promptId } = sent[0]?.payload as AskpassPromptPayload;
    expect(broker.answer('other', 'x')).toBe(false);
    expect(broker.answer(promptId, 'first')).toBe(true);
    expect(broker.answer(promptId, 'second')).toBe(false);
    expect(await asking).toBe('first');
  });

  it('窗口已不存在时立刻 null,不留挂起', async () => {
    const { broker } = createBroker(false);
    expect(await broker.ask({ windowId: 'gone', payload })).toBeNull();
    expect(broker.pendingCount).toBe(0);
  });

  it('没有窗口可弹时 null', async () => {
    const { broker, sent } = createBroker();
    expect(await broker.ask({ windowId: null, payload })).toBeNull();
    expect(sent).toHaveLength(0);
  });

  it('超时后 null,并通知窗口收起', async () => {
    vi.useFakeTimers();
    const { broker, sent } = createBroker();
    const asking = broker.ask({ windowId: 'w1', payload, timeoutMs: 1000 });
    const { promptId } = sent[0]?.payload as AskpassPromptPayload;
    await vi.advanceTimersByTimeAsync(1001);
    expect(await asking).toBeNull();
    expect(sent[1]).toEqual({
      windowId: 'w1',
      channel: EVENT_CHANNELS.SSH_ASKPASS_CLOSED,
      payload: { promptId },
    });
    expect(broker.answer(promptId, 'late')).toBe(false);
  });

  it('中止信号让等待结束并通知窗口', async () => {
    const { broker, sent } = createBroker();
    const abort = new AbortController();
    const asking = broker.ask({ windowId: 'w1', payload, signal: abort.signal });
    abort.abort();
    expect(await asking).toBeNull();
    expect(sent[1]?.channel).toBe(EVENT_CHANNELS.SSH_ASKPASS_CLOSED);
  });

  it('已经中止的信号直接 null,不发任何事件', async () => {
    const { broker, sent } = createBroker();
    const abort = new AbortController();
    abort.abort();
    expect(await broker.ask({ windowId: 'w1', payload, signal: abort.signal })).toBeNull();
    expect(sent).toHaveLength(0);
  });
});
