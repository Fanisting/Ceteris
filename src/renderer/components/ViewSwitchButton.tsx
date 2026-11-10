/**
 * @file src/renderer/components/ViewSwitchButton.tsx
 * @purpose The title bar badge: shows which machine this window is on and opens the menu
 *   that reaches any other one, over Tailscale or SSH. The rules are in
 *   shared/view-menu.ts; this file only connects them to the app.
 *
 * @关键设计:
 * - 远程设置引导 (ADR-032):还没配置任何远端、也没回答过的时候,点徽标先弹一个气泡问要不要
 *   让 AI agent 带着配;回答过之后菜单末尾留一项"让 AI 帮我配置…"随时可用。
 *
 * @不要在这里做的事:
 * - 不要在这里决定菜单内容,改 view-menu.ts,那里有测试
 */
import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react';
import {
  COMMAND_CHANNELS,
  EVENT_CHANNELS,
  VIEW_TARGET_LOCAL,
  type LinkConnectResponse,
  type LinkStatusResponse,
  type ViewStateResponse,
  type ViewSwitchPayload,
  type ViewTarget,
} from '@shared/protocol';
import type { LinkHostEntry } from '@shared/types';
import {
  buildViewMenu,
  liveClient,
  viewBadgeLabel,
  type ViewMenuEntry,
  type ViewMenuInput,
} from '@shared/view-menu';
import { useContextMenuApi, type ContextMenuItem } from './ContextMenu';
import { useTranslation } from './LanguageProvider';
import { ExpandMore } from './material-symbols';
import { RemoteSetupBubble, type RemoteSetupStep } from './RemoteSetupGuide';
import { useToast } from './Toast';
import { findPathNode, useAppDispatch, useAppState } from '../store';

/** Sidebar.tsx opens the folder picker for a server with no saved folder yet. */
export const PICK_REMOTE_FOLDER_EVENT = 'ceteris:pick-remote-folder';

