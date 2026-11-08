/**
 * @file claude-math-images.test.ts
 * @purpose One test per rule: the typed line joins both commands with the shell's separator and
 *          never ends in a newline, so the user's Enter runs it.
 */
import { describe, expect, it } from 'vitest';
import { latexMathInstallLine } from './claude-math-images';

describe('latexMathInstallLine', () => {
  it('joins both commands with && for cmd and ; for every other shell, with no newline', () => {
    expect(latexMathInstallLine('cmd')).toBe(
      'claude plugin marketplace add Fanisting/ceteris && claude plugin install latex-math@ceteris',
    );
    for (const shell of ['pwsh', 'powershell', 'git-bash', 'zsh']) {
      const line = latexMathInstallLine(shell);
      expect(line).toBe(
        'claude plugin marketplace add Fanisting/ceteris; claude plugin install latex-math@ceteris',
      );
      expect(line).not.toMatch(/[\r\n]/);
    }
  });
});
