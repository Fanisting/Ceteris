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
 * - Before /exit a draft in the input box is cleared (Ctrl-K and Ctrl-U, many times; the
 *   agent's Ctrl-Y brings it back). Enter is pressed only when the box then reads exactly
 *   "/exit" on screen; otherwise the typed text is erased and the switch stops
 *   ('input-not-clear'). Never send anything the agent could take as a prompt.
 * - Command words must be plain (shellCommandLine). Otherwise the switch is refused before
 *   the agent is touched.
 * - Refused while the agent is mid-turn or waiting on an approval, for SSH tabs (the remote
 *   shell may have no hook) and for templates that do not keep a shell.
 * - One switch per tab at a time; a second click while one runs answers 'busy'.
 * - The tab carries `agentSwitching` from the moment a switch starts until the relaunched
 *   agent shows its input box (or the wait ends another way), so every window covers the tab
 *   with the loader (ADR-054) instead of showing /exit and the relaunch line. switch() itself
 *   resolves only then, so the result toast appears when the agent is back.
 *
 * @对应文档章节: 软件定义书.md ADR-038, ADR-054; ipc-protocol.md 5.13
 *
 * @不要在这里做的事:
 * - No direct SessionManager / PTY / file access: everything comes through deps, so tests
 *   use fakes (same pattern as agent-reload.ts).
 * - Never write to ~/.claude or ~/.codex.
 */

import type { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import {
  agentInputAfter,
  exitResumeId,
  INPUT_LINE_ROWS,
  inputLineReads,
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
/**
 * Clears a draft in the input box wherever the cursor is: Ctrl-K deletes to the end of the
 * line (and the line break after it), Ctrl-U to its start. In Claude Code each press reaches
 * only one wrapped row, so one Ctrl-U left most of a long pasted link in place (2026-11-10).
 * Pressed many times; on an empty box both keys do nothing. Checked in Claude Code 2.1.322
 * and Codex 0.167 with a three-line draft and the cursor at its start.
 * One key per write with a short gap: 80 keys in a single write reached Claude Code as one
 * paste and cleared nothing (2026-11-10).
 */
export const CLEAR_PRESSES = 30;
export const CLEAR_KEYS: readonly string[] = [
  ...Array<string>(CLEAR_PRESSES).fill('\x0b'),
  ...Array<string>(CLEAR_PRESSES).fill('\x15'),
];
const CLEAR_KEY_GAP_MS = 12;
/** How long the typed "/exit" gets to show in the input box before the switch gives up */
export const INPUT_CHECK_MS = 2_000;
const INPUT_POLL_MS = 100;
/** Backspace, to take the typed "/exit" back out when Enter is not pressed */
const BACKSPACE = '\x7f';
const EXIT_COMMAND = '/exit';
/** Stands in for a real id while checking that the line can be typed at all */
const PLACEHOLDER_ID = '00000000-0000-0000-0000-000000000000';
/**
 * The loader stays at most this long after the relaunch line is typed. Claude Code takes a
 * few seconds to redraw a long resumed conversation; past this the tab is shown as it is.
 */
export const READY_TIMEOUT_MS = 60_000;
/** How often the screen is read while waiting for the relaunched agent */
export const READY_POLL_MS = 200;
/**
 * The input box must stay on an unchanged screen for this long: Claude Code draws the box
 * early and then fills in the resumed conversation above it.
 */
export const READY_QUIET_MS = 600;
/** The box counts after this long even if the screen keeps changing (a ticking status line) */
export const READY_BUSY_SCREEN_MS = 3_000;

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
  /**
   * Mark the tab as switching (what was asked for) or clear it (null), so every window shows
   * the loader over it until the agent is back (SessionManager.setAgentSwitching).
   */
  setSwitching: (sessionId: string, value: Partial<ModelEffort> | null) => void;
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
    let marked = false;
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
      // From here on the tab changes on screen: cover it in every window (ADR-054)
      this.deps.setSwitching(sessionId, {
        ...(next.model !== undefined ? { model: next.model } : {}),
        ...(next.effort !== undefined ? { effort: next.effort } : {}),
      });
      marked = true;

      // Clear any draft, type "/exit", and press Enter only once the input box reads exactly
      // "/exit": a draft left in place would turn it into the end of a prompt the agent then
      // acts on. Listen for the prompt before Enter, so a fast exit is not missed.
      for (const key of CLEAR_KEYS) {
        if (!this.deps.write(sessionId, key)) return { applied: false, reason: 'exited' };
        await this.sleep(CLEAR_KEY_GAP_MS);
      }
      if (!this.deps.write(sessionId, EXIT_COMMAND)) return { applied: false, reason: 'exited' };
      if (!(await this.waitForInput(sessionId, EXIT_COMMAND))) {
        this.deps.write(sessionId, BACKSPACE.repeat(EXIT_COMMAND.length));
        logger.warn(
          'AgentModelSwitcher',
          `sid=${sessionId} ${agent}: input box did not read "${EXIT_COMMAND}" after clearing; Enter not pressed. Screen end:\n${this.deps.screenOf(sessionId, 8)}`,
        );
        return { applied: false, reason: 'input-not-clear' };
      }
      const back = this.waitForPrompt(sessionId);
      await this.sleep(SUBMIT_DELAY_MS);
      if (!this.deps.write(sessionId, '\r')) {
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
      // Listen before Enter: an agent that fails at once brings the shell prompt back fast
      const shellBack = this.watchPrompt(sessionId);
      if (!(await this.type(sessionId, line))) {
        shellBack.stop();
        return { applied: false, reason: 'exited' };
      }

      this.deps.setPick(sessionId, { ...pick, ...(launchId ? { launchId } : {}) });
      this.deps.forgetUsage(sessionId);
      logger.info(
        'AgentModelSwitcher',
        `sid=${sessionId} ${agent}: relaunched with "${line}" (id ${printed ? 'printed by the agent' : resumeId ? 'from its file' : 'none, new conversation'})`,
      );
      const ready = await this.waitForAgent(sessionId, line, shellBack);
      logger.info('AgentModelSwitcher', `sid=${sessionId} ${agent}: loader cleared (${ready})`);
      return { applied: true, resumed: resumeId !== null };
    } finally {
      this.inFlight.delete(sessionId);
      if (marked) this.deps.setSwitching(sessionId, null);
    }
  }

  /**
   * Waits until the relaunched agent can take input, so the loader covers the whole switch:
   * its input box is below the typed line on a screen unchanged for READY_QUIET_MS (or for
   * READY_BUSY_SCREEN_MS on a screen that keeps changing), or it stopped at a question
   * (agentPhase 'blocked', e.g. a trust prompt). Stops early when the tab closes or the shell
   * prompt comes back (the agent did not start); gives up after READY_TIMEOUT_MS.
   *
   * @returns why the wait ended; only logged, the switch itself already happened
   */
  private async waitForAgent(
    sessionId: string,
    line: string,
    shellBack: { seen: () => boolean; stop: () => void },
  ): Promise<'ready' | 'blocked' | 'shell' | 'exited' | 'timeout'> {
    let last = '';
    let quietFor = 0;
    let boxFor = 0;
    try {
      for (let waited = 0; waited <= READY_TIMEOUT_MS; waited += READY_POLL_MS) {
        const s = this.deps.session(sessionId);
        if (!s || s.state === 'exited') return 'exited';
        if (shellBack.seen()) return 'shell';
        if (s.agentPhase === 'blocked') return 'blocked';
        const screen = this.deps.screenOf(sessionId, SCREEN_ROWS);
        quietFor = screen === last ? quietFor + READY_POLL_MS : 0;
        last = screen;
        boxFor = agentInputAfter(screen, line) ? boxFor + READY_POLL_MS : 0;
        if (boxFor > 0 && (quietFor >= READY_QUIET_MS || boxFor >= READY_BUSY_SCREEN_MS)) {
          return 'ready';
        }
        await this.sleep(READY_POLL_MS);
      }
      return 'timeout';
    } finally {
      shellBack.stop();
    }
  }

  /** Notes whether the tab's shell reports a prompt from now on, until stop(). */
  private watchPrompt(sessionId: string): { seen: () => boolean; stop: () => void } {
    let seen = false;
    const onPrompt = (p: { sessionId: string }): void => {
      if (p.sessionId === sessionId) seen = true;
    };
    this.deps.events.on('shellPrompt', onPrompt);
    return {
      seen: () => seen,
      stop: () => this.deps.events.off('shellPrompt', onPrompt),
    };
  }

  /** Polls the screen until the input box reads exactly `text`; false after INPUT_CHECK_MS. */
  private async waitForInput(sessionId: string, text: string): Promise<boolean> {
    for (let waited = 0; waited <= INPUT_CHECK_MS; waited += INPUT_POLL_MS) {
      if (inputLineReads(this.deps.screenOf(sessionId, INPUT_LINE_ROWS), text)) return true;
      await this.sleep(INPUT_POLL_MS);
    }
    return false;
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
