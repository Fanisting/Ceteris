/**
 * @file coordinator-tour.test.ts
 * @purpose The coordinator tour (ADR-024) shows the step that matches what the user has done.
 */
import { describe, expect, it } from 'vitest';
import { canControlTabs, coordinatorTourStep, type CoordinatorTourInput } from './coordinator-tour';

const fresh: CoordinatorTourInput = {
  introSeen: true,
  hasCoordinator: false,
  menuOpen: false,
  hasFolderTab: false,
  rowSeen: false,
  workerSeen: false,
  controlSupported: true,
  pluginInstalled: false,
  startSeen: false,
  hasFintuner: false,
  hasFintunerCandidate: false,
};

describe('coordinatorTourStep', () => {
  it('introduces the Coordinator and Fintuner roles before anything else', () => {
    expect(coordinatorTourStep({ ...fresh, introSeen: false, hasCoordinator: true })).toBe('intro');
  });

  it('walks through making a coordinator: open a tab, right-click it, tick Coordinator', () => {
    expect(coordinatorTourStep(fresh)).toBe('open-tab');
    expect(coordinatorTourStep({ ...fresh, hasFolderTab: true })).toBe('right-click');
    expect(coordinatorTourStep({ ...fresh, hasFolderTab: true, menuOpen: true })).toBe('tick');
  });

  it('shows the coordinator row, then the workers, each until the user presses Next', () => {
    expect(coordinatorTourStep({ ...fresh, hasCoordinator: true })).toBe('row');
    expect(coordinatorTourStep({ ...fresh, hasCoordinator: true, rowSeen: true })).toBe('worker');
  });

  it('goes from the workers straight to the plugin, with no setting to turn on', () => {
    const made = { ...fresh, hasCoordinator: true, rowSeen: true, workerSeen: true };
    expect(coordinatorTourStep(made)).toBe('plugin');
    expect(coordinatorTourStep({ ...made, pluginInstalled: null })).toBe('plugin');
    expect(coordinatorTourStep({ ...made, pluginInstalled: true })).toBe('start');
  });

  it('makes a Fintuner like the Coordinator: open an agent, right-click it, pick the role', () => {
    const ready = {
      ...fresh,
      hasCoordinator: true,
      rowSeen: true,
      workerSeen: true,
      pluginInstalled: true,
      startSeen: true,
    };
    expect(coordinatorTourStep(ready)).toBe('fintuner-open');
    expect(coordinatorTourStep({ ...ready, hasFintunerCandidate: true })).toBe(
      'fintuner-right-click',
    );
    expect(coordinatorTourStep({ ...ready, hasFintunerCandidate: true, menuOpen: true })).toBe(
      'fintuner-pick',
    );
    expect(coordinatorTourStep({ ...ready, hasFintuner: true })).toBe('finish');
  });

  it('skips the setting and plugin steps when the coordinator runs an agent other than Claude Code', () => {
    const made = { ...fresh, hasCoordinator: true, rowSeen: true, workerSeen: true };
    expect(coordinatorTourStep({ ...made, controlSupported: false })).toBe('start');
    expect(canControlTabs('gemini-cli')).toBe(false);
    // ADR-042:Codex 经 config.toml 拿到同一个 ceteris-tabs 服务器
    expect(canControlTabs('codex')).toBe(true);
    expect(canControlTabs('claude-code')).toBe(true);
    expect(canControlTabs('shell')).toBe(true);
  });
});
