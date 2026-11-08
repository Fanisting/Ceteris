/**
 * @file src/main/dev-debug-port.ts
 * @purpose Picks the Chrome DevTools Protocol port a dev build listens on, so tools such as
 *   Playwright or chrome://inspect can drive a running dev window.
 *
 * @关键设计:
 * - Dev builds only (`!app.isPackaged`, checked in index.ts). Stable and beta never open a
 *   port: a CDP port gives full control of every terminal in the app.
 * - Chromium binds the port to 127.0.0.1, so it is not reachable from the network.
 * - CETERIS_DEV_DEBUG_PORT picks another port, for example when two dev copies run at once
 *   (the second one cannot bind the same port), and `off` turns it off.
 *
 * @不要在这里做的事:
 * - 不要在这里调用 app.commandLine:这里只做纯解析,方便测试
 */

/** The usual CDP port, which chrome://inspect and most tools look at first. */
export const DEFAULT_DEV_DEBUG_PORT = 9222;

/**
 * Reads CETERIS_DEV_DEBUG_PORT.
 *
 * @returns the port to open, or null when the variable is `off`
 * @throws when the variable is set to anything other than `off` or a port from 1024 to
 *   65535, so a typo does not silently fall back to 9222 and collide with another copy
 */
export function devDebugPort(env: NodeJS.ProcessEnv): number | null {
  const raw = env['CETERIS_DEV_DEBUG_PORT']?.trim();
  if (raw === undefined || raw === '') return DEFAULT_DEV_DEBUG_PORT;
  if (raw.toLowerCase() === 'off') return null;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error(
      `[dev-debug-port] CETERIS_DEV_DEBUG_PORT="${raw}" is not a usable port. ` +
        'Use a whole number from 1024 to 65535, or "off" to open no debugging port. ' +
        `Unset it to use ${DEFAULT_DEV_DEBUG_PORT}.`,
    );
  }
  return port;
}
