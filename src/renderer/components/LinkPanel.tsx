/**
 * @file src/renderer/components/LinkPanel.tsx
 * @purpose 设置页的"远程访问"分类 UI(Ceteris Link)。分两块:
 *   - 本机作为 Host:开关、绑定地址、端口、访问令牌、已连入的客户端
 *   - 本机作为 Client:已保存的远端主机、连接 / 断开
 *
 * @关键设计:
 * - 这里只做 UI。所有状态来自 cmd:link:get-status,所有动作走 cmd:link:*。
 *   renderer 不持有任何连接状态的副本 —— 与 Ceteris "main 是唯一可信源" 的
 *   整体设计一致。
 * - 令牌默认遮罩显示。它等价于"这台机器上所有终端的完全访问权",不该在
 *   用户截图或录屏分享设置页时不小心泄露。
 * - 绑定地址下拉把 Tailscale 地址排在最前并标注"推荐",让最安全的选项也是
 *   最省事的选项。
 *
 * @对应文档章节: docs/远程访问指南.md;docs/ceteris-link-protocol.md
 *
 * @不要在这里做的事:
 * - 不要在 renderer 侧生成 token(必须由 main 用 node:crypto 生成)
 * - 不要缓存 status(它由 evt:link:status-changed 推动刷新)
 */
import { useCallback, useEffect, useState } from 'react';
import { useModal } from './Modal';
import {
  COMMAND_CHANNELS,
  EVENT_CHANNELS,
  type LinkConnectResponse,
  type LinkBindCandidate,
  type LinkListBindCandidatesResponse,
  type LinkRegenerateTokenResponse,
  type LinkStatusResponse,
} from '@shared/protocol';
import { LINK_DEFAULT_PORT } from '@shared/link-protocol';
import type { DeepPartial } from '@shared/types-helpers';
import type { LinkHostEntry, Settings } from '@shared/types';
import { useAppState } from '../store';
import { Icon } from './icons';
import { SettingRow } from './SettingsView';
import { useToast } from './Toast';
import { useTranslation } from './LanguageProvider';

interface LinkPanelProps {
  setError: (msg: string | null) => void;
}

/** 空状态,供 status 还没拉回来时渲染。 */
const EMPTY_STATUS: LinkStatusResponse = {
  host: { listening: false, boundAddress: '', port: 0, lastError: '', clients: [] },
  clients: [],
};

const TUTORIAL_KEY = 'ceteris.link.tutorial-seen';

/** Per-viewer convenience: if storage is unavailable the worst case is seeing it again. */
function tutorialSeen(): boolean {
  try {
    return localStorage.getItem(TUTORIAL_KEY) === '1';
  } catch {
    return false;
  }
}

function markTutorialSeen(): void {
  try {
    localStorage.setItem(TUTORIAL_KEY, '1');
  } catch {
    /* it just shows again next time */
  }
}

