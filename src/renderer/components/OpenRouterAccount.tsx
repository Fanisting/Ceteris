/**
 * @file src/renderer/components/OpenRouterAccount.tsx
 * @purpose The "Connect OpenRouter" button for next prompt suggestions. The user signs in
 *   and approves in the browser; main receives a key and stores it encrypted. The renderer
 *   never sees the key, only settings.ai.nextPrompt.keySaved.
 *
 * @对应文档章节:docs/软件定义书.md ADR-022
 *
 * @不要在这里做的事:
 * - 不要加输入框让用户粘贴 key(ADR-022 的初衷)
 */
import { useState } from 'react';
import { COMMAND_CHANNELS, type ConnectOpenRouterResponse } from '@shared/protocol';
import { useTranslation } from './LanguageProvider';

export function OpenRouterAccount({
  connected,
  onConnected,
  onError,
}: {
  connected: boolean;
  onConnected: () => void;
  onError: (message: string) => void;
}): JSX.Element {
  const { tx } = useTranslation();
  const [waiting, setWaiting] = useState(false);
  const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

  const connect = async (): Promise<void> => {
    setWaiting(true);
    try {
      const res = await window.api.invoke<undefined, ConnectOpenRouterResponse>(
        COMMAND_CHANNELS.AI_CONNECT_OPENROUTER,
        undefined,
      );
      if (res.connected) onConnected();
    } catch (err) {
      onError(tx(`连接失败:${message(err)}`, `Could not connect: ${message(err)}`));
    } finally {
      setWaiting(false);
    }
  };

  const cancel = (): void => {
    void window.api
      .invoke(COMMAND_CHANNELS.AI_CANCEL_OPENROUTER_CONNECT, undefined)
      .catch((err: unknown) => onError(message(err)));
  };

  const disconnect = (): void => {
    void window.api
      .invoke(COMMAND_CHANNELS.AI_DISCONNECT_OPENROUTER, undefined)
      .catch((err: unknown) => onError(message(err)));
  };

  if (waiting) {
    return (
      <>
        <span className="settings-usage">
          {tx('请在浏览器里登录并同意…', 'Approve in your browser…')}
        </span>
        <button type="button" className="settings-button" onClick={cancel}>
          {tx('取消', 'Cancel')}
        </button>
      </>
    );
  }
  if (connected) {
    return (
      <>
        <span className="settings-usage">{tx('已连接', 'Connected')}</span>
        <button type="button" className="settings-button" onClick={disconnect}>
          {tx('断开', 'Disconnect')}
        </button>
      </>
    );
  }
  return (
    <button type="button" className="settings-button" onClick={() => void connect()}>
      {tx('连接 OpenRouter', 'Connect OpenRouter')}
    </button>
  );
}
