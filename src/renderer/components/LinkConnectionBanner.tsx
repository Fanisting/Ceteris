/**
 * @file src/renderer/components/LinkConnectionBanner.tsx
 * @purpose 远程窗口顶部的连接状态条(Marina Link)。
 *
 * @为什么需要它:
 * 远程窗口的 renderer **不知道**自己是远程的 —— 这正是 Marina Link 的设计
 * 目标(见 src/main/link/link-client.ts)。代价是:一旦连接断掉,终端会
 * 完全停止响应,而用户得不到任何解释:按键没回显、标签页不更新、看起来
 * 像应用卡死了。
 *
 * 所以 main 端专门给远程窗口定向推 evt:link:connection-state。这个组件是
 * 它唯一的消费者:连接正常时什么都不渲染(零视觉负担),一旦离开
 * 'connected' 就顶出一条状态条说明发生了什么、正在做什么。
 *
 * @关键设计:
 * - 普通(非远程)窗口永远收不到这个事件,因此这个组件在它们那里恒为 null,
 *   不需要任何"我是不是远程窗口"的条件判断。
 * - 不提供"手动重连"按钮:LinkClient 已经在按退避序列自动重连,再加一个
 *   按钮只会让用户在它已经在重试时反复点。
 * - 挂载时主动拉一次状态:重连会 reload 窗口,reload 期间推送的事件收不到。
 * - 重连后如果有未确认的输入,保留一条提示直到用户确认。这些输入可能已经执行,
 *   只有用户看过终端才知道要不要重发,所以 Marina 不替用户重发。
 */
import { useEffect, useState } from 'react';
import {
  COMMAND_CHANNELS,
  EVENT_CHANNELS,
  type LinkConnectionStatePayload,
} from '@shared/protocol';
import { Icon } from './icons';
import { useTranslation } from './LanguageProvider';

export function LinkConnectionBanner(): JSX.Element | null {
  const { tx } = useTranslation();
  const [conn, setConn] = useState<LinkConnectionStatePayload | null>(null);

  useEffect(() => {
    const unsubscribe = window.api.on<LinkConnectionStatePayload>(
      EVENT_CHANNELS.LINK_CONNECTION_STATE,
      (payload) => setConn(payload),
    );
    window.api
      .invoke<undefined, LinkConnectionStatePayload | null>(
        COMMAND_CHANNELS.LINK_GET_WINDOW_STATE,
        undefined,
      )
      .then((state) => {
        if (state) setConn(state);
      })
      .catch((err) => console.error('[LinkBanner] get-window-state failed', err));
    return unsubscribe;
  }, []);

  // 普通本地窗口拿到的是 null,什么都不渲染。
  if (!conn) return null;

  const unconfirmedNotice =
    conn.unconfirmedInputs > 0
      ? tx(
          `断线时有 ${conn.unconfirmedInputs} 次输入没有收到确认,可能已执行,也可能没有。请先看终端内容,再决定是否重新输入。`,
          `${conn.unconfirmedInputs} input(s) were not confirmed before the connection dropped. They may or may not have run. Check the terminal before sending them again.`,
        )
      : null;

  // 已连接且没有待确认的输入 = 一切正常,不打扰用户。
  if (conn.state === 'connected') {
    if (!unconfirmedNotice) return null;
    return (
      <div className="link-banner link-banner-reconnecting" role="status">
        <Icon name="alertTriangle" size={14} />
        <span className="link-banner-text">{unconfirmedNotice}</span>
        <button
          type="button"
          className="settings-button"
          onClick={() => {
            window.api
              .invoke(COMMAND_CHANNELS.LINK_ACK_UNCONFIRMED, undefined)
              .catch((err) => console.error('[LinkBanner] ack failed', err));
          }}
        >
          {tx('知道了', 'Got it')}
        </button>
      </div>
    );
  }

  const message = ((): string => {
    switch (conn.state) {
      case 'connecting':
        return tx(`正在连接 ${conn.address}…`, `Connecting to ${conn.address}…`);
      case 'reconnecting':
        return tx(
          `与 ${conn.hostName || conn.address} 的连接已断开,正在自动重连。远端会话继续运行,此时的输入不会发送,也不会在重连后补发。`,
          `Lost connection to ${conn.hostName || conn.address}. Reconnecting. Remote sessions keep running. Input typed now is not sent, and is not replayed after reconnecting.`,
        );
      case 'closed':
        return tx(
          `已断开与 ${conn.hostName || conn.address} 的连接。远端的会话仍在运行,重新连接即可继续。`,
          `Disconnected from ${conn.hostName || conn.address}. The sessions keep running there; reconnect to resume.`,
        );
      default:
        return tx('未连接', 'Not connected');
    }
  })();

  return (
    <div className={`link-banner link-banner-${conn.state}`} role="status">
      <Icon name="server" size={14} />
      <span className="link-banner-text">{message}</span>
      {conn.lastError && <span className="link-banner-detail">{conn.lastError}</span>}
    </div>
  );
}
