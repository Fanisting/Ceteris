import { describe, expect, it } from 'vitest';
import {
  cleanSuggestion,
  detectAgent,
  formatModelPrice,
  nextPromptSystem,
  parseModelList,
  promptFromHistoryLine,
  topFrequentPrompts,
} from './next-prompt';

describe('detectAgent', () => {
  it('trusts the template', () => {
    expect(detectAgent('claude-code', '')).toBe('claude');
    expect(detectAgent('codex', '')).toBe('codex');
  });

  it('recognises an agent started by hand in a plain shell', () => {
    expect(detectAgent('shell', '  ? for shortcuts')).toBe('claude');
    expect(detectAgent('shell', '⏵⏵ bypass permissions on (shift+tab to cycle)')).toBe('claude');
    expect(detectAgent('shell', '⏵⏵ auto mode on (shift+tab to cycle)')).toBe('claude');
    expect(detectAgent('shell', 'gpt-5 high · 100% context left')).toBe('codex');
    expect(detectAgent('shell', 'ctrl + t transcript')).toBe('codex');
    expect(detectAgent('shell', '› Ask Codex to do anything ? for shortcuts')).toBe('codex');
  });

  it('stays out of ordinary terminals, where a prompt guess has no use', () => {
    expect(detectAgent('shell', 'PS C:\\Users\\me> git status')).toBeNull();
  });
});

describe('cleanSuggestion', () => {
  it('passes a plain instruction through', () => {
    expect(cleanSuggestion('Run the tests')).toBe('Run the tests');
    expect(cleanSuggestion('修正超时跳转的测试')).toBe('修正超时跳转的测试');
  });

  it('strips quotes and the prompt arrows models copy from the screen', () => {
    expect(cleanSuggestion('"Run the tests"')).toBe('Run the tests');
    expect(cleanSuggestion('› 修改超时跳转测试')).toBe('修改超时跳转测试');
  });

  it('keeps only the first line', () => {
    expect(cleanSuggestion('Run the tests\nThen commit')).toBe('Run the tests');
  });

  it('offers nothing when the model has no idea', () => {
    expect(cleanSuggestion('NONE')).toBeNull();
    expect(cleanSuggestion('none.')).toBeNull();
    expect(cleanSuggestion('   ')).toBeNull();
  });

  it('rejects a rambling answer rather than typing it', () => {
    expect(cleanSuggestion('x'.repeat(161))).toBeNull();
  });
});

describe('frequent prompts', () => {
  it('counts repeats regardless of case and spacing, keeps the latest spelling, and drops one offs', () => {
    const history = [
      'commit and push', 'Commit  and push', 'run the tests', 'commit and PUSH',
      'run the tests', 'run the tests', 'run the tests', 'fix the bug once', 'deploy', 'deploy',
    ];
    expect(topFrequentPrompts(history)).toEqual([
      { text: 'run the tests', count: 4 },
      { text: 'commit and PUSH', count: 3 },
    ]);
  });

  it('ignores pastes, multi line and long messages, and commands that leave the session', () => {
    const noise = [
      '[Pasted text #1 +20 lines]', 'look at [Image #1]', 'line one\nline two', 'x'.repeat(101),
      '/exit', '/model opus',
    ];
    expect(topFrequentPrompts(noise.flatMap((n) => [n, n, n]))).toEqual([]);
  });

  it('reads both history formats and skips a line cut in half', () => {
    expect(promptFromHistoryLine('{"display":"/clear","project":"p"}')).toBe('/clear');
    expect(promptFromHistoryLine('{"session_id":"s","text":"go on"}')).toBe('go on');
    expect(promptFromHistoryLine('ay":"half"}')).toBeNull();
  });

  it('adds the habits to the system message only when there are some', () => {
    expect(nextPromptSystem([])).not.toContain('often');
    expect(nextPromptSystem([{ text: 'commit and push', count: 5 }])).toContain('- commit and push (5 times)');
  });
});

describe('model list', () => {
  it('reads names and prices per million tokens, cheapest first, unpriced last', () => {
    const models = parseModelList({
      data: [
        { id: 'local-model' },
        { id: 'b/pricey', name: 'Pricey', pricing: { prompt: '0.000001', completion: '0.000002' } },
        { id: 'a/cheap', name: 'Cheap', pricing: { prompt: '0.00000005', completion: '0.00000008' } },
        { name: 'no id' },
        { id: 'img/only', architecture: { output_modalities: ['image'] } },
      ],
    });
    expect(models.map((m) => m.id)).toEqual(['a/cheap', 'b/pricey', 'local-model']);
    expect(models.map(formatModelPrice)).toEqual(['$0.050 / $0.080', '$1.00 / $2.00', '']);
    expect(models[2]?.name).toBe('local-model');
  });
});
