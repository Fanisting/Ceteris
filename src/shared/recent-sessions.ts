/**
 * @file src/shared/recent-sessions.ts
 * @purpose The per-window list of sessions the user worked in, newest first, and which one
 *   the sidebar's back chip returns to. Pure, so the rule can be tested without a store.
 *
 * @关键设计:
 * - One entry per session: selecting a session again moves it to the front instead of adding
 *   a second copy, so going back and forth between two sessions keeps the list short.
 * - The back target is the newest entry that is not on screen and still exists. Right after
 *   a switch that is the session the user just left, so one click swaps back, and a second
 *   click swaps again (like Alt+Tab between the last two).
 * - With nothing selected (the new terminal page) the target is the last session the user
 *   was on.
 * - The list is capped; a window only needs the last few to go back to.
 *
 * @对应文档章节:软件定义书.md ADR-049
 *
 * @不要在这里做的事:
 * - 不要决定"什么算一次选中":由 renderer store 在选中状态提交后调用 rememberSession,
 *   这样一次点击里先选文件夹再选 session 的中间状态不会被记进来
 * - 不要持久化:历史只在本窗口内存里,与选中状态一样
 * - 不要做打开 session 的副作用(claim / 聚焦别的窗口):那是 Sidebar 的点击逻辑
 */

/** How many sessions a window remembers. */
export const RECENT_SESSIONS_MAX = 8;

/**
 * The list with sessionId moved (or added) to the front.
 *
 * @param list current list, newest first; not changed
 * @param sessionId the session now on screen
 * @param max entries to keep, oldest dropped first
 * @returns the same list when sessionId is already first, so the store can skip a render
 */
export function rememberSession(
  list: readonly string[],
  sessionId: string,
  max = RECENT_SESSIONS_MAX,
): readonly string[] {
  if (list[0] === sessionId) return list;
  return [sessionId, ...list.filter((id) => id !== sessionId)].slice(0, max);
}

/**
 * The list without one session, or the same list when it was not there.
 * Called when a session is destroyed so the list does not fill with dead ids.
 */
export function forgetSession(list: readonly string[], sessionId: string): readonly string[] {
  return list.includes(sessionId) ? list.filter((id) => id !== sessionId) : list;
}

/**
 * The session the back chip goes to, or null when there is none.
 *
 * @param list remembered sessions, newest first
 * @param currentId the selected session, or null on the new terminal page
 * @param exists whether a session id is still alive (closed tabs are skipped)
 */
export function backTarget(
  list: readonly string[],
  currentId: string | null,
  exists: (sessionId: string) => boolean,
): string | null {
  return list.find((id) => id !== currentId && exists(id)) ?? null;
}
