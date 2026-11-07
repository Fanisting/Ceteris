/**
 * @file src/main/askpass-prompts.ts
 * @purpose 把 ssh 的登录提示送到某个窗口的 renderer 弹 modal,并等它的答案回来。
 *   sftp-client.ts 问,ipc.ts 的 cmd:ssh:askpass-answer 答。
 *
 * @关键设计:
 * - 定向发给发起这次连接的窗口(用户点文件树的那个窗口),不广播:广播会在每个窗口都
 *   弹一个框,而 Modal 没法从外面关掉其它窗口的。
 * - 每条提示一个随机 promptId,答案必须带同一个 id,迟到或重复的答案忽略。
 * - 超时和中止(ssh 自己断了)都解析成 null,并给窗口发 askpass-closed 让 modal 收起。
 *
 * @对应文档章节: 软件定义书.md 14.9
 *
 * @不要在这里做的事:
 * - 不要在这里决定答案内容(那是 askpass-policy.ts),这里只负责送达和等待
 */
import { randomUUID } from 'node:crypto';
import { EVENT_CHANNELS, type AskpassPromptPayload } from '@shared/protocol';
import { logger } from './logger';

/** 用户不理会多久算取消。Duo 推送本身一分钟就过期,五分钟足够。 */
export const PROMPT_TIMEOUT_MS = 5 * 60_000;

export interface PromptBrokerDeps {
  /** 定向发事件。返回 false 表示窗口已不存在 */
  send: (windowId: string, channel: string, payload: unknown) => boolean;
}

export interface PromptRequest {
  /** 收提示的窗口。null 表示没有能弹窗的窗口,直接当取消 */
  windowId: string | null;
  payload: Omit<AskpassPromptPayload, 'promptId'>;
  /** ssh 连接已经结束时中止等待 */
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
}

interface Pending {
  windowId: string;
  resolve: (answer: string | null) => void;
}

export class PromptBroker {
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly deps: PromptBrokerDeps) {}

  /** 正在等用户的提示数量,测试用。 */
  get pendingCount(): number {
    return this.pending.size;
  }

  /**
   * 弹出一条提示并等答案。
   *
   * @returns 用户的输入;取消、超时、中止或窗口不存在时为 null
   */
  ask(request: PromptRequest): Promise<string | null> {
    const { windowId, signal } = request;
    if (!windowId) return Promise.resolve(null);
    if (signal?.aborted) return Promise.resolve(null);
    const promptId = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => done(null, true), request.timeoutMs ?? PROMPT_TIMEOUT_MS);
      timer.unref?.();
      const onAbort = (): void => done(null, true);
      const done = (answer: string | null, tellWindow: boolean): void => {
        if (!this.pending.delete(promptId)) return;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (tellWindow) this.deps.send(windowId, EVENT_CHANNELS.SSH_ASKPASS_CLOSED, { promptId });
        resolve(answer);
      };
      this.pending.set(promptId, { windowId, resolve: (answer) => done(answer, false) });
      signal?.addEventListener('abort', onAbort, { once: true });
      const payload: AskpassPromptPayload = { promptId, ...request.payload };
      logger.info(
        'Askpass',
        `prompt ${promptId} kind=${payload.kind} host=${payload.host} window=${windowId}`,
      );
      if (!this.deps.send(windowId, EVENT_CHANNELS.SSH_ASKPASS_PROMPT, payload)) {
        logger.warn('Askpass', `window ${windowId} is gone, cancelling prompt ${promptId}`);
        done(null, false);
      }
    });
  }

  /**
   * renderer 的答案。
   *
   * @returns 是否有提示在等这个 id
   */
  answer(promptId: string, answer: string | null): boolean {
    const waiting = this.pending.get(promptId);
    if (!waiting) return false;
    waiting.resolve(answer);
    return true;
  }
}
