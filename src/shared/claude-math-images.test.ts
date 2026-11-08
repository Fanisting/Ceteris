/**
 * @file claude-math-images.test.ts
 * @purpose One test per rule: the typed line quotes the bundled folder and joins both commands the
 *          way each shell needs, and never ends in a newline, so the user's Enter runs it.
 */
import { describe, expect, it } from 'vitest';
import { latexMathInstallLine } from './claude-math-images';

const DIR = 'C:\\Program Files\\Ceteris\\resources\\extensions';
const INSTALL = 'claude plugin install latex-math@ceteris';

describe('latexMathInstallLine', () => {
  it('quotes the folder and joins the commands per shell, with no newline', () => {
    expect(latexMathInstallLine('cmd', DIR)).toBe(
      `claude plugin marketplace add "${DIR}" && ${INSTALL}`,
    );
    expect(latexMathInstallLine('pwsh', DIR)).toBe(
      `claude plugin marketplace add '${DIR}'; ${INSTALL}`,
    );
    expect(latexMathInstallLine('git-bash', DIR)).toBe(
      `claude plugin marketplace add '${DIR}'; ${INSTALL}`,
    );
    for (const shell of ['cmd', 'pwsh', 'powershell', 'git-bash', 'zsh']) {
      expect(latexMathInstallLine(shell, DIR)).not.toMatch(/[\r\n]/);
    }
  });

  it("escapes a ' in the folder for PowerShell and for POSIX shells", () => {
    expect(latexMathInstallLine('powershell', "C:\\O'Neil\\extensions")).toBe(
      `claude plugin marketplace add 'C:\\O''Neil\\extensions'; ${INSTALL}`,
    );
    expect(latexMathInstallLine('zsh', "/home/o'neil/extensions")).toBe(
      `claude plugin marketplace add '/home/o'\\''neil/extensions'; ${INSTALL}`,
    );
  });
});
