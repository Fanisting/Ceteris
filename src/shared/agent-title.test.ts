import { describe, expect, it } from 'vitest';
import {
  AGENT_TITLE_DEFAULT_GUIDE,
  agentTitleSystem,
  clampTitleLength,
  cleanAgentTitle,
  fitTitle,
  isAgentTemplate,
  shortenAgentTitle,
} from './agent-title';

describe('agent titles (ADR-029)', () => {
  it('cuts at a word boundary, or mid text when there are no spaces', () => {
    expect(fitTitle('Refactor the session manager idle timer', 24)).toBe('Refactor the session…');
    expect(fitTitle('重构会话管理器的空闲计时器逻辑', 8)).toBe('重构会话管理器…');
    expect(fitTitle('Short', 24)).toBe('Short');
  });

  it('drops leading spinner glyphs from an agent title', () => {
    expect(shortenAgentTitle('✳ Fix login', 24)).toBe('Fix login');
    expect(shortenAgentTitle('⠂ ✻ ', 24)).toBe('');
  });

  it('reads KEEP as no change and strips quotes, labels and end punctuation', () => {
    expect(cleanAgentTitle('KEEP', 24)).toBeNull();
    expect(cleanAgentTitle('Title: "Fix login bug."\nextra', 24)).toBe('Fix login bug');
    expect(cleanAgentTitle('  ', 24)).toBeNull();
  });

  it('uses the default guide when the user wrote none', () => {
    expect(agentTitleSystem('', 20)).toContain(AGENT_TITLE_DEFAULT_GUIDE);
    expect(agentTitleSystem('Chinese, max 6 characters', 20)).toContain(
      'Chinese, max 6 characters',
    );
  });

  it('holds the length inside 8 to 60', () => {
    expect(clampTitleLength(3)).toBe(8);
    expect(clampTitleLength(500)).toBe(60);
    expect(clampTitleLength('x')).toBe(24);
  });

  it('counts every built-in agent template, not shells', () => {
    const agents = ['claude-code', 'codex', 'opencode', 'gemini-cli', 'github-copilot', 'cursor', 'aider'];
    for (const id of agents) expect(isAgentTemplate(id)).toBe(true);
    expect(isAgentTemplate('shell')).toBe(false);
  });
});