export function LinkPanel({ setError }: LinkPanelProps): JSX.Element {
  const { tx } = useTranslation();
  const state = useAppState();
  const toast = useToast();
  const modal = useModal();
  const link = state.settings?.link;

  const [status, setStatus] = useState<LinkStatusResponse>(EMPTY_STATUS);
  const [candidates, setCandidates] = useState<LinkBindCandidate[]>([]);
  const [tokenVisible, setTokenVisible] = useState(false);

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(
        await window.api.invoke<undefined, LinkStatusResponse>(
          COMMAND_CHANNELS.LINK_GET_STATUS,
          undefined,
        ),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [setError]);

  useEffect(() => {
    void refreshStatus();
    // main 在任一连接状态变化时推这个事件,避免 UI 轮询。
    return window.api.on<LinkStatusResponse>(EVENT_CHANNELS.LINK_STATUS_CHANGED, (payload) => {
      setStatus(payload);
    });
  }, [refreshStatus]);

  useEffect(() => {
    window.api
      .invoke<undefined, LinkListBindCandidatesResponse>(
        COMMAND_CHANNELS.LINK_LIST_BIND_CANDIDATES,
        undefined,
      )
      .then((r) => setCandidates(r.candidates))
      .catch(() => setCandidates([]));
  }, []);

  const update = useCallback(
    async (partial: DeepPartial<Settings>) => {
      setError(null);
      try {
        await window.api.invoke(COMMAND_CHANNELS.SETTINGS_UPDATE, { partial });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [setError],
  );

  /**
   * 打开 Host 开关。
   *
   * 令牌为空时先生成再开:settings 的校验规则禁止 hostEnabled=true 且 token 为空
   * (见 validateLinkSettings),顺序反了会直接报错。
   */
  const handleToggleHost = useCallback(
    async (enabled: boolean) => {
      if (enabled && !tutorialSeen()) {
        const go = await modal.confirm({
          title: tx('三步连上另一台电脑', 'Connect another PC in 3 steps'),
          message: tx(
            '1. 两台电脑都安装 Tailscale(tailscale.com/download),并登录同一账号。\n' +
              '2. 在这台电脑开启远程访问,然后复制访问令牌。\n' +
              '3. 在另一台电脑添加这台电脑的 100.x.y.z 地址,并粘贴令牌。',
            '1. Install Tailscale on both PCs (tailscale.com/download) and log in to the same account.\n' +
              '2. Turn on remote access here, then copy the access token.\n' +
              '3. On the other PC, add this PC\'s 100.x.y.z address and paste the token.',
          ),
          confirmLabel: tx('开始', 'Start'),
        });
        if (!go) return;
        markTutorialSeen();
      }
      if (enabled && !link?.hostToken) {
        try {
          const { token } = await window.api.invoke<undefined, LinkRegenerateTokenResponse>(
            COMMAND_CHANNELS.LINK_REGENERATE_TOKEN,
            undefined,
          );
          await update({ link: { hostToken: token, hostEnabled: true } });
          setTokenVisible(true);
          toast.push({
            kind: 'info',
            message: tx(
              '已生成访问令牌。把它复制到另一台机器的"连接到远端"里。',
              'Access token generated. Copy it into the other machine under "Connect to a host".',
            ),
          });
          return;
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
          return;
        }
      }
      await update({ link: { hostEnabled: enabled } });
    },
    [link?.hostToken, update, setError, toast, tx, modal],
  );

  const handleRegenerateToken = useCallback(async () => {
    try {
      await window.api.invoke<undefined, LinkRegenerateTokenResponse>(
        COMMAND_CHANNELS.LINK_REGENERATE_TOKEN,
        undefined,
      );
      toast.push({
        kind: 'success',
        message: tx(
          '已重新生成令牌。已连接的客户端不会立刻掉线,但重连时需要新令牌。',
          'Token regenerated. Connected clients stay up but will need the new token to reconnect.',
        ),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [toast, tx, setError]);

  const handleCopyToken = useCallback(async () => {
    if (!link?.hostToken) return;
    const ok = await window.api.clipboard.writeText(link.hostToken);
    toast.push({
      kind: ok ? 'success' : 'error',
      message: ok ? tx('访问令牌已复制', 'Access token copied') : tx('复制失败', 'Copy failed'),
    });
  }, [link?.hostToken, toast, tx]);

  if (!link) {
    return (
      <section className="settings-panel">
        <h2 className="settings-panel-title">{tx('远程访问', 'Remote access')}</h2>
        <p className="settings-info-text">{tx('设置加载中…', 'Loading settings…')}</p>
      </section>
    );
  }

  const bindIsWideOpen = link.hostBindAddress === '0.0.0.0';

  return (
    <section className="settings-panel">
      <h2 className="settings-panel-title">{tx('远程访问', 'Remote access')}</h2>

      <p className="settings-info-text" style={{ marginBottom: 16 }}>
        {tx(
          '把这台机器上正在跑的终端标签页(包括 AI agent)挂载到另一台机器。' +
            '会话本身始终留在这台机器上运行,另一台只是"显示器"。',
          'Attach the terminal tabs running on this machine (AI agents included) from another machine. ' +
            'The sessions keep running here; the other machine is just a display.',
        )}
      </p>

      {/* ── 本机作为 Host ───────────────────────────────────── */}
      <h3 className="link-subsection-title">
        {tx('允许其他机器连接到这台机器', 'Let other machines connect to this one')}
      </h3>

      <SettingRow
        label={tx('开启远程访问', 'Enable remote access')}
        hint={tx(
          '开启后,持有下方访问令牌的机器可以接管这里的终端会话',
          'Once on, any machine holding the access token below can attach to the terminals here',
        )}
      >
        <label className="settings-checkbox">
          <input
            type="checkbox"
            checked={link.hostEnabled}
            onChange={(e) => void handleToggleHost(e.target.checked)}
          />
        </label>
      </SettingRow>

      <SettingRow
        label={tx('绑定地址', 'Bind address')}
        hint={tx(
          '推荐选 Tailscale 地址:端口只对你自己的设备可见',
          'Prefer the Tailscale address: the port stays visible only to your own devices',
        )}
      >
        <select
          className="settings-input"
          value={link.hostBindAddress}
          onChange={(e) => void update({ link: { hostBindAddress: e.target.value } })}
        >
          <option value="auto">{tx('自动(优先 Tailscale)', 'Automatic (prefer Tailscale)')}</option>
          {candidates.map((c) => (
            <option key={c.address} value={c.address}>
              {c.label}
            </option>
          ))}
          <option value="0.0.0.0">{tx('0.0.0.0(所有网络接口)', '0.0.0.0 (all interfaces)')}</option>
        </select>
      </SettingRow>

      {bindIsWideOpen && (
        <p className="settings-info-text link-warn">
          {tx(
            '警告:绑定 0.0.0.0 意味着同一网络内的任何人都能看到这个端口。' +
              '访问仍然需要令牌,但除非你确实需要局域网访问,否则请改回 Tailscale 地址。',
            'Warning: binding 0.0.0.0 exposes this port to everyone on the same network. ' +
              'Access still needs the token, but prefer the Tailscale address unless you truly need LAN access.',
          )}
        </p>
      )}

      <SettingRow label={tx('端口', 'Port')}>
        <input
          type="number"
          className="settings-input link-input-narrow"
          min={1024}
          max={65535}
          value={link.hostPort}
          onChange={(e) => {
            const v = Number.parseInt(e.target.value, 10);
            if (Number.isFinite(v) && v >= 1024 && v <= 65535) {
              void update({ link: { hostPort: v } });
            }
          }}
        />
      </SettingRow>

      <SettingRow
        label={tx('访问令牌', 'Access token')}
        hint={tx(
          '等同于这台机器所有终端的完全访问权,请像密码一样对待',
          'Equivalent to full access to every terminal here. Treat it like a password.',
        )}
      >
        <div className="link-inline-group">
          <input
            type={tokenVisible ? 'text' : 'password'}
            className="settings-input"
            readOnly
            value={link.hostToken}
            placeholder={tx('尚未生成', 'Not generated yet')}
          />
          <button
            type="button"
            className="settings-button"
            onClick={() => setTokenVisible((v) => !v)}
          >
            {tokenVisible ? tx('隐藏', 'Hide') : tx('显示', 'Show')}
          </button>
          <button
            type="button"
            className="settings-button"
            onClick={() => void handleCopyToken()}
            disabled={!link.hostToken}
          >
            {tx('复制', 'Copy')}
          </button>
          <button
            type="button"
            className="settings-button"
            onClick={() => void handleRegenerateToken()}
          >
            {tx('重新生成', 'Regenerate')}
          </button>
        </div>
      </SettingRow>

      <HostStatusBlock status={status} onRefresh={refreshStatus} setError={setError} />

      {/* ── 本机作为 Client ─────────────────────────────────── */}
      <h3 className="link-subsection-title" style={{ marginTop: 28 }}>
        {tx('连接到远端机器', 'Connect to a host')}
      </h3>

      <SavedHostList hosts={link.savedHosts} status={status} update={update} setError={setError} />
    </section>
  );
}

/**
 * Host 侧状态:是否在监听、绑在哪、谁连着。
 */
function HostStatusBlock({
  status,
  onRefresh,
  setError,
}: {
  status: LinkStatusResponse;
  onRefresh: () => Promise<void>;
  setError: (m: string | null) => void;
}): JSX.Element {
  const { tx } = useTranslation();
  const host = status.host;

  const handleKick = async (virtualWindowId: string): Promise<void> => {
    try {
      await window.api.invoke(COMMAND_CHANNELS.LINK_KICK_CLIENT, { virtualWindowId });
      await onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="link-subblock">
      <div className="settings-row">
        <div className="settings-row-meta">
          <div className="settings-row-label">{tx('监听状态', 'Listening status')}</div>
        </div>
        <div className="settings-row-control">
          {host.listening ? (
            <span className="link-status link-status-ok">
              <Icon name="server" size={14} />
              {tx('正在监听', 'Listening on')} {host.boundAddress}:{host.port}
            </span>
          ) : (
            <span className="link-status link-status-idle">{tx('未开启', 'Off')}</span>
          )}
        </div>
      </div>

      {host.lastError && <p className="settings-info-text link-warn">{host.lastError}</p>}

      {host.listening && (
        <>
          <div className="settings-row-label" style={{ marginTop: 12 }}>
            {tx('已连接的客户端', 'Connected clients')}({host.clients.length})
          </div>
          {host.clients.length === 0 ? (
            <p className="settings-info-text">
              {tx(
                '暂无客户端。在另一台机器上填入上面的地址与令牌即可连入。',
                'No clients yet. Enter the address and token above on another machine to connect.',
              )}
            </p>
          ) : (
            <ul className="link-client-list">
              {host.clients.map((c) => (
                <li key={c.virtualWindowId} className="link-client-item">
                  <div>
                    <strong>{c.clientName}</strong>
                    <span className="settings-row-hint">
                      {c.remoteAddress} · Window {c.virtualWindowNumber} · Ceteris {c.clientVersion}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="settings-button danger"
                    onClick={() => void handleKick(c.virtualWindowId)}
                  >
                    {tx('断开', 'Disconnect')}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

/**
 * Client 侧:已保存的远端主机列表 + 新增表单。
 */
function SavedHostList({
  hosts,
  status,
  update,
  setError,
}: {
  hosts: LinkHostEntry[];
  status: LinkStatusResponse;
  update: (p: DeepPartial<Settings>) => Promise<void>;
  setError: (m: string | null) => void;
}): JSX.Element {
  const { tx } = useTranslation();
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ label: '', host: '', port: LINK_DEFAULT_PORT, token: '' });

  const handleAdd = async (): Promise<void> => {
    if (!draft.host.trim() || !draft.token.trim()) {
      setError(tx('地址与令牌都不能为空', 'Both the address and the token are required'));
      return;
    }
    const entry: LinkHostEntry = {
      id: `link-${Date.now()}`,
      label: draft.label.trim() || draft.host.trim(),
      host: draft.host.trim(),
      port: draft.port,
      token: draft.token.trim(),
      autoConnect: false,
    };
    await update({ link: { savedHosts: [...hosts, entry] } });
    setDraft({ label: '', host: '', port: LINK_DEFAULT_PORT, token: '' });
    setAdding(false);
  };

  const handleRemove = async (id: string): Promise<void> => {
    await update({ link: { savedHosts: hosts.filter((h) => h.id !== id) } });
  };

  const handleToggleAutoConnect = async (id: string, value: boolean): Promise<void> => {
    await update({
      link: {
        savedHosts: hosts.map((h) => (h.id === id ? { ...h, autoConnect: value } : h)),
      },
    });
  };

  const handleConnect = async (entry: LinkHostEntry): Promise<void> => {
    try {
      await window.api.invoke<typeof entry, LinkConnectResponse>(
        COMMAND_CHANNELS.LINK_CONNECT,
        entry,
      );
      toast.push({
        kind: 'info',
        message: tx(
          `正在连接 ${entry.label}…连上后会自动打开一个窗口。`,
          `Connecting to ${entry.label}… a window will open once connected.`,
        ),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleDisconnect = async (linkId: string): Promise<void> => {
    try {
      await window.api.invoke(COMMAND_CHANNELS.LINK_DISCONNECT, { linkId });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  /** 某个已保存主机当前是否有活动连接(按地址匹配)。 */
  const findActiveLink = (
    entry: LinkHostEntry,
  ): LinkStatusResponse['clients'][number] | undefined =>
    status.clients.find((c) => c.address === `${entry.host}:${entry.port}`);

  return (
    <div className="link-subblock">
      {hosts.length === 0 && !adding && (
        <p className="settings-info-text">
          {tx(
            '还没有保存的远端机器。点下面的按钮添加一台。',
            'No saved hosts yet. Add one with the button below.',
          )}
        </p>
      )}

      <ul className="link-client-list">
        {hosts.map((entry) => {
          const active = findActiveLink(entry);
          return (
            <li key={entry.id} className="link-client-item">
              <div>
                <strong>{entry.label}</strong>
                <span className="settings-row-hint">
                  {entry.host}:{entry.port}
                  {active && (
                    <>
                      {' · '}
                      <LinkStateBadge state={active.state} rttMs={active.rttMs} />
                    </>
                  )}
                </span>
                {active?.lastError && (
                  <span className="settings-row-hint link-warn">{active.lastError}</span>
                )}
                <label className="settings-checkbox link-inline-check">
                  <input
                    type="checkbox"
                    checked={entry.autoConnect}
                    onChange={(e) => void handleToggleAutoConnect(entry.id, e.target.checked)}
                  />
                  {tx('启动时自动连接', 'Connect on startup')}
                </label>
              </div>
              <div className="link-inline-group">
                {active && active.state !== 'closed' ? (
                  <button
                    type="button"
                    className="settings-button"
                    onClick={() => void handleDisconnect(active.linkId)}
                  >
                    {tx('断开', 'Disconnect')}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="settings-button"
                    onClick={() => void handleConnect(entry)}
                  >
                    {tx('连接', 'Connect')}
                  </button>
                )}
                <button
                  type="button"
                  className="settings-button danger"
                  onClick={() => void handleRemove(entry.id)}
                >
                  {tx('删除', 'Remove')}
                </button>
              </div>
            </li>
          );
        })}
      </ul>

      {adding ? (
        <div className="link-subblock">
          <SettingRow label={tx('名称', 'Name')}>
            <input
              className="settings-input"
              value={draft.label}
              placeholder={tx('例如:家里台式机', 'e.g. Home desktop')}
              onChange={(e) => setDraft({ ...draft, label: e.target.value })}
            />
          </SettingRow>
          <SettingRow
            label={tx('地址', 'Address')}
            hint={tx(
              '填对方的 Tailscale IP(100.x.y.z)或 MagicDNS 名字',
              "The other machine's Tailscale IP (100.x.y.z) or MagicDNS name",
            )}
          >
            <input
              className="settings-input"
              value={draft.host}
              placeholder="100.64.0.2"
              onChange={(e) => setDraft({ ...draft, host: e.target.value })}
            />
          </SettingRow>
          <SettingRow label={tx('端口', 'Port')}>
            <input
              type="number"
              className="settings-input link-input-narrow"
              min={1024}
              max={65535}
              value={draft.port}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  port: Number.parseInt(e.target.value, 10) || LINK_DEFAULT_PORT,
                })
              }
            />
          </SettingRow>
          <SettingRow
            label={tx('访问令牌', 'Access token')}
            hint={tx(
              '对方"设置 → 远程访问"里显示的那串字符',
              'The string shown under Settings → Remote access on the other machine',
            )}
          >
            <input
              type="password"
              className="settings-input"
              value={draft.token}
              onChange={(e) => setDraft({ ...draft, token: e.target.value })}
            />
          </SettingRow>
          <div className="link-inline-group">
            <button type="button" className="settings-button" onClick={() => void handleAdd()}>
              {tx('保存', 'Save')}
            </button>
            <button type="button" className="settings-button" onClick={() => setAdding(false)}>
              {tx('取消', 'Cancel')}
            </button>
          </div>
        </div>
      ) : (
        <button type="button" className="settings-button" onClick={() => setAdding(true)}>
          {tx('+ 添加远端机器', '+ Add a host')}
        </button>
      )}
    </div>
  );
}

/**
 * 连接状态徽章。颜色语义:绿=连着,黄=正在重连,灰=空闲/已关闭。
 */
function LinkStateBadge({
  state,
  rttMs,
}: {
  state: LinkStatusResponse['clients'][number]['state'];
  rttMs: number | null;
}): JSX.Element {
  const { tx } = useTranslation();
  const label: Record<typeof state, string> = {
    idle: tx('空闲', 'Idle'),
    connecting: tx('连接中…', 'Connecting…'),
    connected: tx('已连接', 'Connected'),
    reconnecting: tx('重连中…', 'Reconnecting…'),
    closed: tx('已断开', 'Disconnected'),
  };
  const tone =
    state === 'connected'
      ? 'ok'
      : state === 'reconnecting' || state === 'connecting'
        ? 'warn'
        : 'idle';
  return (
    <span className={`link-status link-status-${tone}`}>
      {label[state]}
      {state === 'connected' && rttMs !== null && ` (${rttMs}ms)`}
    </span>
  );
}
