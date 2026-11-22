/**
 * @file src/main/done-notifier.ts
 * @purpose System notifications when an agent tab finishes a turn (ADR-048). A click on the
 *   notification brings up the window that holds the tab and selects it.
 *
 * @关键设计:
 * - Two switches, both needed: settings.notifications.enabled (the master, on by default)
 *   and the tab's bell, SessionInfo.notifyOnDone (off by default). Nothing shows until the
 *   user turns a bell on.
 * - A finished turn is agentPhase going 'working' → 'done' (ADR-021), the same signal as the
 *   done dot. The notification waits DONE_SETTLE_MS and shows only if the tab is still done:
 *   between two tool calls an agent can look done for a moment.
 * - An answer needs a question. Where the target knows when Enter was last pressed in the
 *   tab (a tab on this machine), a turn counts only after an Enter that no earlier
 *   notification covered, so the welcome screen of a starting or restored agent stays
 *   quiet. Where it does not (a tab on a Link Host), the turn must have run MIN_BLIND_TURN_MS.
 * - Which window holds a tab: the one that showed it last (TabHolders). A window owns only
 *   the tab it shows (软件定义书 8.4, single focus owner), so a tab in the background has
 *   no owner; the last owner is where the user left it.
 * - Which machine shows it: the one with that window. A tab last shown in a Link client's
 *   window (a virtual window on the Host) notifies on the client, through observe() fed
 *   from link-client.ts, and the Host stays quiet. The caller passes a target or null.
 * - No notification while the holding window is in front, checked when it fires: the user
 *   is in that Ceteris window and its done dot shows there.
 * - ADR-057 voice: when deps.voice is on, the title and body come from a model (see
 *   push-voice-client.ts). The checks run before the call and again after it, since the
 *   user may come back or start the next turn while the model writes; the plain text goes
 *   out whenever the model gives nothing. The answer's screen end is read only when the user
 *   allowed it (includeAnswer) and the tab is on this machine (target.screenTail).
 * - Stickers: turns notified today on this machine, counted here so the count is right
 *   whatever the model says. Resets at local midnight; not saved across restarts.
 *
 * @对应文档章节:软件定义书.md ADR-048, ADR-021, ADR-057
 *
 * @不要在这里做的事:
 * - No Electron imports: show() and the targets are injected, so the rules run in tests.
 * - Do not read the screen; agentPhase is SessionManager's job.
 */
import type { AgentPhase, SessionInfo } from '@shared/types';
import type { SessionStateChangedPayload } from '@shared/protocol';
import { withUserName } from '@shared/user-name';
import { answerTail, sampleTurn, type PushExample, type PushTurn } from '@shared/push-voice';
import { logger } from './logger';

/** How long a tab must stay done before the notification shows. */
export const DONE_SETTLE_MS = 1500;
/** Without Enter times (a tab on a Link Host), a turn shorter than this is not notified. */
export const MIN_BLIND_TURN_MS = 5000;

export interface NotificationRequest {
  /** Groups notifications: a new one for the same key replaces the old one. */
  key: string;
  title: string;
  body: string;
  onClick: () => void;
}

