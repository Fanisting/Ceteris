/**
 * @file src/main/agent-model-switch.ts
 * @purpose Switch the model or effort of a running Claude Code or Codex tab (ADR-038) by
 *   relaunching the agent in the same tab: type `/exit`, wait for the tab's shell prompt,
 *   then type the same command again with session flags and the resume id, so the same
 *   conversation continues with the new model.
 *
 * @关键设计:
 * - Why not the agents' own `/model`: Claude Code saves the pick as the user's global default
 *   (2026-11-10, Claude Code 2.1.322: "Set model to Sonnet 5.5 and saved as your default for
 *   new sessions"), so one tab's choice would leak into every new session everywhere. Codex's
 *   `/model` was not tested and is treated the same way. Launch flags (`--model`, `-m`, `-c`)
 *   apply to that run only; a real Codex relaunch left ~/.codex/config.toml byte for byte.
 * - The tab stays the same session: same id, place, name and role. Only the agent process
 *   inside its shell is replaced. Templates run the agent from a shell (shellFirst with
 *   keep_shell), so after `/exit` the shell is still there.
 * - "The shell is back" = the Ceteris shell hook reported its prompt (SessionManager event
 *   'shellPrompt', from OSC 1337). On Windows pwsh starts the agent before drawing any prompt,
 *   so the first report after `/exit` is exactly the moment to type. No report within
 *   EXIT_TIMEOUT_MS → nothing is typed; the agent may still be running.
 * - Which conversation: the id the agent prints when it exits ("claude ... --resume <id>",
 *   "codex resume <id>"), read from the screen. That id is right after /clear or an in-agent
 *   /resume too. Only when nothing is printed does a file-based id count, and only one known
 *   for certain (Claude Code's launch id). Never a newest-file guess: that can be another
 *   tab's conversation. No id at all = a new conversation, reported as resumed: false.
 * - Ctrl-U before /exit clears a draft in the input line (the draft is lost; said in the docs).
 * - Command words must be plain (shellCommandLine). Otherwise the switch is refused before
 *   the agent is touched.
 * - Refused while the agent is mid-turn or waiting on an approval, for SSH tabs (the remote
 *   shell may have no hook) and for templates that do not keep a shell.
 * - One switch per tab at a time; a second click while one runs answers 'busy'.
 *
 * @对应文档章节: 软件定义书.md ADR-038; ipc-protocol.md 5.12
 *
 * @不要在这里做的事:
 * - No direct SessionManager / PTY / file access: everything comes through deps, so tests
 *   use fakes (same pattern as agent-reload.ts).
 * - Never write to ~/.claude or ~/.codex.
 */

