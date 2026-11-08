/**
 * @file src/main/dev-debug-port.ts
 * @purpose Picks the Chrome DevTools Protocol port a dev build listens on, so tools such as
 *   Playwright or chrome://inspect can drive a running dev window, and reads back which port
 *   Chromium actually opened.
 *
 * @关键设计:
 * - Dev builds only (`!app.isPackaged`, checked in index.ts). Stable and beta never open a
 *   port: a CDP port gives full control of every terminal in the app.
 * - Chromium binds the port to 127.0.0.1, so it is not reachable from the network.
 * - By default Chromium picks any free port (port 0). A fixed default such as 9222 let only
 *   the first dev copy bind it; every other copy got no port at all and said nothing, and
 *   several sessions often run dev copies at once. The port it picked is written to
 *   `DevToolsActivePort` in the data folder and logged by index.ts.
 * - CETERIS_DEV_DEBUG_PORT fixes a port (for a tool that needs a known one), and `off` turns
 *   the port off.
 *
 * @不要在这里做的事:
 * - 不要在这里调用 app.commandLine 或读文件:这里只做纯解析,方便测试
 */

/** Port 0 asks Chromium for any free port. */
export const DEFAULT_DEV_DEBUG_PORT = 0;

/**
 * Reads CETERIS_DEV_DEBUG_PORT.
 *
 * @returns the port to ask for (0 means any free port), or null when the variable is `off`
 * @throws when the variable is set to anything other than `off` or a port from 1024 to
 *   65535, so a typo does not silently fall back to another port
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
        'Unset it to let Chromium pick any free port.',
    );
  }
  return port;
}

/**
 * Reads the port from the DevToolsActivePort file Chromium writes once the port is open.
 * Its first line is the port number, its second the browser target path.
 *
 * @returns the port, or null when the text does not start with a usable port
 */
export function parseDevToolsActivePort(text: string): number | null {
  const first = text.split(/\r?\n/, 1)[0]?.trim() ?? '';
  if (!/^\d+$/.test(first)) return null;
  const port = Number(first);
  return port >= 1 && port <= 65535 ? port : null;
}
