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
  enabled: false,
  pluginInstalled: false,
  startSeen: false,
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

  it('skips the setting and plugin steps that are already done', () => {
    const made = { ...fresh, hasCoordinator: true, rowSeen: true, workerSeen: true };
    expect(coordinatorTourStep(made)).toBe('enable');
    expect(coordinatorTourStep({ ...made, enabled: true, pluginInstalled: null })).toBe('plugin');
    expect(coordinatorTourStep({ ...made, enabled: true, pluginInstalled: true })).toBe('start');
  });

  it('ends with the Fintuner after the user has seen how to start the coordinator', () => {
    const ready = {
      ...fresh,
      hasCoordinator: true,
      rowSeen: true,
      workerSeen: true,
      enabled: true,
    };
    expect(coordinatorTourStep({ ...ready, pluginInstalled: true, startSeen: true })).toBe(
      'fintuner',
    );
  });

  it('skips the setting and plugin steps when the coordinator runs an agent other than Claude Code', () => {
    const made = { ...fresh, hasCoordinator: true, rowSeen: true, workerSeen: true };
    expect(coordinatorTourStep({ ...made, controlSupported: false })).toBe('start');
    expect(canControlTabs('codex')).toBe(false);
    expect(canControlTabs('claude-code')).toBe(true);
    expect(canControlTabs('shell')).toBe(true);
  });
});
