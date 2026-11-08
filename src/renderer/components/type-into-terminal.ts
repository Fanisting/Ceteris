/**
 * @file src/renderer/components/type-into-terminal.ts
 * @purpose Open a new shell tab and type one command into it without pressing Enter. The
 *   settings page (plugin install rows) and the coordinator guide both use it.
 *
 * @关键设计:
 * - Typing but not running is the consent step: the user reads the command, then presses Enter.
 * - The shell follows SessionManager.pickShell (default shell, else the first detected one), so
 *   buildLine knows how to quote and whether to join commands with `;` or `&&`.
 * - The window then shows the new tab and a toast says to press Enter.
 *
 * @不要在这里做的事:
 * - 不要替用户按 Enter (安装插件改的是用户的 Claude Code 配置,必须用户自己确认)
 */
import { useState } from 'react';
import {
  COMMAND_CHANNELS,
  type CreateSessionResponse,
  type ListShellsResponse,
} from '@shared/protocol';
import { useAppDispatch, useAppState } from '../store';
import { useTranslation } from './LanguageProvider';
import { useToast } from './Toast';

/**
 * Type text into a running tab without pressing Enter. SendInputPayload.data is base64 of the
 * UTF-8 bytes, the same path TerminalView uses for keyboard input.
 */
export async function typeIntoSession(sessionId: string, text: string): Promise<void> {
  const utf8 = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of utf8) binary += String.fromCharCode(byte);
  await window.api.invoke(COMMAND_CHANNELS.SESSION_SEND_INPUT, { sessionId, data: btoa(binary) });
}

export interface TypeIntoNewTerminal {
  /** True while the tab is being opened; buttons that call `run` disable themselves. */
  preparing: boolean;
  /**
   * Open the tab and type `buildLine(shellId)` into it. Failures go to `onError` with a
   * readable message (no shell detected, the session could not start, ...).
   */
  run: (
    buildLine: (shellId: string) => string,
    onError: (message: string) => void,
  ) => Promise<void>;
}

export function useTypeIntoNewTerminal(): TypeIntoNewTerminal {
  const { tx } = useTranslation();
  const state = useAppState();
  const dispatch = useAppDispatch();
  const toast = useToast();
  const [preparing, setPreparing] = useState(false);

  const run: TypeIntoNewTerminal['run'] = async (buildLine, onError) => {
    setPreparing(true);
    try {
      const { shells } = await window.api.invoke<unknown, ListShellsResponse>(
        COMMAND_CHANNELS.SETTINGS_LIST_SHELLS,
        {},
      );
      const preferred = state.settings.shell?.defaultShellId ?? '';
      const shell = shells.find((s) => s.id === preferred) ?? shells[0];
      if (!shell) throw new Error(tx('没有检测到可用的 shell', 'No shell was detected'));
      const dims = state.lastTerminalDims;
      const created = await window.api.invoke<unknown, CreateSessionResponse>(
        COMMAND_CHANNELS.SESSION_CREATE,
        { templateId: 'shell', shellId: shell.id, cols: dims.cols, rows: dims.rows },
      );
      // SendInputPayload.data 是 base64 (UTF-8 字节),与 TerminalView 的输入同一条路。
      const utf8 = new TextEncoder().encode(buildLine(shell.id));
      await window.api.invoke(COMMAND_CHANNELS.SESSION_SEND_INPUT, {
        sessionId: created.session.id,
        data: btoa(String.fromCharCode(...utf8)),
      });
      dispatch({ type: 'view/exit-settings' });
      dispatch({ type: 'view/select-path', pathId: created.session.pathId });
      dispatch({ type: 'view/select-session', sessionId: created.session.id });
      toast.push({
        kind: 'success',
        message: tx(
          '命令已经输入到新终端,检查后按 Enter 执行。',
          'The command is typed into a new terminal. Check it, then press Enter to run it.',
        ),
        durationMs: 8000,
      });
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setPreparing(false);
    }
  };

  return { preparing, run };
}
