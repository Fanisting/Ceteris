/**
 * @file src/main/agent-titler.ts
 * @purpose Gives agent tabs a short title written by a model after each finished turn
 *   (ADR-029), following the guide the user wrote in Settings, AI Assistant, Tab titles.
 *
 * @关键设计:
 * - Two ways to see that a turn finished:
 *   1. Claude Code and Codex: agentPhase goes from 'working' to 'done' (ADR-021, read from
 *      the screen). The first 'done' after start is not a turn: the screen holds only the
 *      agent's welcome.
 *   2. Other agent templates (OpenCode, Gemini, Copilot, Cursor, Aider): Ceteris cannot
 *      read their screens, so a turn has finished when the user pressed Enter since the
 *      last title and the output then went quiet (state 'active' to 'idle'). A long pause
 *      inside one turn may title it early; the next Enter allows the next title.
 * - One request per tab at a time. A turn that finishes during a request asks once more
 *   after it, so the title follows the latest turn without piling up requests.
 * - The model sees the current title and answers KEEP while the task is the same.
 * - A tab the user renamed by hand is never touched (manuallyRenamed, M1-C).
 *
 * @对应文档章节:软件定义书.md ADR-029, ADR-021, ADR-025
 *
 * @不要在这里做的事:
 * - No HTTP here (agent-title-client.ts) and no title rules (shared/agent-title.ts)
 * - Do not shorten the agent's own OSC titles; SessionManager does that as they arrive
 */
import type { AgentPhase, SessionInfo, SessionState } from '@shared/types';
import { clampTitleLength, isAgentTemplate } from '@shared/agent-title';
import type { AgentTitleRequest } from './agent-title-client';
import { logger } from './logger';

/** Screen rows the model sees: enough for a prompt and a short reply. */
const TITLE_SCREEN_ROWS = 80;

/** What the titler needs from SessionManager and the settings. Narrow, for tests. */
export interface AgentTitlerHost {
  /** SessionManager 'sessionStateChanged' */
  onSessionChanged(fn: (sessionId: string, info: SessionInfo) => void): void;
  /** SessionManager 'sessionDestroyed' */
  onSessionDestroyed(fn: (sessionId: string) => void): void;
  getScreenTail(sessionId: string, rows: number): string;
  /** When the user last pressed Enter in the tab, in ms; 0 if never */
  getLastEnterAt(sessionId: string): number;
  /** The tab's name now, '' for an unknown tab */
  currentTitle(sessionId: string): string;
  isManuallyRenamed(sessionId: string): boolean;
  getAgentOscTitle(sessionId: string): string | null;
  setAiTitle(sessionId: string, title: string): void;
  /** Settings, AI Assistant, Tab titles; null while titles are off or nothing is connected */
  titleSettings(): { guide: string; maxChars: number } | null;
  /** Asks the model; resolves null for KEEP */
  suggest(request: AgentTitleRequest): Promise<string | null>;
}

interface TabTitleState {
  lastPhase: AgentPhase | null;
  lastState: SessionState | null;
  /** lastEnterAt that the last title already covered (agents read by template only) */
  titledEnterAt: number;
  inFlight: boolean;
  /** A turn finished during the request in flight */
  again: boolean;
}

export class AgentTitler {
  private readonly tabs = new Map<string, TabTitleState>();

  constructor(private readonly host: AgentTitlerHost) {}

  /** Starts listening to session changes. Call once, after SessionManager exists. */
  start(): void {
    this.host.onSessionChanged((sessionId, info) => this.onChange(sessionId, info));
    this.host.onSessionDestroyed((sessionId) => this.tabs.delete(sessionId));
  }

  /** A tab changed. Public for tests. */
  onChange(sessionId: string, info: Pick<SessionInfo, 'templateId' | 'state' | 'agentPhase'>): void {
    let tab = this.tabs.get(sessionId);
    if (!tab) {
      tab = { lastPhase: null, lastState: null, titledEnterAt: 0, inFlight: false, again: false };
      this.tabs.set(sessionId, tab);
    }
    const phase = info.agentPhase ?? null;
    const finishedTurn = phase !== null || tab.lastPhase !== null
      ? tab.lastPhase === 'working' && phase === 'done'
      : this.quietAfterEnter(sessionId, tab, info);
    tab.lastPhase = phase;
    tab.lastState = info.state;
    if (!finishedTurn) return;
    if (tab.inFlight) {
      tab.again = true;
      return;
    }
    void this.retitle(sessionId, tab);
  }

  /** Way 2 in the file header: an agent template, Enter pressed, output just stopped. */
  private quietAfterEnter(
    sessionId: string,
    tab: TabTitleState,
    info: Pick<SessionInfo, 'templateId' | 'state'>,
  ): boolean {
    if (!isAgentTemplate(info.templateId)) return false;
    if (tab.lastState !== 'active' || info.state !== 'idle') return false;
    const enterAt = this.host.getLastEnterAt(sessionId);
    if (enterAt <= tab.titledEnterAt) return false;
    tab.titledEnterAt = enterAt;
    return true;
  }

  private async retitle(sessionId: string, tab: TabTitleState): Promise<void> {
    const settings = this.host.titleSettings();
    if (!settings || this.host.isManuallyRenamed(sessionId)) return;
    tab.inFlight = true;
    try {
      const screen = this.host.getScreenTail(sessionId, TITLE_SCREEN_ROWS);
      if (!screen.trim()) return;
      const title = await this.host.suggest({
        screen,
        currentTitle: this.host.currentTitle(sessionId),
        agentTitle: this.host.getAgentOscTitle(sessionId),
        guide: settings.guide,
        maxChars: clampTitleLength(settings.maxChars),
      });
      // The user may have renamed or closed the tab while the request ran.
      if (title && this.tabs.has(sessionId) && !this.host.isManuallyRenamed(sessionId)) {
        this.host.setAiTitle(sessionId, title);
        logger.info('AgentTitler', `title sid=${sessionId} → "${title}"`);
      }
    } catch (err) {
      logger.warn('AgentTitler', `title request failed sid=${sessionId}`, err);
    } finally {
      tab.inFlight = false;
      if (tab.again && this.tabs.has(sessionId)) {
        tab.again = false;
        void this.retitle(sessionId, tab);
      }
    }
  }
}
