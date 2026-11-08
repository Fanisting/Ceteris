/**
 * @file claude-math-images.test.ts
 * @purpose One test per rule: a malformed look is dropped, the session environment names the look
 *          file and Git Bash, and the look file holds the last reported look.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTempDataDir, removeTempDataDir } from './persistence';
import { TerminalLookFile, mathImagesEnv, parseTerminalLook } from './claude-math-images';

describe('claude-math-images', () => {
  let dir = '';
  beforeEach(async () => {
    dir = await createTempDataDir();
  });
  afterEach(async () => {
    await removeTempDataDir(dir);
  });

  it('drops a malformed look', () => {
    expect(
      parseTerminalLook({ foreground: 'red', background: '#f5f5f5', cellAspect: 0.4 }),
    ).toBeNull();
    expect(
      parseTerminalLook({ foreground: '#000000', background: '#ffffff', cellAspect: 5 }),
    ).toBeNull();
    expect(parseTerminalLook(null)).toBeNull();
  });

  it('names the look file and Git Bash in the session environment, and only those given', () => {
    const gitBash = 'C:/Program Files/Git/bin/bash.exe';
    expect(mathImagesEnv('/data/extensions/terminal-look.json', gitBash)).toEqual({
      LATEX_MATH_LOOK_FILE: '/data/extensions/terminal-look.json',
      LATEX_MATH_BASH: gitBash,
    });
    expect(mathImagesEnv(undefined)).toEqual({});
  });

  it('writes the last reported look to the look file', async () => {
    const file = new TerminalLookFile(join(dir, 'extensions', 'terminal-look.json'));
    await file.update(
      parseTerminalLook({ foreground: '#000000', background: '#ffffff', cellAspect: 0.5 })!,
    );
    await file.update(
      parseTerminalLook({ foreground: '#54494B', background: '#f5f5f5', cellAspect: 0.40741 })!,
    );
    expect(JSON.parse(await readFile(file.path, 'utf8'))).toEqual({
      foreground: '#54494b',
      background: '#f5f5f5',
      cellAspect: 0.407,
    });
  });
});
