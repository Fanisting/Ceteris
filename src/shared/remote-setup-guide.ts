/**
 * @file src/shared/remote-setup-guide.ts
 * @purpose The remote setup guide (ADR-032): when the user wants another machine connected and
 *   says yes, Ceteris opens a tab with their own AI agent and pastes a one-line prompt that
 *   points the agent at a shipped guide file (guides/remote-setup-host.md or
 *   remote-setup-client.md). This module holds the pure parts: which guide, which agent
 *   template, which platform, and the prompt text.
 *
 * @关键设计:
 * - Ceteris has no AI assistant of its own (软件定义书 13.2: 让 agent 自己做 agent). The guide is a
 *   markdown file the user's agent reads; the prompt only says who this machine is, which file
 *   to read and how to behave.
 * - The prompt is one line, like coordinator-prompts.ts: an agent folds multi-line pastes into a
 *   "[Pasted text]" block the user cannot read before pressing Enter.
 * - Pasted, never sent. The user reads the prompt and presses Enter (ADR-024 §6 convention).
 * - The platform comes from the renderer's user agent, the same test App.tsx uses for
 *   data-platform, so a Link remote view would describe the client machine; the guide is not
 *   offered there (view-menu.ts returns no add entries inside a remote view).
 *
 * @对应文档章节: 软件定义书.md ADR-032, 远程访问指南.md
 *
 * @不要在这里做的事:
 * - 不要在这里开标签或读设置 (那是 renderer 的 RemoteSetupGuide.tsx)
 * - 不要把指南正文放进 prompt (放 guides/ 下的文件,agent 自己读)
 */
import { AGENT_TEMPLATE_IDS } from './agent-title';
import type { QuickLaunchItem } from './quick-launch';

/** Host: let other machines connect here. Client: connect this machine to another one. */
export type RemoteSetupRole = 'host' | 'client';

export type GuidePlatform = 'win32' | 'darwin' | 'linux';

/** File names under the shipped guides folder, by role. */
export const REMOTE_SETUP_GUIDE_FILES: Readonly<Record<RemoteSetupRole, string>> = {
  host: 'remote-setup-host.md',
  client: 'remote-setup-client.md',
};

/** The platform from a browser user agent string; anything unrecognised counts as Windows. */
export function detectGuidePlatform(userAgent: string): GuidePlatform {
  const isLinux = /linux/i.test(userAgent) && !/android/i.test(userAgent);
  if (isLinux) return 'linux';
  if (/mac/i.test(userAgent)) return 'darwin';
  return 'win32';
}

const PLATFORM_NAMES: Record<GuidePlatform, { zh: string; en: string }> = {
  win32: { zh: 'Windows', en: 'Windows' },
  darwin: { zh: 'macOS', en: 'macOS' },
  linux: { zh: 'Linux', en: 'Linux' },
};

export interface RemoteSetupPromptInput {
  role: RemoteSetupRole;
  platform: GuidePlatform;
  /** Absolute path of the guide file on this machine. */
  guidePath: string;
  locale: 'zh-CN' | 'en-US';
}

/**
 * The one-line prompt pasted into the agent tab. Quotes around the path keep spaces in an
 * install directory together; any double quote inside the path is dropped rather than escaped,
 * since no agent reads a path through a shell here.
 */
export function buildRemoteSetupPrompt(input: RemoteSetupPromptInput): string {
  const path = input.guidePath.replace(/"/g, '');
  const os = PLATFORM_NAMES[input.platform];
  if (input.locale === 'zh-CN') {
    const goal =
      input.role === 'host'
        ? '帮我把这台电脑设置成可以用 SSH 连进来的主机,让我的其他电脑能在这里开终端。'
        : '帮我把这台电脑通过 SSH 连到另一台电脑,好在 Ceteris 里打开它的终端。';
    return (
      `${goal}这台电脑是 ${os.zh}。先读 "${path}" 这份指南,然后一步一步带我做:` +
      '先检查已经配好的部分,缺什么就帮我装,只问我你自己查不到的事,改动系统前先征得我同意。用中文和我交流。'
    );
  }
  const goal =
    input.role === 'host'
      ? 'Help me set up SSH access to this machine so my other machines can open terminals here.'
      : 'Help me connect this machine to another machine over SSH so I can open its terminals in Ceteris.';
  return (
    `${goal} This machine runs ${os.en}. First read the guide at "${path}", then walk me through it step by step: ` +
    'check what is already in place, install what is missing, ask me only what you cannot find out yourself, and get my okay before changing anything. Talk to me in English.'
  );
}

/**
 * The agent template the guide tab uses: the first agent in the user's quick launch list that
 * still exists, so the guide opens in whatever the user normally starts, else Claude Code.
 * Plain shells (shell / admin-shell and detected shells) are skipped; they cannot read a guide.
 */
export function pickGuideTemplateId(
  quickLaunch: readonly QuickLaunchItem[],
  templates: ReadonlyArray<{ id: string }>,
): string {
  const ids = new Set(templates.map((t) => t.id));
  for (const item of quickLaunch) {
    if (item.kind !== 'template') continue;
    if (item.id === 'shell' || item.id === 'admin-shell') continue;
    if (ids.has(item.id)) return item.id;
  }
  return AGENT_TEMPLATE_IDS[0] ?? 'claude-code';
}
