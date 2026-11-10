/**
 * @file src/shared/template-usage.test.ts
 * @purpose Rules for counting new tab page launches and picking the frequent choices.
 */
import { describe, expect, it } from 'vitest';
import {
  FREQUENT_MAX,
  FREQUENT_MIN_COUNT,
  FREQUENT_WINDOW_MS,
  TEMPLATE_USAGE_MAX_ENTRIES,
  frequentChoices,
  recordTemplateUsage,
  sanitizeTemplateUsage,
  templateUsageKey,
  type TemplateUsageEntry,
} from './template-usage';

const NOW = 1_800_000_000_000;

function entry(key: string, count: number, lastUsedAt = NOW): TemplateUsageEntry {
  return { key, count, lastUsedAt };
}

describe('templateUsageKey', () => {
  it('uses the template id for templates and a shell: prefix for detected shells', () => {
    expect(templateUsageKey('claude-code')).toBe('claude-code');
    expect(templateUsageKey('shell', 'pwsh')).toBe('shell:pwsh');
    expect(templateUsageKey('shell', null)).toBe('shell');
  });
});

describe('recordTemplateUsage', () => {
  it('adds a new entry with count 1', () => {
    expect(recordTemplateUsage([], 'codex', NOW)).toEqual([entry('codex', 1)]);
  });

  it('increments an existing entry and moves it to the end', () => {
    const before = [entry('codex', 2, NOW - 10), entry('claude-code', 5, NOW - 5)];
    expect(recordTemplateUsage(before, 'codex', NOW)).toEqual([
      entry('claude-code', 5, NOW - 5),
      entry('codex', 3, NOW),
    ]);
  });

  it('drops the least recently used entry when the list is full', () => {
    const full = Array.from({ length: TEMPLATE_USAGE_MAX_ENTRIES }, (_, i) =>
      entry(`t${i}`, 1, NOW - TEMPLATE_USAGE_MAX_ENTRIES + i),
    );
    const after = recordTemplateUsage(full, 'new', NOW);
    expect(after).toHaveLength(TEMPLATE_USAGE_MAX_ENTRIES);
    expect(after.find((e) => e.key === 't0')).toBeUndefined();
    expect(after[after.length - 1]).toEqual(entry('new', 1));
  });
});

describe('sanitizeTemplateUsage', () => {
  it('returns the empty file for anything that is not an object with entries', () => {
    expect(sanitizeTemplateUsage(null).entries).toEqual([]);
    expect(sanitizeTemplateUsage('x').entries).toEqual([]);
    expect(sanitizeTemplateUsage({ entries: 'nope' }).entries).toEqual([]);
  });

  it('keeps well formed entries and drops damaged or duplicate ones', () => {
    const out = sanitizeTemplateUsage({
      version: 1,
      entries: [
        entry('codex', 2),
        { key: '', count: 1, lastUsedAt: NOW },
        { key: 'a', count: 0, lastUsedAt: NOW },
        { key: 'b', count: 'many', lastUsedAt: NOW },
        { key: 'c', count: 1, lastUsedAt: 'yesterday' },
        { key: 'codex', count: 9, lastUsedAt: NOW },
        { key: 'd', count: 2.7, lastUsedAt: NOW },
        null,
      ],
    });
    expect(out.entries).toEqual([entry('codex', 2), entry('d', 2)]);
  });

  it('keeps only the newest entries when the file is over the limit', () => {
    const many = Array.from({ length: TEMPLATE_USAGE_MAX_ENTRIES + 5 }, (_, i) =>
      entry(`t${i}`, 1),
    );
    const out = sanitizeTemplateUsage({ version: 1, entries: many });
    expect(out.entries).toHaveLength(TEMPLATE_USAGE_MAX_ENTRIES);
    expect(out.entries[0]!.key).toBe('t5');
  });
});

describe('frequentChoices', () => {
  it('returns nothing when no button reaches the minimum count', () => {
    const entries = [entry('codex', FREQUENT_MIN_COUNT - 1), entry('claude-code', 1)];
    expect(frequentChoices(entries, ['codex', 'claude-code'], NOW).size).toBe(0);
  });

  it('makes the most launched button the favorite and the next ones frequent', () => {
    const entries = [
      entry('codex', 4),
      entry('claude-code', 9),
      entry('shell:pwsh', 3),
      entry('aider', 3, NOW - 1),
    ];
    const tiers = frequentChoices(entries, ['codex', 'claude-code', 'shell:pwsh', 'aider'], NOW);
    expect(tiers.get('claude-code')).toBe('favorite');
    expect(tiers.get('codex')).toBe('frequent');
    expect(tiers.get('shell:pwsh')).toBe('frequent');
    expect(tiers.has('aider')).toBe(false);
    expect(tiers.size).toBe(FREQUENT_MAX);
  });

  it('ignores buttons that are not on the page', () => {
    const entries = [entry('gemini-cli', 20), entry('codex', 3)];
    const tiers = frequentChoices(entries, ['codex'], NOW);
    expect(tiers.get('codex')).toBe('favorite');
    expect(tiers.has('gemini-cli')).toBe(false);
  });

  it('ignores habits older than the window', () => {
    const entries = [entry('codex', 50, NOW - FREQUENT_WINDOW_MS - 1), entry('aider', 3)];
    const tiers = frequentChoices(entries, ['codex', 'aider'], NOW);
    expect(tiers.get('aider')).toBe('favorite');
    expect(tiers.has('codex')).toBe(false);
  });

  it('breaks a tie on count by the more recent launch', () => {
    const entries = [entry('codex', 5, NOW - 100), entry('aider', 5, NOW)];
    const tiers = frequentChoices(entries, ['codex', 'aider'], NOW);
    expect(tiers.get('aider')).toBe('favorite');
    expect(tiers.get('codex')).toBe('frequent');
  });
});
