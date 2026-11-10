import { describe, expect, it } from 'vitest';
import { sessionStatus } from './session-status';
import type { AgentPhase, SessionState } from './types';

type Case = [SessionState, AgentPhase | null, boolean | null, boolean, string | null];

function wrongCases(cases: Case[]): Case[] {
  return cases.filter(
    ([state, agentPhase, shellBusy, unseen, want]) =>
      sessionStatus({ state, agentPhase, shellBusy }, unseen) !== want,
  );
}

describe('sessionStatus', () => {
  it('puts working agents under running and approval prompts under needs you', () => {
    expect(
      wrongCases([
        ['idle', 'working', null, false, 'running'],
        ['active', 'working', null, false, 'running'],
        ['idle', 'blocked', null, false, 'needs-you'],
        // Moving the cursor in an approval menu prints, and must not make it running.
        ['active', 'blocked', null, false, 'needs-you'],
        ['exited', 'blocked', null, false, null],
        ['exited', null, true, true, null],
      ]),
    ).toEqual([]);
  });

  it('lists a finished tab under needs you only until the user has seen it', () => {
    expect(
      wrongCases([
        ['idle', 'done', null, true, 'needs-you'],
        ['idle', 'done', null, false, null],
        ['idle', null, false, true, 'needs-you'],
        ['idle', null, false, false, null],
      ]),
    ).toEqual([]);
  });

  it('counts a hooked shell as running from Enter to the next prompt, quiet or not', () => {
    expect(
      wrongCases([
        ['idle', null, true, false, 'running'],
        ['active', null, true, false, 'running'],
        // Typing at the prompt echoes bytes but runs nothing.
        ['active', null, false, false, null],
      ]),
    ).toEqual([]);
  });

  it('falls back to printing means running for a shell without the prompt hook', () => {
    expect(
      wrongCases([
        ['active', null, null, false, 'running'],
        ['idle', null, null, false, null],
      ]),
    ).toEqual([]);
  });
});
