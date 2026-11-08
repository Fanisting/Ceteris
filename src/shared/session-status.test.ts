import { describe, expect, it } from 'vitest';
import { sessionStatus } from './session-status';
import type { AgentPhase, SessionState } from './types';

describe('sessionStatus', () => {
  it('puts waving tabs under running and waiting agents under needs you', () => {
    const cases: Array<[SessionState, AgentPhase | null, string | null]> = [
      ['active', null, 'running'],
      ['idle', null, null],
      ['idle', 'working', 'running'],
      ['active', 'working', 'running'],
      ['idle', 'blocked', 'needs-you'],
      // Moving the cursor in an approval menu prints, and must not make it running.
      ['active', 'blocked', 'needs-you'],
      ['idle', 'done', 'needs-you'],
      ['exited', 'blocked', null],
      ['exited', null, null],
    ];
    const wrong = cases.filter(
      ([state, agentPhase, want]) => sessionStatus({ state, agentPhase }) !== want,
    );
    expect(wrong).toEqual([]);
  });
});
