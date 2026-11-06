import { describe, expect, it } from 'vitest';
import {
  MAX_TAG_LENGTH,
  MAX_TAGS_PER_FOLDER,
  countTags,
  matchesTags,
  normalizeTags,
} from './path-tags';

describe('normalizeTags', () => {
  it('tidies spacing and drops blanks', () => {
    expect(normalizeTags(['  job   market ', '', '   '])).toEqual(['job market']);
  });

  it('treats tags that differ by case as one and keeps the first spelling', () => {
    expect(normalizeTags(['Paper', 'paper', 'PAPER'])).toEqual(['Paper']);
  });

  it('ignores anything that is not a list of strings', () => {
    expect(normalizeTags('paper')).toEqual([]);
    expect(normalizeTags(null)).toEqual([]);
    expect(normalizeTags(['paper', 3, null])).toEqual(['paper']);
  });

  it('caps the length of a tag and the number per folder', () => {
    expect(normalizeTags(['x'.repeat(100)])[0]).toHaveLength(MAX_TAG_LENGTH);
    const many = Array.from({ length: 50 }, (_, i) => `tag${i}`);
    expect(normalizeTags(many)).toHaveLength(MAX_TAGS_PER_FOLDER);
  });
});

describe('countTags', () => {
  it('counts folders per tag, sorted by name', () => {
    const folders = [{ tags: ['teaching', 'paper'] }, { tags: ['paper'] }, {}];
    expect(countTags(folders)).toEqual([
      { name: 'paper', count: 2 },
      { name: 'teaching', count: 1 },
    ]);
  });
});

describe('matchesTags', () => {
  it('matches everything when nothing is selected', () => {
    expect(matchesTags(undefined, [])).toBe(true);
  });

  it('needs every selected tag', () => {
    expect(matchesTags(['paper', 'teaching'], ['paper', 'teaching'])).toBe(true);
    expect(matchesTags(['paper'], ['paper', 'teaching'])).toBe(false);
    expect(matchesTags(undefined, ['paper'])).toBe(false);
  });
});
