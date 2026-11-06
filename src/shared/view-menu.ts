/**
 * @file src/shared/view-menu.ts
 * @purpose Decides what the title bar badge says and offers: Local, connected Hosts,
 *   Tailscale Hosts to connect to, and SSH servers. Pure, so the rules are testable
 *   without a renderer.
 *
 * @关键设计:
 * - The badge is the one place to reach another machine, so it always has a menu, even
 *   with nothing set up yet. That menu then offers to add a Host or a server.
 * - This is the only switcher. A Link Host replaces the whole window, while an SSH server
 *   only changes what the sidebar lists, but to the user they are the same question:
 *   which machine am I on?
 * - Inside a remote view, settings and SSH servers belong to the Host, and a Link
 *   connection made there would run on the wrong machine. So a remote view only offers
 *   the views that already exist.
 *
 * @不要在这里做的事:
 * - 不要在这里发起连接或读状态,这里只根据输入算结果
 */
import { VIEW_TARGET_LOCAL, type ViewTarget } from './protocol';
import type { LinkHostEntry } from './types';

export type SidebarSegment = 'local' | 'remote';

export interface ViewMenuInput {
  targets: ViewTarget[];
  segment: SidebarSegment;
  /** The SSH server of the selected folder, if it is on one. */
  selectedSshProfileId: string | null;
  savedHosts: LinkHostEntry[];
  linkClients: Array<{ address: string; state: string }>;
  sshProfiles: Array<{ id: string; name: string }>;
}

export type ViewMenuEntry =
  | { kind: 'view'; id: string; label: string; active: boolean }
  | { kind: 'link'; host: LinkHostEntry; connecting: boolean }
  | { kind: 'ssh'; id: string; label: string; active: boolean }
  | { kind: 'add-link' }
  | { kind: 'add-ssh' }
  | { kind: 'divider' };

const LOCAL_LABEL = 'Local';

/** A window with no reported state is a local window: nothing has replaced it. */
function activeRemote(targets: ViewTarget[]): ViewTarget | null {
  return targets.find((t) => t.active && t.id !== VIEW_TARGET_LOCAL) ?? null;
}

function selectedServer(input: ViewMenuInput): { id: string; name: string } | null {
  if (input.segment !== 'remote') return null;
  return input.sshProfiles.find((p) => p.id === input.selectedSshProfileId) ?? null;
}

/**
 * The connection to an address that is still in use. A closed one can stay in the list
 * after failing, and must neither block a retry nor speak for a newer attempt.
 */
export function liveClient<T extends { address: string; state: string }>(
  clients: T[],
  address: string,
): T | undefined {
  return clients.find((c) => c.address === address && c.state !== 'closed' && c.state !== 'idle');
}

/** The text on the badge. */
export function viewBadgeLabel(input: ViewMenuInput): string {
  const remote = activeRemote(input.targets);
  if (remote) return remote.label;
  if (input.segment !== 'remote') return LOCAL_LABEL;
  return selectedServer(input)?.name ?? 'SSH';
}

/** The menu under the badge, top to bottom. */
export function buildViewMenu(input: ViewMenuInput): ViewMenuEntry[] {
  const remote = activeRemote(input.targets);
  const server = selectedServer(input);
  const targets = input.targets.length
    ? input.targets
    : [{ id: VIEW_TARGET_LOCAL, label: LOCAL_LABEL, active: true }];

  const views: ViewMenuEntry[] = targets.map((t) => ({
    kind: 'view',
    id: t.id,
    label: t.label,
    // On an SSH server the window is still local, but the menu should tick what the
    // badge says, not Local.
    active: t.id === VIEW_TARGET_LOCAL ? !remote && input.segment === 'local' : t.active,
  }));
  if (remote) return views;

  const hosts: ViewMenuEntry[] = input.savedHosts
    // A connected Host is already listed above as a view.
    .filter((host) => liveClient(input.linkClients, `${host.host}:${host.port}`)?.state !== 'connected')
    .map((host) => ({
      kind: 'link',
      host,
      connecting: liveClient(input.linkClients, `${host.host}:${host.port}`) !== undefined,
    }));

  const servers: ViewMenuEntry[] = input.sshProfiles.map((p) => ({
    kind: 'ssh',
    id: p.id,
    label: p.name,
    active: server?.id === p.id,
  }));

  return [
    ...views,
    ...(hosts.length + servers.length > 0 ? [{ kind: 'divider' } as const] : []),
    ...hosts,
    ...servers,
    { kind: 'divider' },
    { kind: 'add-link' },
    { kind: 'add-ssh' },
  ];
}
