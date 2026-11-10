import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentUpdateNotice, AgentVersionInfo } from '@shared/protocol';
import { AUTO_UPDATE_DELAY_MS, AgentAutoUpdater, type AgentAutoUpdateDeps } from './agent-auto-update';

vi.mock('./logger', () => ({ logger: { info: vi.fn(), warn: vi.fn() } }));

const codex = (latest = '0.2.0'): AgentVersionInfo => ({
  templateId: 'codex',
  status: 'outdated',
  installed: '0.1.0',
  latest,
  upgradeCommand: 'npm install -g @openai/codex@latest',
});

function setup(over: Partial<AgentAutoUpdateDeps> = {}, agents: AgentVersionInfo[] = [codex()]) {
  const notices: AgentUpdateNotice[] = [];
  const state = { running: false, windows: 1, exitCode: 0 as number | null, agents };
  const startUpgrade = vi.fn(async () => ({ exitCode: state.exitCode, sessionId: 's1', pathId: '/home' }));
  const updater = new AgentAutoUpdater({
    list: async () => state.agents,
    nameOf: () => 'Codex',
    isAutoCheckEnabled: () => true,
    isAutoUpdateEnabled: () => true,
    isAgentRunning: () => state.running,
    hasWindow: () => state.windows > 0,
    startUpgrade,
    notify: (n) => notices.push(n),
    ...over,
  });
  const kinds = (): string[] => notices.map((n) => n.kind);
  return { updater, notices, kinds, state, startUpgrade };
}

describe('AgentAutoUpdater', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('with auto update off, announces each new version once and never updates', async () => {
    const { updater, kinds, state, startUpgrade } = setup({ isAutoUpdateEnabled: () => false });
    await updater.checkNow();
    await updater.checkNow();
    expect(kinds()).toEqual(['available']);
    state.agents = [codex('0.3.0')];
    await updater.checkNow();
    expect(kinds()).toEqual(['available', 'available']);
    expect(startUpgrade).not.toHaveBeenCalled();
  });

  it('tells the user first and updates only after the countdown', async () => {
    const { updater, notices, kinds, startUpgrade } = setup();
    await updater.checkNow();
    expect(notices[0]).toMatchObject({ kind: 'scheduled', from: '0.1.0', to: '0.2.0', delayMs: AUTO_UPDATE_DELAY_MS });
    await vi.advanceTimersByTimeAsync(AUTO_UPDATE_DELAY_MS - 1);
    expect(startUpgrade).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(startUpgrade).toHaveBeenCalledWith('codex');
    expect(kinds()).toEqual(['scheduled', 'done']);
  });

  it('skip cancels the countdown and silences that version', async () => {
    const { updater, kinds, startUpgrade } = setup();
    await updater.checkNow();
    updater.act('codex', 'skip');
    await vi.advanceTimersByTimeAsync(AUTO_UPDATE_DELAY_MS);
    await updater.checkNow();
    expect(startUpgrade).not.toHaveBeenCalled();
    expect(kinds()).toEqual(['scheduled']);
  });

  it('update now skips the countdown', async () => {
    const { updater, startUpgrade } = setup();
    await updater.checkNow();
    updater.act('codex', 'now');
    await vi.advanceTimersByTimeAsync(0);
    expect(startUpgrade).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(AUTO_UPDATE_DELAY_MS);
    expect(startUpgrade).toHaveBeenCalledTimes(1);
  });

  it('waits while the agent is open, then counts down once it closes', async () => {
    const { updater, kinds, state, startUpgrade } = setup();
    state.running = true;
    await updater.checkNow();
    updater.onSessionsChanged();
    expect(kinds()).toEqual(['waiting']);
    state.running = false;
    updater.onSessionsChanged();
    await vi.advanceTimersByTimeAsync(AUTO_UPDATE_DELAY_MS);
    expect(kinds()).toEqual(['waiting', 'scheduled', 'done']);
    expect(startUpgrade).toHaveBeenCalledTimes(1);
  });

  it('cancelPending hands a waiting update to a reload without skipping the version', async () => {
    const { updater, kinds, state, startUpgrade } = setup();
    state.running = true;
    await updater.checkNow();
    expect(kinds()).toEqual(['waiting']);
    updater.cancelPending('codex');
    // the reload closes the tabs: the auto updater must not start its own countdown
    state.running = false;
    updater.onSessionsChanged();
    await vi.advanceTimersByTimeAsync(AUTO_UPDATE_DELAY_MS);
    expect(kinds()).toEqual(['waiting']);
    expect(startUpgrade).not.toHaveBeenCalled();
    // the version is not skipped: a later check offers it again
    await updater.checkNow();
    await vi.advanceTimersByTimeAsync(AUTO_UPDATE_DELAY_MS);
    expect(kinds()).toEqual(['waiting', 'scheduled', 'done']);
  });

  it('isBusy is true only while a background update is queued or running', async () => {
    const { updater, state, startUpgrade } = setup();
    expect(updater.isBusy('codex')).toBe(false);
    let finish: (() => void) | null = null;
    startUpgrade.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ exitCode: state.exitCode, sessionId: 's1', pathId: '/home' });
        }),
    );
    await updater.checkNow();
    await vi.advanceTimersByTimeAsync(AUTO_UPDATE_DELAY_MS);
    expect(updater.isBusy('codex')).toBe(true);
    finish!();
    await vi.advanceTimersByTimeAsync(0);
    expect(updater.isBusy('codex')).toBe(false);
  });

  it('does nothing without a window, and starts when one opens', async () => {
    const { updater, kinds, state } = setup();
    state.windows = 0;
    await updater.checkNow();
    expect(kinds()).toEqual([]);
    state.windows = 1;
    updater.poke();
    expect(kinds()).toEqual(['scheduled']);
  });

  it('reports a failed update with the terminal that holds the error', async () => {
    const { updater, notices, state } = setup();
    state.exitCode = 1;
    await updater.checkNow();
    await vi.advanceTimersByTimeAsync(AUTO_UPDATE_DELAY_MS);
    expect(notices.at(-1)).toMatchObject({ kind: 'failed', exitCode: 1, sessionId: 's1', pathId: '/home' });
  });
});
