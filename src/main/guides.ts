/**
 * @file src/main/guides.ts
 * @purpose Where the guide files an agent reads are on disk (ADR-032). The repository keeps them
 *   in `guides/`; an installed Ceteris ships that folder as `resources/guides` (electron-builder
 *   extraResources, outside asar so any agent can open the file by path).
 *
 * @关键设计:
 * - Same shape as bundledMarketplaceDir in claude-math-images.ts: a pure function of where the
 *   app is, so the test needs no Electron.
 * - Paths are built here, not in the renderer: the renderer does not know the separator of the
 *   machine it runs on.
 *
 * @不要在这里做的事:
 * - 不要在这里读文件内容 (agent 自己读;Ceteris 只给路径)
 */
import { join } from 'path';
import { REMOTE_SETUP_GUIDE_FILES, type RemoteSetupRole } from '@shared/remote-setup-guide';

export interface AppWhereabouts {
  isPackaged: boolean;
  resourcesPath: string;
  appPath: string;
}

/** The folder holding the shipped guides. */
export function bundledGuidesDir(where: AppWhereabouts): string {
  return join(where.isPackaged ? where.resourcesPath : where.appPath, 'guides');
}

/** Absolute path of each remote setup guide, by role. */
export function remoteSetupGuidePaths(where: AppWhereabouts): Record<RemoteSetupRole, string> {
  const dir = bundledGuidesDir(where);
  return {
    host: join(dir, REMOTE_SETUP_GUIDE_FILES.host),
    client: join(dir, REMOTE_SETUP_GUIDE_FILES.client),
  };
}
