/**
 * @file src/shared/channel.ts
 * @purpose The one table of what keeps stable, beta and dev apart when they run side by
 *   side: stable is the daily driver that hosts real work, beta is for trying a build,
 *   and dev is npm run dev.
 *
 * @关键设计:
 * - Data folder, single-instance lock, app ID and exe name are separate too, but those
 *   come from the app name and the builder configs. This table holds what would otherwise
 *   be the same value in every build.
 * - tmuxSocket matters most. On a remote host every build reaches the same tmux server,
 *   so with one socket a beta test could attach to a real session and type into it.
 * - linkPort is only the default for a new data folder. A saved port is left alone.
 *
 * @不要在这里做的事:
 * - 不要让两个 channel 共用一个值,channel.test.ts 会失败
 */
import { LINK_DEFAULT_PORT } from './link-protocol';

export type Channel = 'stable' | 'beta' | 'dev';

export interface ChannelProfile {
  /** Shown in the title bar, the taskbar and the tray. */
  label: string;
  /** Passed to tmux -L on remote hosts. */
  tmuxSocket: string;
  /** Default Link host port. */
  linkPort: number;
}

export const CHANNELS: Record<Channel, ChannelProfile> = {
  stable: { label: 'Ceteris', tmuxSocket: 'ceteris', linkPort: LINK_DEFAULT_PORT },
  beta: { label: 'Ceteris Beta', tmuxSocket: 'ceteris-beta', linkPort: LINK_DEFAULT_PORT + 1 },
  dev: { label: 'Ceteris (dev)', tmuxSocket: 'ceteris-dev', linkPort: LINK_DEFAULT_PORT + 2 },
};
