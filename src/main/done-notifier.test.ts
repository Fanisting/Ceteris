/**
 * @file src/main/done-notifier.test.ts
 * @purpose One test per rule of DoneNotifier (ADR-048) and its AI voice (ADR-057).
 */
import { describe, expect, it, vi } from 'vitest';
import type { AgentPhase, SessionInfo } from '@shared/types';
import type { SessionStateChangedPayload } from '@shared/protocol';
import type { PushExample, PushTurn } from '@shared/push-voice';
import {
  DONE_SETTLE_MS,
  DoneNotifier,
  MIN_BLIND_TURN_MS,
  type DoneNotifierVoice,
  type NotificationRequest,
  type NotifyTarget,
  TabHolders,
} from './done-notifier';

function makeNotifier(
  opts: { enabled?: boolean; zh?: boolean; userName?: string; voice?: DoneNotifierVoice } = {},
) {
  let now = 1_000;
  let enabled = opts.enabled ?? true;
  const timers: Array<{ fn: () => void; at: number } | null> = [];
  const shown: NotificationRequest[] = [];
  const notifier = new DoneNotifier({
    enabled: () => enabled,
    show: (r) => {
      shown.push(r);
      return true;
    },
    chinese: () => opts.zh ?? false,
    templateName: (id) => (id === 'claude-code' ? 'Claude Code' : null),
    userName: () => opts.userName ?? '',
    ...(opts.voice ? { voice: opts.voice } : {}),
    now: () => now,
    setTimer: (fn, ms) => timers.push({ fn, at: now + ms }) - 1,
    clearTimer: (t) => {
      timers[t as number] = null;
    },
  });
  const advance = (ms: number): void => {
    now += ms;
    timers.forEach((t, i) => {
      if (t && t.at <= now) {
        timers[i] = null;
        t.fn();
      }
    });
  };
  return { notifier, shown, advance, setEnabled: (v: boolean) => (enabled = v) };
}

function payload(
  phase: AgentPhase | null,
  extra: Partial<SessionInfo> = {},
): SessionStateChangedPayload {
  const full = {
    id: 's1',
    templateId: 'claude-code',
    displayName: 'Fix login',
    originalCwd: 'C:/work/app',
    currentCwd: 'C:/work/app',
    state: phase === 'working' ? 'active' : 'idle',
    agentPhase: phase,
    notifyOnDone: true,
    ...extra,
  } as SessionInfo;
  return { sessionId: full.id, changes: { agentPhase: phase }, full };
}

function makeTarget(enterAt: number | null = 500, inFront = false) {
  const focus = vi.fn();
  const target: NotifyTarget = {
    holderInFront: () => inFront,
    focus,
    ...(enterAt === null ? {} : { lastEnterAt: () => enterAt }),
  };
  return { target, focus };
}

/** A turn: done (start), working, then done; settles unless told not to. */
function turn(
  n: ReturnType<typeof makeNotifier>,
  target: NotifyTarget,
  opts: { workMs?: number; extra?: Partial<SessionInfo> } = {},
): void {
  n.notifier.observe(payload('done', opts.extra), target);
  n.notifier.observe(payload('working', opts.extra), target);
  n.advance(opts.workMs ?? 1000);
  n.notifier.observe(payload('done', opts.extra), target);
  n.advance(DONE_SETTLE_MS);
}

