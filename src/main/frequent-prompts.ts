/**
 * @file src/main/frequent-prompts.ts
 * @purpose Finds the messages the user sends to Claude Code and Codex again and again, so
 *   the next prompt guess can offer them in the user's own words.
 *
 * @关键设计:
 * - Reads the agents' own history files, ~/.claude/history.jsonl and ~/.codex/history.jsonl.
 *   They already hold every message the user sent, with editing and pastes resolved, which
 *   keystrokes typed into a terminal do not.
 * - Only the end of each file is read: the files grow without limit, and recent habits
 *   matter more than old ones.
 * - The result is kept until a file's size or time changes, because a guess runs on
 *   every idle moment and the files change only when the user sends a message.
 * - CLAUDE_CONFIG_DIR and CODEX_HOME move the files, as they do for the agents.
 *
 * @对应文档章节:无独立章节;用户入口是设置 → AI 助手 → 下一步提示建议,规则在
 *   src/shared/next-prompt.ts
 *
 * @不要在这里做的事:
 * - 不要写这些文件,它们属于 Claude Code 和 Codex
 * - 不要把读到的内容写进日志,里面是用户的私人消息
 */
import { open, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { logger } from './logger';
import { topFrequentPrompts, promptFromHistoryLine, type FrequentPrompt } from '@shared/next-prompt';

/** About the last two thousand messages of each agent. */
const TAIL_BYTES = 256 * 1024;

/** Where each agent keeps its history, following the agents' own overrides. */
export function agentHistoryFiles(env: NodeJS.ProcessEnv = process.env, home = homedir()): string[] {
  return [
    join(env['CLAUDE_CONFIG_DIR'] || join(home, '.claude'), 'history.jsonl'),
    join(env['CODEX_HOME'] || join(home, '.codex'), 'history.jsonl'),
  ];
}

/** The last TAIL_BYTES of a file, or '' when it does not exist. */
async function readTail(file: string, size: number): Promise<string> {
  const length = Math.min(size, TAIL_BYTES);
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    return buffer.toString('utf8');
  } finally {
    await handle.close();
  }
}

export class FrequentPromptReader {
  private signature = '';
  private cached: FrequentPrompt[] = [];

  constructor(private readonly files: string[] = agentHistoryFiles()) {}

  /**
   * The user's most repeated messages across both agents. Never throws: a missing or
   * unreadable file only means fewer habits to offer.
   */
  async get(): Promise<FrequentPrompt[]> {
    const stats = await Promise.all(this.files.map((f) => stat(f).catch(() => null)));
    const signature = stats.map((s) => (s ? `${s.size}:${s.mtimeMs}` : '-')).join('|');
    if (signature === this.signature) return this.cached;

    const prompts: string[] = [];
    for (const [i, file] of this.files.entries()) {
      const s = stats[i];
      if (!s?.isFile()) continue;
      try {
        for (const line of (await readTail(file, s.size)).split('\n')) {
          const text = promptFromHistoryLine(line);
          if (text !== null) prompts.push(text);
        }
      } catch (err) {
        logger.warn('FrequentPrompts', `cannot read ${file}; guesses go on without it`, err);
      }
    }
    this.cached = topFrequentPrompts(prompts);
    this.signature = signature;
    logger.debug('FrequentPrompts', `${this.cached.length} habits from ${prompts.length} messages`);
    return this.cached;
  }
}
