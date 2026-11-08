// Types for tab-control-mcp.test.ts in the Ceteris repository. The server itself is plain JS.
type Env = Record<string, string | undefined>;
export const PROTOCOL_VERSION: number;
export const SERVER_VERSION: string;
export const KEY_NAMES: string[];
export const TOOLS: { name: string; description: string; inputSchema: unknown }[];
export function callCeteris(env: Env, op: string, args?: Record<string, unknown>): Promise<any>;
export function needsAttention(
  tab: { state: string; agentPhase: string | null; templateId: string },
  quietPolls: number,
): boolean;
export function waitForTab(
  env: Env,
  tabRef: string,
  timeoutMs: number,
  pollMs?: number,
  settleMs?: number,
): Promise<{ tab: any; timedOut: boolean }>;
export function runTool(
  env: Env,
  name: string,
  args?: Record<string, unknown>,
  options?: { pollMs?: number; settleMs?: number },
): Promise<string>;
export function handleMessage(
  env: Env,
  message: { jsonrpc?: string; id?: number | string | null; method: string; params?: any },
  options?: { pollMs?: number; settleMs?: number },
): Promise<any>;
