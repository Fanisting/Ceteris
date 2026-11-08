/**
 * @file terminal-math.test.ts
 * @purpose One test per rule of findTerminalMath and the Codex instruction command.
 */
import { describe, expect, it } from 'vitest';
import {
  CODEX_MATH_INSTRUCTION,
  codexMathInstructionCommand,
  findTerminalMath,
} from './terminal-math';

describe('findTerminalMath', () => {
  it('finds $$...$$ and \\[...\\] alone on a line as display math', () => {
    expect(findTerminalMath('  $$\\frac{a}{b}$$  ')).toEqual([
      { start: 2, end: 17, tex: '\\frac{a}{b}', display: true },
    ]);
    expect(findTerminalMath('\\[ x^2 \\]')[0]).toMatchObject({ tex: 'x^2', display: true });
  });

  it('draws \\(...\\), and $$...$$ inside a sentence, inline', () => {
    const spans = findTerminalMath('so \\(d_k\\) grows and $$\\sqrt{d_k}$$ scales it');
    expect(spans.map((s) => [s.tex, s.display])).toEqual([
      ['d_k', false],
      ['\\sqrt{d_k}', false],
    ]);
    // \( and \) are signal enough, so a single letter counts too.
    expect(findTerminalMath('where \\(Q\\) and \\(V\\) are matrices').map((s) => s.tex)).toEqual([
      'Q',
      'V',
    ]);
  });

  it('ignores delimiters without TeX: shell variables, PIDs and prices', () => {
    expect(findTerminalMath('echo $$ and $$')).toEqual([]);
    expect(findTerminalMath('kill $$; costs $5 and $10')).toEqual([]);
    expect(findTerminalMath('$$ 12 + 3 $$')).toEqual([]);
  });
});

describe('codexMathInstructionCommand', () => {
  it('appends the instruction once, with no newline, for each kind of shell', () => {
    for (const shell of ['cmd', 'pwsh', 'powershell', 'git-bash']) {
      const line = codexMathInstructionCommand(shell);
      expect(line).toContain(CODEX_MATH_INSTRUCTION);
      expect(line).toContain('The Ceteris terminal typesets these');
      expect(line).not.toMatch(/[\r\n]/);
    }
    expect(codexMathInstructionCommand('pwsh')).toContain("Add-Content -Path $f -Value '");
    expect(codexMathInstructionCommand('git-bash')).toContain('>> ~/.codex/AGENTS.md');
  });

  it('keeps the instruction free of characters that break the quoting', () => {
    expect(CODEX_MATH_INSTRUCTION).not.toMatch(/['<>|&^%]/);
    // cmd: the ")" in "\(...\)" must not sit inside a parenthesised group.
    expect(codexMathInstructionCommand('cmd')).not.toMatch(/\(\s*(findstr|echo|if)/);
  });
});
