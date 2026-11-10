/**
 * @file src/renderer/components/AgentUpdateNoticeBridge.tsx
 * @purpose 把 main 发来的 agent 版本通知 (evt:agent:update-notice) 显示成 toast,
 *   并把 toast 上的按钮转回 main (cmd:agent:notice-action)。
 *
 *   通知种类见 @shared/protocol AgentUpdateNotice:
 *   - available:有新版本 → [升级] [关掉再开回来 (该 agent 有终端开着时)]
 *   - scheduled:倒计时后自动升级 → [立即升级] [跳过此版本],toast 停留到倒计时结束
 *   - waiting:agent 还开着,关掉后再升级 → [关掉再开回来] [跳过此版本]
 *   - done / failed:后台升级结果;失败时 [打开终端] 把留着报错的终端接到本窗口
 *   - reloading / reloaded:整体重载 (ADR-037) 的开始与结束
 *
 *   每个窗口都会收到同一条通知;按钮在 main 侧是幂等的,哪个窗口点都行。
 *   "关掉再开回来"按钮只在本窗口看到该 agent 还有终端开着时出现:没有终端就等于普通升级。
 *
 * @不要在这里做的事:
 * - 不要在 renderer 里决定何时升级:倒计时和排队都在 main (agent-auto-update.ts)
 */
import { useEffect, useRef } from 'react';
import {
  COMMAND_CHANNELS,
  EVENT_CHANNELS,
  type AgentNoticeActionPayload,
  type AgentUpdateNotice,
} from '@shared/protocol';
import { useAppDispatch, useAppState } from '../store';
import { useTranslation } from './LanguageProvider';
import { useToast, type ToastAction } from './Toast';

