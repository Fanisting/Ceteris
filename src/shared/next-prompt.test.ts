import { describe, expect, it } from 'vitest';
import { cleanSuggestion, detectAgent } from './next-prompt';

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