export interface DoneNotifierDeps {
  /** settings.notifications.enabled of this machine */
  enabled(): boolean;
  /**
   * Shows a system notification.
   * @returns false when the system has no notification service
   */
  show(request: NotificationRequest): boolean;
  /** true for Chinese text, from settings.appearance.language or the system locale */
  chinese(): boolean;
  /** Display name of a template, null when this machine does not know it */
  templateName(templateId: string): string | null;
  /** ADR-052:settings.behavior.userName, added to the end of the first sentence. '' = none */
  userName?: () => string;
  /** ADR-057: AI-written text; absent = always the plain text */
  voice?: DoneNotifierVoice;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

export interface DoneNotifierVoice {
  /** settings.notifications.ai.enabled */
  enabled(): boolean;
  /** settings.notifications.ai.includeAnswer: send the end of the screen */
  includeAnswer(): boolean;
  /**
   * Writes the notification for one turn in the chosen voice.
   * @returns the text, or null with a reason; must not throw
   */
  write(turn: PushTurn, zh: boolean): Promise<{ note: PushExample | null; error: string }>;
}

/** Where a tab lives, as far as notifying goes. */
export interface NotifyTarget {
  /** True when the window holding the tab is focused; its done dot is on screen. */
  holderInFront(): boolean;
  /** Focuses the window holding the tab (or a new one) and selects the tab. */
  focus(): void;
  /** When Enter was last pressed in the tab, in ms (0 = never). Absent when unknown. */
  lastEnterAt?: () => number;
  /** The end of the tab's screen; absent when the screen is on another machine. */
  screenTail?: () => string;
}

interface TabWatch {
  phase: AgentPhase | null;
  /** When the current 'working' stretch began */
  workingSince: number;
  /** The Enter time the last notification covered */
  notifiedEnterAt: number;
  timer: unknown;
  info: SessionInfo;
}

export class DoneNotifier {
  private readonly tabs = new Map<string, TabWatch>();
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (timer: unknown) => void;
  /** Stickers given today: local date key and count */
  private stickerDay = '';
  private stickers = 0;

  constructor(private readonly deps: DoneNotifierDeps) {
    this.now = deps.now ?? Date.now;
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  }

  /**
   * Feeds one sessionStateChanged event.
   *
   * @param target how to reach the tab, or null when another machine notifies for it; the
   *   phase is still tracked so a later event compares against the right state
   */
  observe(payload: SessionStateChangedPayload, target: NotifyTarget | null): void {
    const info = payload.full;
    const phase = info.agentPhase ?? null;
    let tab = this.tabs.get(info.id);
    if (!tab) {
      tab = { phase, workingSince: 0, notifiedEnterAt: 0, timer: null, info };
      this.tabs.set(info.id, tab);
      if (phase === 'working') tab.workingSince = this.now();
      return;
    }
    tab.info = info;
    const before = tab.phase;
    tab.phase = phase;
    if (phase === before) return;
    if (phase === 'working') tab.workingSince = this.now();
    if (phase !== 'done') {
      this.cancel(tab);
      return;
    }
    if (before !== 'working' || !target) return;
    const worked = this.now() - tab.workingSince;
    this.cancel(tab);
    tab.timer = this.setTimer(() => {
      tab.timer = null;
      this.fire(tab, target, worked);
    }, DONE_SETTLE_MS);
  }

  /** The tab closed. */
  forget(sessionId: string): void {
    const tab = this.tabs.get(sessionId);
    if (tab) this.cancel(tab);
    this.tabs.delete(sessionId);
  }

  /**
   * Settings, Notifications, "Send a test notification". Ignores the switches: the point is
   * to see whether the system lets Ceteris notify at all.
   * @returns false when the system has no notification service
   */
  showTest(): boolean {
    const zh = this.deps.chinese();
    return this.deps.show({
      key: 'test',
      title: zh ? 'Ceteris 通知' : 'Ceteris notifications',
      body: zh
        ? '通知能正常显示。打开标签的铃铛后,agent 回答完会这样提醒你。'
        : 'Notifications work. With a tab’s bell on, you get one like this when its agent finishes.',
      onClick: () => undefined,
    });
  }

  /**
   * Settings, Notifications, voice "Try it": a made-up turn written by the model in the
   * chosen voice and shown as a real notification. Ignores the switches, like showTest.
   * @returns shown = false when the system has no notification service; written = false
   *   when the model gave nothing and the plain test text went out, with the reason in error
   */
  async showVoiceTest(): Promise<{ shown: boolean; written: boolean; error: string }> {
    const voice = this.deps.voice;
    if (!voice) return { shown: this.showTest(), written: false, error: 'voice not set up' };
    const zh = this.deps.chinese();
    const turn = sampleTurn(this.deps.userName?.() ?? '', zh, this.peekSticker() + 1);
    const { note, error } = await voice.write(turn, zh);
    if (!note) return { shown: this.showTest(), written: false, error };
    const shown = this.deps.show({ key: 'test', ...note, onClick: () => undefined });
    return { shown, written: true, error: '' };
  }

