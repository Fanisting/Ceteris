// Types for open-written-hook.test.ts in the Ceteris repository. The hook itself is plain JS.
export interface HookFs {
  mtime(path: string): number | null;
  list(dir: string): string[];
}
export const BUILD_WINDOW_MS: number;
export function isAgentBookkeeping(path: string, home: string, temp: string): boolean;
export function builtPdf(command: unknown, cwd: string, now: number, fs: HookFs): string | null;
export function fileToOpen(
  input: unknown,
  env: { now: number; home: string; temp: string; fs: HookFs },
): string | null;
