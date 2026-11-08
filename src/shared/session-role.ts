/**
 * @file src/shared/session-role.ts
 * @purpose Roles a tab can be given from its menu (ADR-024): Coordinator, which monitors and
 *   controls the other agents, and Fintuner, which reads the chat history for ways to save
 *   time. A tab without a role is a Worker. The roles are a recommended setup: they change the
 *   tab's name and row, not what runs in it.
 *
 * @关键设计:
 * - Both roles sit in the row above the tabs, at the same level, so a role also sets the
 *   session's coordinator flag (ADR-023), which the tab control pipe checks.
 * - Giving a role renames the tab to the role's name, so a glance at the row says who is who.
 *   The names are English in every language: they are what the tour and the docs call the roles.
 *
 * @不要在这里做的事:
 * - 不要在这里改名或广播 (那是 SessionManager.setRole)
 */

export type SessionRole = 'coordinator' | 'fintuner';

export const SESSION_ROLES: readonly SessionRole[] = ['coordinator', 'fintuner'];

/** The tab name each role gives its tab. */
export const SESSION_ROLE_NAMES: Readonly<Record<SessionRole, string>> = {
  coordinator: 'Coordinator',
  fintuner: 'Fintuner',
};

/** What a tab without a role is called in menus and the tour. */
export const WORKER_ROLE_NAME = 'Worker';

/** Validate a role coming over IPC: a known role, or null to clear it. */
export function isSessionRoleOrNull(value: unknown): value is SessionRole | null {
  return value === null || SESSION_ROLES.includes(value as SessionRole);
}