export function AgentUpdateNoticeBridge(): null {
  const toast = useToast();
  const dispatch = useAppDispatch();
  const { tx } = useTranslation();
  const state = useAppState();
  // 通知到达时才看 sessions;放 ref 免得每次 sessions 变化都重挂监听
  const sessionsRef = useRef(state.sessions);
  sessionsRef.current = state.sessions;

  useEffect(() => {
    const act = (templateId: string, action: AgentNoticeActionPayload['action']): void => {
      window.api
        .invoke<AgentNoticeActionPayload, void>(COMMAND_CHANNELS.AGENT_NOTICE_ACTION, {
          templateId,
          action,
        })
        .catch((err) => {
          console.warn('[AgentUpdateNotice] action failed', err);
          const msg = err instanceof Error ? err.message : String(err);
          toast.push({ kind: 'error', message: msg });
        });
    };

    const openTerminal = (sessionId: string, pathId: string): void => {
      window.api
        .invoke(COMMAND_CHANNELS.SESSION_CLAIM, { sessionId })
        .then(() => {
          dispatch({ type: 'view/select-path', pathId });
          dispatch({ type: 'view/select-session', sessionId });
        })
        .catch((err) => console.warn('[AgentUpdateNotice] open terminal failed', err));
    };

    const hasOpenTabs = (templateId: string): boolean => {
      for (const s of sessionsRef.current.values()) {
        if (s.templateId === templateId && s.state !== 'exited') return true;
      }
      return false;
    };
    const reloadAction = (templateId: string): ToastAction[] =>
      hasOpenTabs(templateId)
        ? [{ label: tx('关掉再开回来', 'Full reload'), onClick: () => act(templateId, 'reload') }]
        : [];

    const off = window.api.on<AgentUpdateNotice>(EVENT_CHANNELS.AGENT_UPDATE_NOTICE, (n) => {
      const versions = n.from && n.to ? `${n.from} → ${n.to}` : (n.to ?? '');
      switch (n.kind) {
        case 'available':
          toast.push({
            kind: 'info',
            message: tx(`${n.name} 有新版本 ${versions}`, `${n.name} ${versions} is available`),
            durationMs: 15_000,
            actions: [
              { label: tx('升级', 'Update'), onClick: () => act(n.templateId, 'update') },
              ...reloadAction(n.templateId),
              {
                label: tx('跳过此版本', 'Skip this version'),
                onClick: () => act(n.templateId, 'skip'),
              },
            ],
          });
          break;
        case 'scheduled': {
          const seconds = Math.round((n.delayMs ?? 0) / 1000);
          toast.push({
            kind: 'warn',
            message: tx(
              `${seconds} 秒后自动升级 ${n.name} ${versions}`,
              `Updating ${n.name} ${versions} in ${seconds} s`,
            ),
            durationMs: n.delayMs ?? 30_000,
            actions: [
              { label: tx('立即升级', 'Update now'), onClick: () => act(n.templateId, 'now') },
              {
                label: tx('跳过此版本', 'Skip this version'),
                onClick: () => act(n.templateId, 'skip'),
              },
            ],
          });
          break;
        }
        case 'waiting':
          toast.push({
            kind: 'info',
            message: tx(
              `${n.name} ${n.to ?? ''} 已就绪,关掉所有 ${n.name} 终端后自动升级`,
              `${n.name} ${n.to ?? ''} is ready and will update once every ${n.name} terminal is closed`,
            ),
            durationMs: 15_000,
            actions: [
              ...reloadAction(n.templateId),
              {
                label: tx('跳过此版本', 'Skip this version'),
                onClick: () => act(n.templateId, 'skip'),
              },
            ],
          });
          break;
        case 'done':
          toast.push({
            kind: 'success',
            message: tx(
              `${n.name} 已升级到 ${n.to ?? '最新版'}`,
              `${n.name} updated to ${n.to ?? 'the latest version'}`,
            ),
          });
          break;
        case 'failed': {
          const sessionId = n.sessionId;
          const pathId = n.pathId;
          toast.push({
            kind: 'error',
            message:
              n.exitCode !== undefined
                ? tx(
                    `${n.name} 升级失败 (退出码 ${n.exitCode})`,
                    `${n.name} update failed (exit code ${n.exitCode})`,
                  )
                : tx(`${n.name} 升级没有完成`, `${n.name} update did not finish`),
            durationMs: 20_000,
            ...(sessionId && pathId
              ? {
                  actions: [
                    {
                      label: tx('打开终端', 'Open terminal'),
                      onClick: () => openTerminal(sessionId, pathId),
                    },
                  ],
                }
              : {}),
          });
          break;
        }
        case 'reloading':
          toast.push({
            kind: 'info',
            message: tx(
              `正在关掉 ${n.tabs ?? 0} 个 ${n.name} 终端并更新,之后会开回来`,
              `Closing ${n.tabs ?? 0} ${n.name} ${n.tabs === 1 ? 'tab' : 'tabs'} to update; they will come back`,
            ),
            durationMs: 10_000,
          });
          break;
        case 'reloaded': {
          const tabs = n.tabs ?? 0;
          const back = tx(
            `${tabs} 个 ${n.name} 终端已开回来` +
              (n.continued ? `,已自动向 ${n.continued} 个发送 "continue"` : '') +
              (n.failedTabs ? `,${n.failedTabs} 个没开回来` : ''),
            `${tabs} ${n.name} ${tabs === 1 ? 'tab is' : 'tabs are'} back` +
              (n.continued ? `, "continue" sent to ${n.continued} automatically` : '') +
              (n.failedTabs ? `, ${n.failedTabs} could not be reopened` : ''),
          );
          // 指向第一个收到 continue 的终端,用户一眼能确认它接着干了
          const sessionId = n.sessionId;
          const pathId = n.pathId;
          const actions =
            sessionId && pathId
              ? [
                  {
                    label: n.continued
                      ? tx('看看它', 'Check the tab')
                      : tx('打开终端', 'Open terminal'),
                    onClick: () => openTerminal(sessionId, pathId),
                  },
                ]
              : [];
          toast.push(
            n.updated
              ? {
                  kind: 'success',
                  message: tx(
                    `${n.name} 已更新到 ${n.to ?? '最新版'}。${back}`,
                    `${n.name} updated to ${n.to ?? 'the latest version'}. ${back}`,
                  ),
                  durationMs: 15_000,
                  actions,
                }
              : {
                  kind: 'warn',
                  message: tx(
                    `${back},但 ${n.name} 没有更新成功 (仍是 ${n.to ?? n.from ?? '旧版本'})`,
                    `${back}, but ${n.name} did not update (still ${n.to ?? n.from ?? 'the old version'})`,
                  ),
                  durationMs: 20_000,
                  actions,
                },
          );
          break;
        }
      }
    });
    // 监听挂好了才报到:main 只在有窗口报到后才开始自动升级的倒计时
    window.api
      .invoke(COMMAND_CHANNELS.AGENT_NOTICES_READY, undefined)
      .catch((err) => console.warn('[AgentUpdateNotice] ready failed', err));
    return off;
  }, [toast, dispatch, tx]);

  return null;
}