import type { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import {
  exitResumeId,
  modelAgentOf,
  relaunchArgs,
  shellCommandLine,
  type ModelEffort,
} from '@shared/agent-model';
import type { AgentSwitchModelResponse } from '@shared/protocol';
import type { SessionInfo, Template } from '@shared/types';
import { logger } from './logger';

/** How long the agent gets to exit after `/exit` before the switch gives up */
export const EXIT_TIMEOUT_MS = 20_000;
/** Text first, Enter after this delay, so the agent does not take the burst as a paste */
export const SUBMIT_DELAY_MS = 150;
/** After the prompt report, let the shell finish drawing its prompt before typing */
export const PROMPT_SETTLE_MS = 300;
/** Screen rows searched for the id the agent prints on exit */
const SCREEN_ROWS = 60;
/** Ctrl-U: Claude Code and Codex both clear the input line with it */
const CLEAR_LINE = '\x15';
/** Stands in for a real id while checking that the line can be typed at all */
const PLACEHOLDER_ID = '00000000-0000-0000-0000-000000000000';

export interface ModelSwitchDeps {
  session: (sessionId: string) => SessionInfo | null;
  template: (templateId: string) => Template | null;
  isLocal: (pathId: string) => boolean;
  /** Type text into the tab; false when the tab is gone */
  write: (sessionId: string, text: string) => boolean;
  /** Source of 'shellPrompt', 'sessionExited' and 'sessionDestroyed' (SessionManager) */
  events: Pick<EventEmitter, 'on' | 'off'>;
  /** End of the tab's screen as plain text, to read the id the agent printed on exit */
  screenOf: (sessionId: string, rows: number) => string;
  /**
   * Fallback when the agent printed no id: an id known for certain from its files (Claude
   * Code's launch id once its transcript exists), else null. Never a guess from the folder.
   */
  resumeIdOf: (sessionId: string) => Promise<string | null>;
  setPick: (sessionId: string, pick: ModelEffort & { launchId?: string }) => void;
  /** The usage reader must look for the tab's file again (a fresh start makes a new one) */
  forgetUsage: (sessionId: string) => void;
  newId?: () => string;
  sleep?: (ms: number) => Promise<void>;
}

export class AgentModelSwitcher {
  private readonly inFlight = new Set<string>();
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly newId: () => string;

  constructor(private readonly deps: ModelSwitchDeps) {
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.newId = deps.newId ?? randomUUID;
  }

  /**
   * Relaunch the tab's agent with `next` (fields left out keep the tab's current pick).
   * Resolves once the new command is typed; the expected failures come back as a reason.
   *
   * 副作用: types into the tab, updates its agentModel / agentEffort / agentLaunchId
   */
  async switch(sessionId: string, next: Partial<ModelEffort>): Promise<AgentSwitchModelResponse> {
    const s = this.deps.session(sessionId);
    if (!s) return { applied: false, reason: 'session-not-found' };
    const agent = modelAgentOf(s.templateId);
    if (!agent) return { applied: false, reason: 'not-agent' };
    if (s.state === 'exited') return { applied: false, reason: 'exited' };
    if (s.agentPhase === 'working' || s.agentPhase === 'blocked' || this.inFlight.has(sessionId)) {
      return { applied: false, reason: 'busy' };
    }
    const template = this.deps.template(s.templateId);
    if (
      !this.deps.isLocal(s.pathId) ||
      !template?.command ||
      !template.shellFirst ||
      template.postExitAction !== 'keep_shell'
    ) {
      return { applied: false, reason: 'cannot-restart' };
    }

    const pick: ModelEffort = {
      model: next.model ?? s.agentModel ?? '',
      effort: next.effort ?? s.agentEffort ?? '',
    };
    this.inFlight.add(sessionId);
    try {
      // Check the line can be typed at all before the agent is stopped: a template with
      // arguments that are not plain words keeps its agent running untouched
      const build = (resumeId: string | null): { line: string; launchId?: string } => {
        const built = relaunchArgs(agent, pick, resumeId, this.newId());
        return {
          line: shellCommandLine(template.command, [...template.args, ...built.args]),
          ...(built.launchId ? { launchId: built.launchId } : {}),
        };
      };
      try {
        build(PLACEHOLDER_ID);
      } catch (err) {
        logger.warn('AgentModelSwitcher', `sid=${sessionId}: cannot build the relaunch line`, err);
        return { applied: false, reason: 'cannot-restart' };
      }

      // Listen before typing, so a fast exit is not missed. Ctrl-U first clears a draft in
      // the input line, which would otherwise turn "/exit" into the end of a prompt.
      const back = this.waitForPrompt(sessionId);
      if (!this.deps.write(sessionId, CLEAR_LINE) || !(await this.type(sessionId, '/exit'))) {
        back.cancel();
        return { applied: false, reason: 'exited' };
      }
      const outcome = await back.done;
      if (outcome !== 'prompt') {
        logger.warn(
          'AgentModelSwitcher',
          `sid=${sessionId} ${agent}: no shell prompt after /exit (${outcome}); nothing typed`,
        );
        return { applied: false, reason: outcome === 'exited' ? 'exited' : 'exit-timeout' };
      }
      await this.sleep(PROMPT_SETTLE_MS);

      // The id the agent printed on exit is exact, also after /clear; the file-based one is
      // only a fallback for an agent that printed nothing
      const printed = exitResumeId(agent, this.deps.screenOf(sessionId, SCREEN_ROWS));
      const resumeId = printed ?? (await this.deps.resumeIdOf(sessionId));
      const { line, launchId } = build(resumeId);
      if (!(await this.type(sessionId, line))) return { applied: false, reason: 'exited' };

      this.deps.setPick(sessionId, { ...pick, ...(launchId ? { launchId } : {}) });
      this.deps.forgetUsage(sessionId);
      logger.info(
        'AgentModelSwitcher',
        `sid=${sessionId} ${agent}: relaunched with "${line}" (id ${printed ? 'printed by the agent' : resumeId ? 'from its file' : 'none, new conversation'})`,
      );
      return { applied: true, resumed: resumeId !== null };
    } finally {
      this.inFlight.delete(sessionId);
    }
  }

  private async type(sessionId: string, text: string): Promise<boolean> {
    if (!this.deps.write(sessionId, text)) return false;
    await this.sleep(SUBMIT_DELAY_MS);
    return this.deps.write(sessionId, '\r');
  }

  /** Resolves 'prompt' on the tab's next prompt report, 'exited' if it closes, else 'timeout'. */
  private waitForPrompt(sessionId: string): {
    done: Promise<'prompt' | 'exited' | 'timeout'>;
    cancel: () => void;
  } {
    let finish: (r: 'prompt' | 'exited' | 'timeout') => void = () => undefined;
    const done = new Promise<'prompt' | 'exited' | 'timeout'>((resolve) => {
      const onPrompt = (p: { sessionId: string }): void => {
        if (p.sessionId === sessionId) finish('prompt');
      };
      const onExit = (p: { sessionId: string }): void => {
        if (p.sessionId === sessionId) finish('exited');
      };
      const timer = setTimeout(() => finish('timeout'), EXIT_TIMEOUT_MS);
      timer.unref?.();
      finish = (r) => {
        clearTimeout(timer);
        this.deps.events.off('shellPrompt', onPrompt);
        this.deps.events.off('sessionExited', onExit);
        this.deps.events.off('sessionDestroyed', onExit);
        resolve(r);
      };
      this.deps.events.on('shellPrompt', onPrompt);
      this.deps.events.on('sessionExited', onExit);
      this.deps.events.on('sessionDestroyed', onExit);
    });
    return { done, cancel: () => finish('exited') };
  }
}