  private fire(tab: TabWatch, target: NotifyTarget, worked: number): void {
    const { info } = tab;
    if (tab.phase !== 'done' || !info.notifyOnDone || !this.deps.enabled()) return;
    if (target.lastEnterAt) {
      const enterAt = target.lastEnterAt();
      if (enterAt <= tab.notifiedEnterAt) return;
      tab.notifiedEnterAt = enterAt;
    } else if (worked < MIN_BLIND_TURN_MS) {
      return;
    }
    if (target.holderInFront()) return;
    const zh = this.deps.chinese();
    const agent = this.deps.templateName(info.templateId) ?? 'Agent';
    const folder = folderName(info.currentCwd || info.originalCwd);
    const userName = this.deps.userName?.() ?? '';
    const plain: PushExample = {
      title: info.displayName || agent,
      body:
        withUserName(
          zh
            ? `${agent} 回答完了${folder ? ` · ${folder}` : ''}。`
            : `${agent} finished${folder ? ` in ${folder}` : ''}.`,
          userName,
          zh,
        ) + (zh ? '点这里打开这个标签。' : ' Click to open the tab.'),
    };
    const sticker = this.nextSticker();
    const voice = this.deps.voice;
    if (!voice?.enabled()) {
      this.show(tab, target, plain, 'plain');
      return;
    }
    const turn: PushTurn = {
      agent,
      tab: info.displayName ?? '',
      folder,
      userName,
      minutes: worked / 60_000,
      sticker,
      answer: voice.includeAnswer() && target.screenTail ? answerTail(target.screenTail()) : '',
    };
    void voice.write(turn, zh).then(({ note, error }) => {
      // The user may have come back, or started the next turn, while the model wrote
      if (this.tabs.get(info.id) !== tab || !this.shouldShow(tab, target)) return;
      if (!note) logger.warn('DoneNotifier', `voice fell back sid=${info.id}: ${error}`);
      this.show(tab, target, note ?? plain, note ? 'voice' : 'plain');
    });
  }

  /** The switches, the phase and the window in front: all must allow a notification. */
  private shouldShow(tab: TabWatch, target: NotifyTarget): boolean {
    return (
      tab.phase === 'done' &&
      !!tab.info.notifyOnDone &&
      this.deps.enabled() &&
      !target.holderInFront()
    );
  }

  private show(tab: TabWatch, target: NotifyTarget, text: PushExample, kind: string): void {
    const shown = this.deps.show({ key: tab.info.id, ...text, onClick: () => target.focus() });
    logger.info('DoneNotifier', `turn done sid=${tab.info.id} shown=${shown} text=${kind}`);
  }

  /** Counts this turn's sticker and returns its number (1 = first today). */
  private nextSticker(): number {
    this.stickers = this.peekSticker() + 1;
    return this.stickers;
  }

  /** Stickers given so far today, reset at local midnight. */
  private peekSticker(): number {
    const d = new Date(this.now());
    const day = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
    if (day !== this.stickerDay) {
      this.stickerDay = day;
      this.stickers = 0;
    }
    return this.stickers;
  }

  private cancel(tab: TabWatch): void {
    if (tab.timer !== null) this.clearTimer(tab.timer);
    tab.timer = null;
  }
}

/**
 * The window that showed each tab last. Owners come and go as the user clicks between tabs
 * (a background tab's owner is null); this keeps the last one that was not null.
 */
export class TabHolders {
  private readonly last = new Map<string, string>();

  /** Records an owner seen in an event; null (released) keeps the previous holder. */
  note(sessionId: string, ownerWindowId: string | null): void {
    if (ownerWindowId) this.last.set(sessionId, ownerWindowId);
  }

  /** The current owner if any, else the last one, else null (never shown). */
  holderOf(sessionId: string, ownerWindowId: string | null): string | null {
    return ownerWindowId ?? this.last.get(sessionId) ?? null;
  }

  forget(sessionId: string): void {
    this.last.delete(sessionId);
  }
}

/** Last part of a local or remote path, '' for an empty one. */
function folderName(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? '';
}
