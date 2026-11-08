/**
 * @file src/shared/session-status.ts
 * @purpose The two built-in sidebar filters, "Running" and "Needs you", and which sessions
 *   each one shows. Pure, so the rule can be tested without a store.
 *
 * @关键设计:
 * - Follows the ADR-020 rule: moving means the agent does not need you, still means it does.
 *   Running is a session whose tab waves. Needs you is an agent at an approval prompt or
 *   one that finished its turn and waits for the next prompt.
 * - A plain shell never needs you: without an agent there is no way to tell a finished
 *   command from one waiting for input, so it only counts as running while it prints.
 * - Exited sessions belong to neither filter.
 *
 * @对应文档章节:软件定义书.md ADR-020、ADR-021
 *
 * @不要在这里做的事:
 * - 不要读屏幕或字节流(那是 agent-phase.ts 和 SessionManager 的事),这里只看结果
 * - 不要放 coordinator 规则:coordinator 是用户手动标的,与 session 在做什么无关
 */
import type { SessionInfo } from './types';

/** A built-in filter that matches sessions by what they are doing, not folders by tag. */
export type SessionStatusFilter = 'running' | 'needs-you';

export const SESSION_STATUS_FILTERS: readonly SessionStatusFilter[] = ['running', 'needs-you'];

/**
 * Which built-in filter a session falls under, or null for neither.
 *
 * @param session only state and agentPhase are read
 */
export function sessionStatus(
  session: Pick<SessionInfo, 'state' | 'agentPhase'>,
): SessionStatusFilter | null {
  if (session.state === 'exited') return null;
  const phase = session.agentPhase ?? null;
  if (phase === 'blocked' || phase === 'done') return 'needs-you';
  if (phase === 'working' || (phase === null && session.state === 'active')) return 'running';
  return null;
}
