import { describe, expect, it, vi } from 'vitest';
import { AgentTitler, type AgentTitlerHost } from './agent-titler';

function makeHost(overrides: Partial<AgentTitlerHost> = {}) {
  const titles: string[] = [];
  let enterAt = 0;
  const host: AgentTitlerHost = {
    onSessionChanged: () => undefined,
    onSessionDestroyed: () => undefined,
    getScreenTail: () => '> fix the login bug\nDone.',
    getLastEnterAt: () => enterAt,
    currentTitle: () => 'Claude Code',
    isManuallyRenamed: () => false,
    getAgentOscTitle: () => null,
    setAiTitle: (_id, title) => titles.push(title),
    titleSettings: () => ({ guide: '', maxChars: 24 }),
    suggest: vi.fn(async () => 'Fix login'),
    ...overrides,
  };
  return { host, titles, setEnter: (t: number) => (enterAt = t) };
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('AgentTitler (ADR-029)', () => {
  it('titles Claude Code after working → done, not on the first done after start', async () => {
    const { host, titles } = makeHost();
    const t = new AgentTitler(host);
    t.onChange('s', { templateId: 'claude-code', state: 'idle', agentPhase: 'done' });
    await flush();
    expect(titles).toEqual([]);
    t.onChange('s', { templateId: 'claude-code', state: 'active', agentPhase: 'working' });
    t.onChange('s', { templateId: 'claude-code', state: 'idle', agentPhase: 'done' });
    await flush();
    expect(titles).toEqual(['Fix login']);
  });

  it('titles other agent templates once per Enter when output goes quiet', async () => {
    const { host, titles, setEnter } = makeHost();
    const t = new AgentTitler(host);
    const quiet = (): void => {
      t.onChange('s', { templateId: 'gemini-cli', state: 'active', agentPhase: null });
      t.onChange('s', { templateId: 'gemini-cli', state: 'idle', agentPhase: null });
    };
    quiet(); // output before any Enter: the welcome screen
    setEnter(100);
    quiet();
    quiet(); // a pause inside the same turn
    await flush();
    expect(titles).toEqual(['Fix login']);
  });

  it('asks nothing while titles are off or the tab was renamed by hand', async () => {
    const off = makeHost({ titleSettings: () => null });
    const renamed = makeHost({ isManuallyRenamed: () => true });
    for (const { host } of [off, renamed]) {
      const t = new AgentTitler(host);
      t.onChange('s', { templateId: 'codex', state: 'active', agentPhase: 'working' });
      t.onChange('s', { templateId: 'codex', state: 'idle', agentPhase: 'done' });
      await flush();
      expect(host.suggest).not.toHaveBeenCalled();
    }
  });

  it('asks once more for a turn that ends during a request, never in parallel', async () => {
    let release: (v: string) => void = () => undefined;
    const suggest = vi.fn(() => new Promise<string>((r) => (release = r)));
    const { host } = makeHost({ suggest });
    const t = new AgentTitler(host);
    const turn = (): void => {
      t.onChange('s', { templateId: 'codex', state: 'active', agentPhase: 'working' });
      t.onChange('s', { templateId: 'codex', state: 'idle', agentPhase: 'done' });
    };
    turn();
    turn();
    turn();
    expect(suggest).toHaveBeenCalledTimes(1);
    release('A');
    await flush();
    expect(suggest).toHaveBeenCalledTimes(2);
  });
});
