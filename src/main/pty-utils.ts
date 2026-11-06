/**
 * @file src/main/pty-utils.ts
 * @purpose PtyController 用到的几个纯函数,抽到独立模块便于单测
 *   (PtyController 本身依赖 node-pty / Electron,直接测成本高)。
 *
 * @关键设计:
 * - 这里只放无副作用、不依赖 Electron / node-pty 的工具函数
 * - 添加新函数前问自己"能不能在不 mock electron 的前提下测",不能就别加
 *
 * @对应文档章节:
 *   软件定义书.md 5.1.4 (终端体验);
 *   ipc-protocol.md 7.1 (InvalidDimensions 错误码)
 */

/**
 * 把 process.env 里的 undefined 值过滤掉,转成 node-pty 要的纯 string 字典。
 * 同时剔除指定的环境变量 (例如 Electron 私有变量,避免污染子 shell)。
 *
 * @param sourceEnv 源环境变量 (通常是 process.env)
 * @param skipKeys 要排除的 key 集合
 */
/**
 * What a running Claude Code session puts in its children's environment. When Ceteris is
 * started from such a session these reach every terminal, and a Claude Code opened there
 * then treats itself as that session's child and stops saving its transcript. One is a
 * token for the parent session, so it should not spread either. User settings such as
 * CLAUDE_CODE_USE_BEDROCK are not listed, so they still reach the terminal.
 */
export const AGENT_SESSION_ENV = [
  'CLAUDECODE',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_JOB_DIR',
  'CLAUDE_PID',
  'CLAUDE_PLUGIN_DATA',
];

export function buildSpawnEnv(
  sourceEnv: NodeJS.ProcessEnv,
  skipKeys: Iterable<string> = [],
): Record<string, string> {
  const skip = new Set(skipKeys);
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(sourceEnv)) {
    if (typeof value === 'string' && !skip.has(key)) {
      result[key] = value;
    }
  }
  return result;
}

/**
 * 注入"终端宿主提示"环境变量,模仿 iTerm2 / WezTerm / VS Code 的做法,让子
 * shell 与跑在里面的 TUI 程序能识别终端能力 + 宿主身份。
 *
 * 写哪几个、为什么:
 * - TERM:                ncurses 程序 (vim / htop / less / tmux) 读它来选 terminfo。
 *                        默认 `xterm-256color` —— xterm.js 支持 256 色 + truecolor,
 *                        老的 `xterm-color` 会被识别为只支持 8 色,主题降级。
 * - COLORTERM:           24-bit 真彩色显式提示。starship / oh-my-posh / fzf /
 *                        bat / delta 等都看它决定要不要启 truecolor 渐变。
 * - TERM_PROGRAM:        宿主名字。用户 .bashrc / Profile.ps1 里可以分支
 *                        (`if $env:TERM_PROGRAM -eq 'Ceteris' ...`);第三方主题
 *                        也会嗅探用于 host detection。
 * - TERM_PROGRAM_VERSION:伴随 TERM_PROGRAM。若 appVersion 未给,主动 delete
 *                        从父终端继承下来的旧值(避免 Ceteris 从 VS Code 终端
 *                        启动时,子 shell 看到 `vscode` 的版本号)。
 *
 * 调用方应该在 buildSpawnEnv 之后、合并 launchParams.env / template.env 之前
 * 调用,这样自定义启动模板仍能覆盖(例如调试时硬塞 `TERM=dumb`)。
 *
 * 这些变量总是覆盖父进程继承的值 —— 否则 Ceteris 从别的终端启动时,子 shell
 * 会看到上游宿主的 TERM_PROGRAM (比如 `vscode`),完全不对。
 */
export function injectTerminalHintEnv(
  env: Record<string, string>,
  options: {
    /** 写到 TERM_PROGRAM。生产传 'Ceteris'。 */
    programName: string;
    /** 写到 TERM_PROGRAM_VERSION;空 / 缺失时主动 delete 继承值。 */
    appVersion?: string;
    /** 覆盖 TERM,默认 `xterm-256color`。 */
    term?: string;
    /** 覆盖 COLORTERM,默认 `truecolor`。 */
    colorTerm?: string;
  },
): Record<string, string> {
  env.TERM = options.term ?? 'xterm-256color';
  env.COLORTERM = options.colorTerm ?? 'truecolor';
  env.TERM_PROGRAM = options.programName;
  if (options.appVersion && options.appVersion.length > 0) {
    env.TERM_PROGRAM_VERSION = options.appVersion;
  } else {
    delete env.TERM_PROGRAM_VERSION;
  }
  return env;
}

/**
 * 把可能不合法的 cols/rows 约束到 [min, max] 之间。非整数 / NaN / 越界
 * 都会被替换成 fallback 值。
 *
 * 边界来自 ConPTY 经验:0 或负数会让 ConPTY 抛错;过大 (> 1000) 会内存
 * 占用激增。fallback 80x24 是终端事实标准。
 */
export function validateDimensions(
  cols: number,
  rows: number,
  options: { minCols?: number; maxCols?: number; minRows?: number; maxRows?: number } = {},
): { cols: number; rows: number } {
  const minCols = options.minCols ?? 1;
  const maxCols = options.maxCols ?? 1000;
  const minRows = options.minRows ?? 1;
  const maxRows = options.maxRows ?? 1000;
  return {
    cols: clamp(cols, minCols, maxCols, 80),
    rows: clamp(rows, minRows, maxRows, 24),
  };
}

function clamp(n: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(n) || !Number.isInteger(n)) return fallback;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}
