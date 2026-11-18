/**
 * @file src/shared/agent-skills.test.ts
 * @purpose Rules of the SKILL.md header reader (ADR-053): plain, quoted and block values, files
 *   without front matter, the folder name fallback and the description length cap.
 */
import { describe, expect, it } from 'vitest';
import {
  countSkills,
  frontMatterAsCode,
  MAX_SKILL_DESCRIPTION,
  parseSkillFrontMatter,
  skillEntryFrom,
} from './agent-skills';

describe('parseSkillFrontMatter', () => {
  it('reads plain name and description', () => {
    expect(
      parseSkillFrontMatter('---\nname: pdf\ndescription: Read PDF files\n---\n# PDF'),
    ).toEqual({
      name: 'pdf',
      description: 'Read PDF files',
    });
  });

  it('unquotes double and single quoted values', () => {
    const text = `---\nname: "imagegen"\ndescription: 'It''s for "images"'\n---`;
    expect(parseSkillFrontMatter(text)).toEqual({
      name: 'imagegen',
      description: `It's for "images"`,
    });
  });

  it('folds > and | block scalars into one line', () => {
    const text = '---\nname: plan\ndescription: >-\n  Plan a change\n  before code.\nother: x\n---';
    expect(parseSkillFrontMatter(text).description).toBe('Plan a change before code.');
    const literal = '---\ndescription: |\n  line one\n\n  line two\n---';
    expect(parseSkillFrontMatter(literal).description).toBe('line one line two');
  });

  it('joins wrapped plain values', () => {
    const text = '---\ndescription: Use when the user\n  asks for a review\nname: review\n---';
    expect(parseSkillFrontMatter(text)).toEqual({
      name: 'review',
      description: 'Use when the user asks for a review',
    });
  });

  it('handles CRLF and a BOM', () => {
    expect(parseSkillFrontMatter('\uFEFF---\r\nname: x\r\n---\r\n')).toEqual({ name: 'x' });
  });

  it('returns nothing without front matter', () => {
    expect(parseSkillFrontMatter('# Just a heading\nname: not-front-matter')).toEqual({});
    expect(parseSkillFrontMatter('')).toEqual({});
  });

  it('ignores keys after the closing fence', () => {
    expect(parseSkillFrontMatter('---\nname: a\n---\ndescription: body text')).toEqual({
      name: 'a',
    });
  });
});

describe('skillEntryFrom', () => {
  it('falls back to the folder name and an empty description', () => {
    expect(skillEntryFrom('my-skill', '/s/my-skill/SKILL.md', 'no header')).toEqual({
      name: 'my-skill',
      description: '',
      path: '/s/my-skill/SKILL.md',
    });
  });

  it('cuts a long description with an ellipsis', () => {
    const long = 'word '.repeat(400);
    const entry = skillEntryFrom('x', '/x', `---\ndescription: ${long}\n---`);
    expect(entry.description.length).toBe(MAX_SKILL_DESCRIPTION);
    expect(entry.description.endsWith('…')).toBe(true);
  });
});

describe('countSkills', () => {
  it('adds up 0, 1 and N groups', () => {
    const s = { name: 'a', description: '', path: '/a' };
    expect(countSkills([])).toBe(0);
    expect(countSkills([{ kind: 'personal', label: 'p', skills: [s] }])).toBe(1);
    expect(
      countSkills([
        { kind: 'personal', label: 'p', skills: [s, s] },
        { kind: 'plugin', label: 'q', skills: [s] },
      ]),
    ).toBe(3);
  });
});

describe('frontMatterAsCode', () => {
  it('turns front matter into a yaml code block and keeps the body', () => {
    expect(frontMatterAsCode('---\nname: a\ndescription: b\n---\n# Title\ntext')).toBe(
      '```yaml\nname: a\ndescription: b\n```\n# Title\ntext',
    );
  });

  it('handles CRLF, a BOM and the ... closing line', () => {
    expect(frontMatterAsCode('﻿---\r\nname: a\r\n...\r\nbody')).toBe('```yaml\nname: a\n```\nbody');
  });

  it('uses a fence longer than backticks inside the front matter', () => {
    expect(frontMatterAsCode('---\nx: "```"\n---\n')).toBe('````yaml\nx: "```"\n````\n');
  });

  it('leaves text without closed front matter unchanged', () => {
    expect(frontMatterAsCode('# Title\n---\n')).toBe('# Title\n---\n');
    expect(frontMatterAsCode('---\nname: a\nno end')).toBe('---\nname: a\nno end');
    const long = `---\n${'k: v\n'.repeat(250)}---\n`;
    expect(frontMatterAsCode(long)).toBe(long);
  });
});

describe('front matter edges', () => {
  it('ignores an unclosed header, so a body line cannot become the description', () => {
    expect(parseSkillFrontMatter('---\nname: a\n# Body\ndescription: not this')).toEqual({});
  });

  it('accepts ... as the closing line', () => {
    expect(parseSkillFrontMatter('---\nname: a\n...\ndescription: body')).toEqual({ name: 'a' });
  });

  it('leaves a note that opens with a horizontal rule unchanged', () => {
    const note = '---\nSome intro text.\n\n---\n# Section';
    expect(frontMatterAsCode(note)).toBe(note);
    expect(parseSkillFrontMatter(note)).toEqual({});
  });
});
