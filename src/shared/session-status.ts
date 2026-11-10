/**
 * @file src/shared/session-status.ts
 * @purpose The two built-in sidebar filters, "Running" and "Needs you", and which sessions
 *   each one shows. Pure, so the rule can be tested without a store.
 *
 * @关键设计:
 * - Needs you is a tab that finished a round you have not looked at yet (the store's
 *   unseenDoneSessionIds), or an agent waiting at an approval prompt. A tab you already saw
 *   finish leaves the filter, so the list holds only what is new.
 * - Running is an agent that is working, or a shell whose command is running. The shell hook
 *   reports every prompt, so a quiet command (npm run dev, ssh, a long build) still counts,
 *   and typing at the prompt does not.
 * - A shell without the hook (shellBusy unknown) falls back to the old rule: running only
 *   while it prints.
 * - Exited sessions belong to neither filter.
 *
 * @对应文档章节:软件定义书.md ADR-021、ADR-023
 *
 * @不要在这里做的事:
 * - 不要读屏幕或字节流(那是 agent-phase.ts 和 SessionManager 的事),这里只看结果
 * - 不要在这里判断"看没看过":那是 renderer store 的 unseenDoneSessionIds,由调用方传入
 * - 不要放 coordinator 规则:coordinator 是用户手动标的,与 session 在做什么无关
 */
import type { SessionInfo } from './types';

/** A built-in filter that matches sessions by what they are doing, not folders by tag. */
export type SessionStatusFilter = 'running' | 'needs-you';

export const SESSION_STATUS_FILTERS: readonly SessionStatusFilter[] = ['running', 'needs-you'];

/**
 * Which built-in filter a session falls under, or null for neither.
 *
 * @param session only state, agentPhase and shellBusy are read
 * @param unseenDone the session finished a round (agent turn or shell command) while the
 *   user was not looking, and they have not opened it since
 */
export function sessionStatus(
  session: Pick<SessionInfo, 'state' | 'agentPhase' | 'shellBusy'>,
  unseenDone = false,
): SessionStatusFilter | null {
  if (session.state === 'exited') return null;
  const phase = session.agentPhase ?? null;
  if (phase === 'blocked') return 'needs-you';
  if (phase === 'working') return 'running';
  if (unseenDone) return 'needs-you';
  if (phase === 'done') return null;
  const busy = session.shellBusy ?? null;
  if (busy !== null) return busy ? 'running' : null;
  return session.state === 'active' ? 'running' : null;
}