describe('DoneNotifier (ADR-048)', () => {
  it('notifies when a belled tab goes working → done, and the click focuses the tab', () => {
    const n = makeNotifier();
    const { target, focus } = makeTarget();
    turn(n, target);
    expect(n.shown).toHaveLength(1);
    expect(n.shown[0]!.title).toBe('Fix login');
    expect(n.shown[0]!.body).toContain('Claude Code finished in app');
    n.shown[0]!.onClick();
    expect(focus).toHaveBeenCalledOnce();
  });

  it('writes Chinese text when the interface is Chinese', () => {
    const n = makeNotifier({ zh: true });
    turn(n, makeTarget().target);
    expect(n.shown[0]!.body).toContain('Claude Code 回答完了 · app');
  });

  it('ends the first sentence with the user name when one is set (ADR-052)', () => {
    const n = makeNotifier({ userName: 'Alex' });
    turn(n, makeTarget().target);
    expect(n.shown[0]!.body).toBe('Claude Code finished in app, Alex. Click to open the tab.');
  });

  it('stays quiet when the tab bell is off (the default)', () => {
    const n = makeNotifier();
    turn(n, makeTarget().target, { extra: { notifyOnDone: false } });
    expect(n.shown).toEqual([]);
  });

  it('stays quiet when the master switch is off', () => {
    const n = makeNotifier({ enabled: false });
    turn(n, makeTarget().target);
    expect(n.shown).toEqual([]);
  });

  it('stays quiet when the window holding the tab is in front', () => {
    const n = makeNotifier();
    turn(n, makeTarget(500, true).target);
    expect(n.shown).toEqual([]);
  });

  it('stays quiet when another machine notifies for the tab (null target)', () => {
    const n = makeNotifier();
    n.notifier.observe(payload('working'), null);
    n.notifier.observe(payload('done'), null);
    n.advance(DONE_SETTLE_MS);
    expect(n.shown).toEqual([]);
  });

  it('does not count the first done it sees, nor a done that was not after working', () => {
    const n = makeNotifier();
    const { target } = makeTarget();
    n.notifier.observe(payload('done'), target);
    n.notifier.observe(payload('blocked'), target);
    n.notifier.observe(payload('done'), target);
    n.advance(DONE_SETTLE_MS);
    expect(n.shown).toEqual([]);
  });

  it('waits for done to settle: work resuming within the pause cancels it', () => {
    const n = makeNotifier();
    const { target } = makeTarget();
    n.notifier.observe(payload('done'), target);
    n.notifier.observe(payload('working'), target);
    n.notifier.observe(payload('done'), target);
    n.advance(DONE_SETTLE_MS - 1);
    n.notifier.observe(payload('working'), target);
    n.advance(DONE_SETTLE_MS);
    expect(n.shown).toEqual([]);
  });

  it('needs a new Enter per notification, so a starting agent stays quiet', () => {
    const n = makeNotifier();
    let enterAt = 0;
    const target: NotifyTarget = {
      holderInFront: () => false,
      focus: () => undefined,
      lastEnterAt: () => enterAt,
    };
    turn(n, target); // welcome screen: nobody pressed Enter yet
    expect(n.shown).toHaveLength(0);
    enterAt = 2_000;
    turn(n, target);
    expect(n.shown).toHaveLength(1);
    turn(n, target); // same Enter: the agent only redrew
    expect(n.shown).toHaveLength(1);
  });

  it('without Enter times, notifies only turns that ran long enough', () => {
    const n = makeNotifier();
    const { target } = makeTarget(null);
    turn(n, target, { workMs: MIN_BLIND_TURN_MS - 1 });
    expect(n.shown).toHaveLength(0);
    turn(n, target, { workMs: MIN_BLIND_TURN_MS });
    expect(n.shown).toHaveLength(1);
  });

  it('forget drops a pending notification of a closed tab', () => {
    const n = makeNotifier();
    const { target } = makeTarget();
    n.notifier.observe(payload('done'), target);
    n.notifier.observe(payload('working'), target);
    n.notifier.observe(payload('done'), target);
    n.notifier.forget('s1');
    n.advance(DONE_SETTLE_MS);
    expect(n.shown).toEqual([]);
  });

  it('the test notification ignores both switches', () => {
    const n = makeNotifier({ enabled: false });
    expect(n.notifier.showTest()).toBe(true);
    expect(n.shown[0]!.key).toBe('test');
  });
});

describe('TabHolders (ADR-048)', () => {
  it('a tab in the background keeps the window that showed it last', () => {
    const h = new TabHolders();
    expect(h.holderOf('s', null)).toBeNull();
    h.note('s', 'w1');
    h.note('s', null); // the user clicked another tab: released
    expect(h.holderOf('s', null)).toBe('w1');
    h.note('s', 'w2');
    expect(h.holderOf('s', null)).toBe('w2');
    expect(h.holderOf('s', 'w3')).toBe('w3');
    h.forget('s');
    expect(h.holderOf('s', null)).toBeNull();
  });
});

