/**
 * @file src/main/platform/askpass.ts
 * @purpose ssh 的 SSH_ASKPASS 与 Ceteris 之间的约定:环境变量名、管道上的消息格式。
 *   纯逻辑,askpass-server.ts 和 sftp-client.ts 引用它;助手程序(C#,见
 *   askpass-helper-source.ts)按同一格式实现,改这里必须同步改那边。
 *
 * @关键设计:
 * - ssh 需要用户输入时(密码、Duo 验证码、主机密钥确认)会 exec `$SSH_ASKPASS "<提示>"`,
 *   从它的 stdout 读一行当答案。Ceteris 让这个助手把提示通过命名管道交给 main,
 *   由 main 决定自动回答(保存的密码)还是弹窗问用户。
 * - 助手是一个真正的 exe(见 WindowsAdapter.prepareSshAskpass),不是 .cmd:
 *   .cmd 会由 cmd.exe 解释,而提示文本来自服务器。`&calc` 这样的提示就能在用户机器上
 *   执行命令(CVE-2024-24576 的形态)。真正的 exe 收到的 argv 由 CommandLineToArgvW
 *   解析,提示里有什么都只是字符串。
 * - 密码只走管道:不进命令行(任务管理器可见),也不进环境变量(子进程都能读)。
 * - 一条管道连接只处理一个请求:助手连上、发一行 JSON、等一行 JSON、退出。
 *
 * @对应文档章节: 软件定义书.md 14.9
 *
 * @不要在这里做的事:
 * - 不要引用 electron 或 node:net,保持纯逻辑可测
 */

/** 命名管道(Windows)或 unix socket 的路径,main 启动 AskpassServer 后放进 ssh 的环境。 */
export const ASKPASS_PIPE_ENV = 'CETERIS_ASKPASS_PIPE';
/** 每条 ssh 连接一个随机令牌,main 用它找到提示属于哪条连接。 */
export const ASKPASS_TOKEN_ENV = 'CETERIS_ASKPASS_TOKEN';

/** 提示文本来自服务器,不能无限长。Duo 的菜单也就几百字节。 */
export const ASKPASS_MAX_REQUEST_BYTES = 64 * 1024;

/** 平台适配器给出的助手:怎么启动,以及要塞给 ssh 的额外环境变量。 */
export interface AskpassHelper {
  /** SSH_ASKPASS 的值,必须是真正的可执行文件 */
  command: string;
  /** 一并放进 ssh 环境的变量,助手进程会继承 */
  env: Record<string, string>;
}

export interface AskpassRequest {
  v: 1;
  token: string;
  /** ssh 传给 askpass 的提示,通常一行,如 "(me@host) Passcode or option (1-3): " */
  prompt: string;
  /** ssh 的 SSH_ASKPASS_PROMPT:confirm / none,大多数时候没有 */
  hint: string | null;
}

export type AskpassReply = { answer: string } | { cancel: true };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseLine(line: string): unknown {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    return null;
  }
}

export function encodeAskpassRequest(request: AskpassRequest): string {
  return `${JSON.stringify(request)}\n`;
}

/** 解析助手发来的请求行。格式不对返回 null,调用方按取消处理。 */
export function decodeAskpassRequest(line: string): AskpassRequest | null {
  if (Buffer.byteLength(line, 'utf8') > ASKPASS_MAX_REQUEST_BYTES) return null;
  const value = parseLine(line);
  if (!isRecord(value) || value['v'] !== 1) return null;
  const { token, prompt, hint } = value;
  if (typeof token !== 'string' || token.length === 0 || typeof prompt !== 'string') return null;
  if (hint !== null && hint !== undefined && typeof hint !== 'string') return null;
  return { v: 1, token, prompt, hint: hint ?? null };
}

export function encodeAskpassReply(reply: AskpassReply): string {
  return `${JSON.stringify(reply)}\n`;
}

export function decodeAskpassReply(line: string): AskpassReply | null {
  const value = parseLine(line);
  if (!isRecord(value)) return null;
  if (value['cancel'] === true) return { cancel: true };
  return typeof value['answer'] === 'string' ? { answer: value['answer'] } : null;
}
