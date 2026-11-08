/**
 * @file tab-control.test.ts
 * @purpose Reading Claude Code's plugin registry for the coordinator guide (ADR-024): the
 *   guide ticks the install step only when ceteris-tabs is really listed.
 */
import { describe, expect, it } from 'vitest';
import { TAB_CONTROL_PLUGIN_ID, isClaudePluginInstalled } from './tab-control';

describe('isClaudePluginInstalled', () => {
  it('finds a plugin in the version 2 registry, one install per scope', () => {
    const registry = {
      version: 2,
      plugins: { [TAB_CONTROL_PLUGIN_ID]: [{ scope: 'user', version: '0.1.0' }] },
    };
    expect(isClaudePluginInstalled(registry, TAB_CONTROL_PLUGIN_ID)).toBe(true);
  });

  it('treats a missing, emptied or malformed registry as not installed', () => {
    expect(isClaudePluginInstalled(null, TAB_CONTROL_PLUGIN_ID)).toBe(false);
    expect(
      isClaudePluginInstalled({ plugins: { [TAB_CONTROL_PLUGIN_ID]: [] } }, TAB_CONTROL_PLUGIN_ID),
    ).toBe(false);
    expect(isClaudePluginInstalled({ plugins: 'x' }, TAB_CONTROL_PLUGIN_ID)).toBe(false);
    expect(isClaudePluginInstalled({ plugins: { 'other@x': [{}] } }, TAB_CONTROL_PLUGIN_ID)).toBe(
      false,
    );
  });
});