describe('DoneNotifier voice (ADR-057)', () => {
  /** A voice whose write() resolves when the test says so. */
  function makeVoice(opts: { enabled?: boolean; includeAnswer?: boolean } = {}) {
    const calls: Array<{ turn: PushTurn; zh: boolean }> = [];
    let resolveNext: (r: { note: PushExample | null; error: string }) => void = () => undefined;
    const voice: DoneNotifierVoice = {
      enabled: () => opts.enabled ?? true,
      includeAnswer: () => opts.includeAnswer ?? true,
      write: (t, zh) => {
        calls.push({ turn: t, zh });
        return new Promise((r) => (resolveNext = r));
      },
    };
    return {
      voice,
      calls,
      reply: (r: { note: PushExample | null; error: string }) => resolveNext(r),
    };
  }
  const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

  it('voice off: the plain text goes out at once and the model is not asked', () => {
    const v = makeVoice({ enabled: false });
    const n = makeNotifier({ voice: v.voice });
    turn(n, makeTarget().target);
    expect(v.calls).toHaveLength(0);
    expect(n.shown[0]?.title).toBe('Fix login');
  });

  it('voice on: shows the title and body the model wrote', async () => {
    const v = makeVoice();
    const n = makeNotifier({ voice: v.voice });
    const { target, focus } = makeTarget();
    turn(n, target);
    expect(n.shown).toHaveLength(0);
    v.reply({ note: { title: '修好啦✧', body: '42个测试全绿' }, error: '' });
    await flush();
    expect(n.shown).toHaveLength(1);
    expect(n.shown[0]).toMatchObject({ key: 's1', title: '修好啦✧', body: '42个测试全绿' });
    n.shown[0]?.onClick();
    expect(focus).toHaveBeenCalled();
  });

  it('falls back to the plain text when the model gives nothing', async () => {
    const v = makeVoice();
    const n = makeNotifier({ voice: v.voice });
    turn(n, makeTarget().target);
    v.reply({ note: null, error: 'no reply within 4000 ms' });
    await flush();
    expect(n.shown[0]?.body).toContain('Claude Code finished in app.');
  });

  it('shows nothing when the user comes back while the model writes', async () => {
    const v = makeVoice();
    const n = makeNotifier({ voice: v.voice });
    let inFront = false;
    const target: NotifyTarget = {
      holderInFront: () => inFront,
      focus: vi.fn(),
      lastEnterAt: () => 500,
    };
    turn(n, target);
    inFront = true;
    v.reply({ note: { title: 't', body: 'b' }, error: '' });
    await flush();
    expect(n.shown).toHaveLength(0);
  });

  it('shows nothing when the next turn starts while the model writes', async () => {
    const v = makeVoice();
    const n = makeNotifier({ voice: v.voice });
    const { target } = makeTarget();
    turn(n, target);
    n.notifier.observe(payload('working'), target);
    v.reply({ note: { title: 't', body: 'b' }, error: '' });
    await flush();
    expect(n.shown).toHaveLength(0);
  });

  it('sends the screen end only when allowed and the screen is on this machine', () => {
    const allowed = makeVoice({ includeAnswer: true });
    const n1 = makeNotifier({ voice: allowed.voice });
    turn(n1, { ...makeTarget().target, screenTail: () => 'All 42 tests pass now.' });
    expect(allowed.calls[0]?.turn.answer).toBe('All 42 tests pass now.');

    const namesOnly = makeVoice({ includeAnswer: false });
    const n2 = makeNotifier({ voice: namesOnly.voice });
    const tail = vi.fn(() => 'secret screen');
    turn(n2, { ...makeTarget().target, screenTail: tail });
    expect(namesOnly.calls[0]?.turn.answer).toBe('');
    expect(tail).not.toHaveBeenCalled();

    const remote = makeVoice({ includeAnswer: true });
    const n3 = makeNotifier({ voice: remote.voice });
    turn(n3, makeTarget(null).target, { workMs: MIN_BLIND_TURN_MS });
    expect(remote.calls[0]?.turn.answer).toBe('');
  });

  it('passes the turn facts: agent, tab, folder, name, minutes', () => {
    const v = makeVoice();
    const n = makeNotifier({ voice: v.voice, zh: true, userName: 'Alex' });
    turn(n, makeTarget().target, { workMs: 3 * 60_000 });
    expect(v.calls[0]).toMatchObject({
      zh: true,
      turn: { agent: 'Claude Code', tab: 'Fix login', folder: 'app', userName: 'Alex', minutes: 3 },
    });
  });

  it('counts stickers per day: 1, 2, then 1 again the next day', () => {
    const v = makeVoice();
    const n = makeNotifier({ voice: v.voice });
    let enterAt = 500;
    const target: NotifyTarget = {
      holderInFront: () => false,
      focus: vi.fn(),
      lastEnterAt: () => enterAt,
    };
    turn(n, target);
    enterAt = 600;
    turn(n, target);
    n.advance(24 * 60 * 60 * 1000);
    enterAt = 700;
    turn(n, target);
    expect(v.calls.map((c) => c.turn.sticker)).toEqual([1, 2, 1]);
  });

  it('showVoiceTest shows the model text, or the plain test with the reason', async () => {
    const v = makeVoice();
    const n = makeNotifier({ voice: v.voice });
    const first = n.notifier.showVoiceTest();
    v.reply({ note: { title: 'Sticker #1', body: 'yay' }, error: '' });
    expect(await first).toEqual({ shown: true, written: true, error: '' });
    expect(n.shown[0]).toMatchObject({ key: 'test', title: 'Sticker #1' });

    const second = n.notifier.showVoiceTest();
    v.reply({ note: null, error: 'no OpenRouter key connected' });
    expect(await second).toEqual({
      shown: true,
      written: false,
      error: 'no OpenRouter key connected',
    });
    expect(n.shown[1]?.title).toBe('Ceteris notifications');
  });
});