export function ViewSwitchButton(): JSX.Element {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const menu = useContextMenuApi();
  const toast = useToast();
  const { tx } = useTranslation();
  const [targets, setTargets] = useState<ViewTarget[]>([]);
  const [linkClients, setLinkClients] = useState<LinkStatusResponse['clients']>([]);
  /** Hosts just clicked, so a failed connection is reported instead of doing nothing. */
  const pending = useRef(new Map<string, string>());
  const buttonRef = useRef<HTMLButtonElement>(null);
  /** The remote setup guide bubble (ADR-032), when open. */
  const [offer, setOffer] = useState<{ x: number; y: number; step: RemoteSetupStep } | null>(null);
  const closeOffer = useCallback(() => setOffer(null), []);

  const refreshViews = useCallback(() => {
    void window.api
      .invoke<undefined, ViewStateResponse>(COMMAND_CHANNELS.VIEW_GET_STATE, undefined)
      .then((res) => setTargets(res.targets))
      .catch(() => {});
  }, []);

  useEffect(() => {
    refreshViews();
    return window.api.on(EVENT_CHANNELS.VIEW_STATE_CHANGED, refreshViews);
  }, [refreshViews]);

  useEffect(() => {
    const apply = (status: LinkStatusResponse): void => {
      setLinkClients(status.clients);
      for (const [address, label] of pending.current) {
        const client =
          liveClient(status.clients, address) ?? status.clients.find((c) => c.address === address);
        if (client?.state === 'connected') {
          pending.current.delete(address);
        } else if (client?.lastError) {
          pending.current.delete(address);
          toast.push({
            kind: 'warn',
            message: tx(
              `连接 ${label} 失败:${client.lastError}`,
              `Could not connect to ${label}: ${client.lastError}`,
            ),
          });
        }
      }
    };
    void window.api
      .invoke<undefined, LinkStatusResponse>(COMMAND_CHANNELS.LINK_GET_STATUS, undefined)
      .then(apply)
      .catch(() => {});
    return window.api.on<LinkStatusResponse>(EVENT_CHANNELS.LINK_STATUS_CHANGED, apply);
  }, [toast, tx]);

  const selectedNode = state.selectedPathId
    ? findPathNode(state.pathTree, state.selectedPathId)
    : null;
  const input: ViewMenuInput = {
    targets,
    segment: state.sidebarSegment,
    selectedSshProfileId: selectedNode?.kind === 'ssh' ? selectedNode.sshProfileId : null,
    savedHosts: state.settings.link?.savedHosts ?? [],
    linkClients,
    sshProfiles: state.sshProfiles,
  };

  const showView = (id: string): void => {
    if (id === VIEW_TARGET_LOCAL) dispatch({ type: 'view/set-sidebar-segment', segment: 'local' });
    void window.api.invoke<ViewSwitchPayload, void>(COMMAND_CHANNELS.VIEW_SWITCH, { targetId: id });
  };

  const connectHost = async (host: LinkHostEntry): Promise<void> => {
    pending.current.set(`${host.host}:${host.port}`, host.label);
    toast.push({
      kind: 'info',
      message: tx(`正在连接 ${host.label}…`, `Connecting to ${host.label}…`),
    });
    try {
      await window.api.invoke<LinkHostEntry, LinkConnectResponse>(
        COMMAND_CHANNELS.LINK_CONNECT,
        host,
      );
    } catch (err) {
      pending.current.delete(`${host.host}:${host.port}`);
      toast.push({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  };

  /** Shows the server's folders, opening one if it has any saved. */
  const openServer = (profileId: string): void => {
    dispatch({ type: 'view/set-sidebar-segment', segment: 'remote' });
    const { bookmarks, temporary } = state.pathTree;
    const node = [...bookmarks, ...temporary].find(
      (n) => n.kind === 'ssh' && n.sshProfileId === profileId,
    );
    if (node) {
      dispatch({ type: 'view/select-path', pathId: node.id });
      return;
    }
    window.dispatchEvent(new CustomEvent(PICK_REMOTE_FOLDER_EVENT, { detail: { profileId } }));
  };

  const toItem = (entry: ViewMenuEntry): ContextMenuItem => {
    switch (entry.kind) {
      case 'view':
        return { label: entry.label, checked: entry.active, onSelect: () => showView(entry.id) };
      case 'link':
        return {
          label: `Tailscale · ${entry.host.label}${entry.connecting ? tx(' (连接中)', ' (connecting)') : ''}`,
          hint: `${entry.host.host}:${entry.host.port}`,
          disabled: entry.connecting,
          onSelect: () => connectHost(entry.host),
        };
      case 'ssh':
        return {
          label: `SSH · ${entry.label}`,
          checked: entry.active,
          onSelect: () => openServer(entry.id),
        };
      case 'add-link':
        return {
          label: tx('添加 Tailscale 主机…', 'Add Tailscale host…'),
          onSelect: () => dispatch({ type: 'view/enter-settings', category: 'link' }),
        };
      case 'add-ssh':
        return {
          label: tx('添加 SSH 服务器…', 'Add SSH server…'),
          onSelect: () => dispatch({ type: 'view/enter-settings', category: 'remote' }),
        };
      case 'setup-guide':
        return {
          label: tx('让 AI 帮我配置…', 'Set up with my AI agent…'),
          onSelect: () => openOffer('role'),
        };
      case 'divider':
        return { label: '', divider: true };
    }
  };

  const openOffer = (step: RemoteSetupStep): void => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    setOffer({ x: rect.left + rect.width / 2, y: rect.bottom, step });
  };

  // 还没配置任何远端、也没回答过引导时,第一次点徽标先问要不要让 AI 带着配 (ADR-032)。
  // 远端视图里不问:那里的设置属于 Host,引导也会在错的机器上跑。
  const nothingConfigured = input.savedHosts.length === 0 && input.sshProfiles.length === 0;
  const guideAnswered = state.settings.behavior?.remoteSetupGuideSeen ?? false;
  const inRemoteView = targets.some((t) => t.active && t.id !== VIEW_TARGET_LOCAL);

  const handleClick = (e: MouseEvent<HTMLButtonElement>): void => {
    if (offer) {
      setOffer(null);
      return;
    }
    if (nothingConfigured && !guideAnswered && !inRemoteView) {
      openOffer('offer');
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    menu.open({ x: rect.left, y: rect.bottom + 4, items: buildViewMenu(input).map(toItem) });
  };

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="titlebar-window-badge titlebar-view-switch"
        onClick={handleClick}
        title={tx('切换到其他机器', 'Switch to another machine')}
        aria-haspopup="menu"
      >
        {viewBadgeLabel(input)}
        <ExpandMore size={14} />
      </button>
      {offer && (
        <RemoteSetupBubble
          anchor={{ x: offer.x, y: offer.y }}
          initialStep={offer.step}
          onClose={closeOffer}
        />
      )}
    </>
  );
}
