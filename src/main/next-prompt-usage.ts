/**
 * @file src/main/next-prompt-usage.ts
 * @purpose Keeps the running cost of next prompt suggestions in next-prompt-usage.json.
 *
 * A file of its own, not settings.json: a suggestion can arrive every few seconds, and each
 * settings write is broadcast to every window.
 *
 * @不要在这里做的事:
 * - 不要记录屏幕内容或建议文本,这里只有计数
 */
import {
  EMPTY_NEXT_PROMPT_USAGE,
  addNextPromptUsage,
  localDay,
  type NextPromptUsage,
} from '@shared/next-prompt';
import type { JsonStore } from './persistence';

export type NextPromptUsageFile = NextPromptUsage & { version: 1 };

export class NextPromptUsageTracker {
  private total: NextPromptUsage = EMPTY_NEXT_PROMPT_USAGE;

  constructor(private readonly store: JsonStore<NextPromptUsageFile>) {}

  async initialize(): Promise<void> {
    const { value } = await this.store.load({ version: 1, ...EMPTY_NEXT_PROMPT_USAGE });
    this.total = { ...EMPTY_NEXT_PROMPT_USAGE, ...value };
  }

  get(): NextPromptUsage {
    return this.total;
  }

  /** @param now when the call finished; decides which day of the chart it counts on */
  record(usage: unknown, now = new Date()): void {
    this.total = addNextPromptUsage(this.total, usage, localDay(now));
    this.store.set({ version: 1, ...this.total });
  }

  reset(): void {
    this.total = EMPTY_NEXT_PROMPT_USAGE;
    this.store.set({ version: 1, ...this.total });
  }

  flush(): Promise<void> {
    return this.store.flush();
  }
}
