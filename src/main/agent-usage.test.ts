/**
 * @file src/main/agent-usage.test.ts
 * @purpose Rules of agent-usage.ts (ADR-038): finding each tab's file, reading Claude Code
 *   transcripts, the OMC statusline cache and Codex rollouts, incremental reads, model list.
 *   Every file lives in a temp folder; nothing under the real home folder is touched.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFile, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  advance,
  AgentUsageReader,
  ClaudeTally,
  type Cursor,
  claudeModelName,
  claudeProjectDir,
  findClaudeTranscript,
  findCodexRollout,
  readCodexModels,
} from './agent-usage';

let root: string;
let claudeDir: string;
let codexDir: string;
let cwd: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ceteris-usage-'));
  claudeDir = join(root, 'claude');
  codexDir = join(root, 'codex');
  cwd = join(root, 'work', 'proj');
  await mkdir(cwd, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const line = (o: unknown): string => `${JSON.stringify(o)}\n`;
const at = (iso: string): string => new Date(iso).toISOString();

async function writeTranscript(id: string, lines: unknown[]): Promise<string> {
  const dir = claudeProjectDir(claudeDir, cwd);
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${id}.jsonl`);
  await writeFile(file, lines.map(line).join(''));
  return file;
}

async function writeRollout(
  day: string,
  name: string,
  metaCwd: string,
  startedAt: string,
  rest: unknown[] = [],
): Promise<string> {
  const [y, m, d] = day.split('-');
  const dir = join(codexDir, 'sessions', y!, m!, d!);
  await mkdir(dir, { recursive: true });
  const file = join(dir, `rollout-${name}.jsonl`);
  const meta = {
    timestamp: startedAt,
    type: 'session_meta',
    payload: { id: name, timestamp: startedAt, cwd: metaCwd },
  };
  await writeFile(file, [meta, ...rest].map(line).join(''));
  return file;
}

const prompt = (text: string, ts: string): unknown => ({
  type: 'user',
  timestamp: ts,
  message: { role: 'user', content: text },
});
const assistant = (
  ts: string,
  tools: Array<{ name: string; input?: unknown }>,
  usage?: unknown,
): unknown => ({
  type: 'assistant',
  timestamp: ts,
  message: {
    model: 'claude-opus-5-5',
    content: tools.map((t, i) => ({
      type: 'tool_use',
      id: `t${i}`,
      name: t.name,
      input: t.input ?? {},
    })),
    ...(usage ? { usage } : {}),
  },
});

describe('claudeProjectDir', () => {
  it('turns every character but letters and digits into a dash', () => {
    expect(claudeProjectDir('H', 'C:\\Users\\a.b\\my_proj')).toBe(
      join('H', 'projects', 'C--Users-a-b-my-proj'),
    );
  });
});

describe('findClaudeTranscript', () => {
  it('with a launch id, takes only that file and waits until it exists', async () => {
    await writeTranscript('other', [prompt('hi', at('2026-11-10T10:00:00Z'))]);
    expect(
      await findClaudeTranscript({
        claudeDir,
        cwd,
        launchId: 'mine',
        since: 0,
        claimed: new Set(),
      }),
    ).toBeNull();
    const mine = await writeTranscript('mine', [prompt('hi', at('2026-11-10T10:00:00Z'))]);
    expect(
      await findClaudeTranscript({
        claudeDir,
        cwd,
        launchId: 'mine',
        since: 0,
        claimed: new Set(),
      }),
    ).toBe(mine);
  });

  it('without an id, takes the newest file written since the tab opened and not claimed', async () => {
    const old = await writeTranscript('old', []);
    const a = await writeTranscript('a', []);
    const b = await writeTranscript('b', []);
    const since = Date.now();
    await utimes(old, new Date(since - 60_000), new Date(since - 60_000));
    await utimes(a, new Date(since + 1000), new Date(since + 1000));
    await utimes(b, new Date(since + 2000), new Date(since + 2000));
    expect(await findClaudeTranscript({ claudeDir, cwd, since, claimed: new Set() })).toBe(b);
    expect(await findClaudeTranscript({ claudeDir, cwd, since, claimed: new Set([b]) })).toBe(a);
    expect(
      await findClaudeTranscript({ claudeDir, cwd, since, claimed: new Set([a, b]) }),
    ).toBeNull();
  });
});

describe('findCodexRollout', () => {
  it('matches the folder, prefers the earliest rollout started after the tab opened', async () => {
    const since = Date.parse('2026-11-10T10:00:00Z');
    await writeRollout('2026-11-10', 'elsewhere', join(root, 'other'), at('2026-11-10T10:00:05Z'));
    const first = await writeRollout('2026-11-10', 'first', cwd, at('2026-11-10T10:00:06Z'));
    const second = await writeRollout('2026-11-10', 'second', cwd, at('2026-11-10T10:00:09Z'));
    expect(await findCodexRollout({ codexDir, cwd, since, claimed: new Set() })).toBe(first);
    expect(await findCodexRollout({ codexDir, cwd, since, claimed: new Set([first]) })).toBe(
      second,
    );
  });

  it('falls back to a resumed rollout started before the tab but written since', async () => {
    const since = Date.now();
    const resumed = await writeRollout('2026-11-09', 'resumed', cwd, at('2026-11-09T08:00:00Z'));
    await utimes(resumed, new Date(since + 1000), new Date(since + 1000));
    expect(await findCodexRollout({ codexDir, cwd, since, claimed: new Set() })).toBe(resumed);
  });

  it('returns null with no sessions folder', async () => {
    expect(await findCodexRollout({ codexDir, cwd, since: 0, claimed: new Set() })).toBeNull();
  });
});

describe('AgentUsageReader: Claude Code', () => {
  it('counts prompts, tools, agents, skills and todos, and reads the context', async () => {
    await writeTranscript('s1', [
      prompt('fix the bug', at('2026-11-10T10:00:00Z')),
      {
        type: 'user',
        isMeta: true,
        timestamp: at('2026-11-10T10:00:01Z'),
        message: { content: 'meta' },
      },
      prompt('<command-name>/model</command-name>', at('2026-11-10T10:00:02Z')),
      assistant(
        at('2026-11-10T10:00:03Z'),
        [
          { name: 'Read' },
          { name: 'Task' },
          { name: 'Skill', input: { skill: 'review' } },
          { name: 'TodoWrite', input: { todos: [{ status: 'completed' }, { status: 'pending' }] } },
        ],
        {
          input_tokens: 10,
          cache_creation_input_tokens: 90,
          cache_read_input_tokens: 900,
          output_tokens: 5,
        },
      ),
      {
        type: 'user',
        timestamp: at('2026-11-10T10:00:04Z'),
        message: { content: [{ type: 'tool_result', content: 'ok' }] },
      },
      prompt('next', at('2026-11-10T10:05:00Z')),
    ]);
    const reader = new AgentUsageReader({ claudeDir, codexDir, omcCeiling: root });
    const u = await reader.usage({
      sessionId: 'x',
      agent: 'claude-code',
      cwd,
      createdAt: 0,
      launchId: 's1',
    });
    expect(u?.model).toBe('Opus 5.5');
    expect(u?.context).toEqual({ usedTokens: 1000 });
    expect(u?.fiveHour).toBeUndefined();
    expect(u?.details).toMatchObject({
      prompts: 2,
      toolCalls: 2,
      agentCalls: 1,
      skillCalls: 1,
      lastSkill: 'review',
      todos: { done: 1, total: 2 },
      startedAt: Date.parse('2026-11-10T10:00:00Z'),
      lastPromptAt: Date.parse('2026-11-10T10:05:00Z'),
    });
  });

  it('reads only the new bytes on the next call, including a line cut in half', async () => {
    const file = await writeTranscript('s2', [prompt('one', at('2026-11-10T10:00:00Z'))]);
    const reader = new AgentUsageReader({ claudeDir, codexDir, omcCeiling: root });
    const tab = {
      sessionId: 'x',
      agent: 'claude-code' as const,
      cwd,
      createdAt: 0,
      launchId: 's2',
    };
    expect((await reader.usage(tab))?.details.prompts).toBe(1);
    const next = line(prompt('two', at('2026-11-10T10:01:00Z')));
    await appendFile(file, next.slice(0, 20));
    expect((await reader.usage(tab))?.details.prompts).toBe(1);
    await appendFile(file, next.slice(20));
    expect((await reader.usage(tab))?.details.prompts).toBe(2);
  });

  it('takes limits, effort, window size and cost from the OMC statusline cache', async () => {
    await writeTranscript('s3', [
      assistant(at('2026-11-10T10:00:00Z'), [], { input_tokens: 150_000 }),
    ]);
    const omc = join(cwd, '.omc', 'state', 'sessions', 's3');
    await mkdir(omc, { recursive: true });
    await writeFile(
      join(omc, 'hud-stdin-cache.json'),
      JSON.stringify({
        model: { id: 'claude-opus-5-5', display_name: 'Opus 5.5' },
        effort: { level: 'high' },
        context_window: { context_window_size: 1_000_000, used_percentage: 15 },
        rate_limits: {
          five_hour: { used_percentage: 8, resets_at: 1794334200 },
          seven_day: { used_percentage: 52 },
        },
        cost: { total_cost_usd: 2.5 },
      }),
    );
    const reader = new AgentUsageReader({ claudeDir, codexDir, omcCeiling: root });
    const u = await reader.usage({
      sessionId: 'x',
      agent: 'claude-code',
      cwd,
      createdAt: 0,
      launchId: 's3',
    });
    expect(u?.effort).toBe('high');
    expect(u?.context).toEqual({ usedPercent: 15, usedTokens: 150_000, windowTokens: 1_000_000 });
    expect(u?.fiveHour).toEqual({ usedPercent: 8, resetsAt: 1794334200_000 });
    expect(u?.weekly).toEqual({ usedPercent: 52 });
    expect(u?.details.costUsd).toBe(2.5);
  });

  it("borrows another session's limits in the same folder when its own cache has none", async () => {
    await writeTranscript('s4', [prompt('a', at('2026-11-10T10:00:00Z'))]);
    const other = join(cwd, '.omc', 'state', 'sessions', 'zzz');
    await mkdir(other, { recursive: true });
    await writeFile(
      join(other, 'hud-stdin-cache.json'),
      JSON.stringify({ rate_limits: { five_hour: { used_percentage: 30 } } }),
    );
    const reader = new AgentUsageReader({ claudeDir, codexDir, omcCeiling: root });
    const u = await reader.usage({
      sessionId: 'x',
      agent: 'claude-code',
      cwd,
      createdAt: 0,
      launchId: 's4',
    });
    expect(u?.fiveHour).toEqual({ usedPercent: 30 });
  });

  it('finds the OMC cache in a parent folder (the git top level)', async () => {
    await writeTranscript('s5', [prompt('a', at('2026-11-10T10:00:00Z'))]);
    const up = join(root, 'work', '.omc', 'state', 'sessions', 's5');
    await mkdir(up, { recursive: true });
    await writeFile(join(up, 'hud-stdin-cache.json'), JSON.stringify({ effort: { level: 'max' } }));
    const reader = new AgentUsageReader({ claudeDir, codexDir, omcCeiling: root });
    const u = await reader.usage({
      sessionId: 'x',
      agent: 'claude-code',
      cwd,
      createdAt: 0,
      launchId: 's5',
    });
    expect(u?.effort).toBe('max');
  });

  it('before the first message, shows what the OMC cache already knows', async () => {
    const omc = join(cwd, '.omc', 'state', 'sessions', 'fresh');
    await mkdir(omc, { recursive: true });
    await writeFile(
      join(omc, 'hud-stdin-cache.json'),
      JSON.stringify({ model: { display_name: 'Opus 5.5' }, effort: { level: 'high' } }),
    );
    const reader = new AgentUsageReader({ claudeDir, codexDir, omcCeiling: root });
    const u = await reader.usage({
      sessionId: 'x',
      agent: 'claude-code',
      cwd,
      createdAt: 0,
      launchId: 'fresh',
    });
    expect(u).toMatchObject({ model: 'Opus 5.5', effort: 'high', details: { prompts: 0 } });
  });

  it('returns null before the agent writes anything, and frees a file on forget', async () => {
    const reader = new AgentUsageReader({ claudeDir, codexDir, omcCeiling: root });
    expect(
      await reader.usage({ sessionId: 'a', agent: 'claude-code', cwd, createdAt: 0 }),
    ).toBeNull();
    await writeTranscript('only', [prompt('a', at('2026-11-10T10:00:00Z'))]);
    expect(
      await reader.usage({ sessionId: 'a', agent: 'claude-code', cwd, createdAt: 0 }),
    ).not.toBeNull();
    expect(
      await reader.usage({ sessionId: 'b', agent: 'claude-code', cwd, createdAt: 0 }),
    ).toBeNull();
    reader.forget('a');
    expect(
      await reader.usage({ sessionId: 'b', agent: 'claude-code', cwd, createdAt: 0 }),
    ).not.toBeNull();
  });
});

describe('AgentUsageReader: Codex', () => {
  it('reads model, effort, context, both limits and counts from the rollout', async () => {
    await writeRollout('2026-11-10', 'c1', cwd, at('2026-11-10T10:00:00Z'), [
      {
        timestamp: at('2026-11-10T10:00:01Z'),
        type: 'event_msg',
        payload: { type: 'task_started' },
      },
      {
        timestamp: at('2026-11-10T10:00:01Z'),
        type: 'turn_context',
        payload: { model: 'gpt-6.1-sol', effort: 'high' },
      },
      {
        timestamp: at('2026-11-10T10:00:02Z'),
        type: 'response_item',
        payload: { type: 'function_call' },
      },
      {
        timestamp: at('2026-11-10T10:00:02Z'),
        type: 'response_item',
        payload: { type: 'message' },
      },
      {
        timestamp: at('2026-11-10T10:00:03Z'),
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: { last_token_usage: { total_tokens: 47_500 }, model_context_window: 475_000 },
          rate_limits: {
            primary: { used_percent: 4, window_minutes: 300, resets_at: 100 },
            secondary: { used_percent: 20, window_minutes: 10080, resets_at: 200 },
          },
        },
      },
    ]);
    const reader = new AgentUsageReader({ claudeDir, codexDir, omcCeiling: root });
    const u = await reader.usage({
      sessionId: 'x',
      agent: 'codex',
      cwd,
      createdAt: Date.parse('2026-11-10T09:59:59Z'),
    });
    expect(u).toMatchObject({
      agent: 'codex',
      model: 'gpt-6.1-sol',
      effort: 'high',
      context: { usedTokens: 47_500, windowTokens: 475_000, usedPercent: 10 },
      fiveHour: { usedPercent: 4, resetsAt: 100_000 },
      weekly: { usedPercent: 20, resetsAt: 200_000 },
      details: { prompts: 1, toolCalls: 1, startedAt: Date.parse('2026-11-10T10:00:00Z') },
    });
  });
});

describe('readCodexModels', () => {
  it('lists visible models with their efforts', async () => {
    await mkdir(codexDir, { recursive: true });
    await writeFile(
      join(codexDir, 'models_cache.json'),
      JSON.stringify({
        models: [
          {
            slug: 'gpt-a',
            visibility: 'list',
            supported_reasoning_levels: [{ effort: 'low' }, { effort: 'max' }],
          },
          { slug: 'gpt-hidden', visibility: 'hide' },
          { slug: 'gpt-b' },
        ],
      }),
    );
    expect(await readCodexModels(codexDir)).toEqual([
      { id: 'gpt-a', label: 'gpt-a', efforts: ['low', 'max'] },
      { id: 'gpt-b', label: 'gpt-b', efforts: ['low', 'medium', 'high', 'xhigh'] },
    ]);
  });

  it('returns an empty list when the cache is missing or broken', async () => {
    expect(await readCodexModels(codexDir)).toEqual([]);
    await mkdir(codexDir, { recursive: true });
    await writeFile(join(codexDir, 'models_cache.json'), '{not json');
    expect(await readCodexModels(codexDir)).toEqual([]);
  });
});

describe('claudeModelName', () => {
  it('names model ids', () => {
    expect(claudeModelName('claude-opus-5-5')).toBe('Opus 5.5');
    expect(claudeModelName('claude-sonnet-4-20250514')).toBe('Sonnet 4');
    expect(claudeModelName('custom')).toBe('custom');
  });
});

describe('advance (incremental reads)', () => {
  it('keeps a character split between two chunks whole, over many small chunks', async () => {
    const text = '修好这个问题 ✅';
    const file = await writeTranscript('u1', [
      prompt(text, at('2026-11-10T10:00:00Z')),
      {
        type: 'assistant',
        timestamp: at('2026-11-10T10:00:01Z'),
        message: { content: [{ type: 'tool_use', name: 'Skill', input: { skill: text } }] },
      },
    ]);
    const cursors = new Map<string, Cursor<ClaudeTally>>();
    // 7 bytes per read splits the 3-byte CJK characters and the 3-byte emoji
    const tally = await advance(file, cursors, () => new ClaudeTally(), 7);
    expect(tally.prompts).toBe(1);
    expect(tally.lastSkill).toBe(text);
  });
});

describe('AgentUsageReader: other tabs', () => {
  it("never takes another open tab's transcript, even before that tab looked for it", async () => {
    await writeTranscript('sibling', [prompt('a', at('2026-11-10T10:00:00Z'))]);
    const reader = new AgentUsageReader({ claudeDir, codexDir, omcCeiling: root });
    const tab = { sessionId: 'x', agent: 'claude-code' as const, cwd, createdAt: 0 };
    expect(await reader.usage({ ...tab, otherLaunchIds: ['sibling'] })).toBeNull();
    expect(await reader.usage(tab)).not.toBeNull();
  });
});
