/**
 * @file coordinator-tour.test.ts
 * @purpose The coordinator tour (ADR-024) shows the step that matches what the user has done.
 */
import { describe, expect, it } from 'vitest';
import { coordinatorTourStep, type CoordinatorTourInput } from './coordinator-tour';

const fresh: CoordinatorTourInput = {
  introSeen: true,
  hasCoordinator: false,
  menuOpen: false,
  hasFolderTab: false,
  rowSeen: false,
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

  it('shows the coordinator row until the user presses Next', () => {
    expect(coordinatorTourStep({ ...fresh, hasCoordinator: true })).toBe('row');
  });

  it('skips the setting and plugin steps that are already done', () => {
    const made = { ...fresh, hasCoordinator: true, rowSeen: true };
    expect(coordinatorTourStep(made)).toBe('enable');
    expect(coordinatorTourStep({ ...made, enabled: true, pluginInstalled: null })).toBe('plugin');
    expect(coordinatorTourStep({ ...made, enabled: true, pluginInstalled: true })).toBe('start');
  });

  it('ends with the Fintuner after the user has seen how to start the coordinator', () => {
    const ready = { ...fresh, hasCoordinator: true, rowSeen: true, enabled: true };
    expect(coordinatorTourStep({ ...ready, pluginInstalled: true, startSeen: true })).toBe(
      'fintuner',
    );
  });
});
