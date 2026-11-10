/**
 * @file src/main/template-usage.ts
 * @purpose Remembers how often each button on the new tab page was clicked, in
 *   template-usage.json, so the page can single out the user's frequent choices (ADR-034).
 *
 * @关键设计:
 * - A file of its own, not settings.json: every settings write is broadcast to all windows,
 *   and a launch count is nobody else's business.
 * - Counted in the SESSION_CREATE handler (ipc.ts), which only the user's own clicks reach:
 *   tabs opened by an agent through tab control go straight to SessionManager and stay out,
 *   so the counts reflect what the user picks, not what the agents do.
 * - The rules (keys, limits, the frequent tier) live in src/shared/template-usage.ts and are
 *   shared with the renderer; this class only persists.
 *
 * @对应文档章节:软件定义书.md ADR-034
 *
 * @不要在这里做的事:
 * - 不要在这里决定谁是常用选项,规则在 shared,renderer 自己算
 */
import {
  EMPTY_TEMPLATE_USAGE,
  recordTemplateUsage,
  sanitizeTemplateUsage,
  type TemplateUsageEntry,
  type TemplateUsageFile,
} from '@shared/template-usage';
import type { JsonStore } from './persistence';

export class TemplateUsageTracker {
  private entries: TemplateUsageEntry[] = [];

  constructor(private readonly store: JsonStore<TemplateUsageFile>) {}

  /** Loads the file once at startup. A damaged file yields an empty list, never a throw. */
  async initialize(): Promise<void> {
    const { value } = await this.store.load(EMPTY_TEMPLATE_USAGE);
    this.entries = sanitizeTemplateUsage(value).entries;
  }

  /** A copy of the entries, least recently used first. */
  list(): TemplateUsageEntry[] {
    return this.entries.map((e) => ({ ...e }));
  }

  /**
   * @param key from templateUsageKey: the template id, or `shell:<shellId>` for a shell button
   * @param now when the launch happened
   */
  record(key: string, now = Date.now()): void {
    this.entries = recordTemplateUsage(this.entries, key, now);
    this.store.set({ version: 1, entries: this.entries });
  }

  flush(): Promise<void> {
    return this.store.flush();
  }
}
