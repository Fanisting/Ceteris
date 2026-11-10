/**
 * @file src/renderer/components/AgentModelControls.tsx
 * @purpose Model and effort controls for Claude Code and Codex (ADR-038):
 *   - FolderAgentDefaultsRows: under an opened folder in the sidebar, one row per agent that
 *     has a tab in it, written `CC [Opus] [high]`. Each bracket opens its own choice and sets
 *     what new tabs of that agent in the folder start with.
 *   - AgentStatusLine: at the left of the split-view row under the terminals, for the selected
 *     tab: `Sonnet - high - 3% (5h) - 10% (wk) - 10% (ctx)`. Model and effort each open a
 *     choice; the percentages open the details.
 *
 * @关键设计:
 * - Plain coloured text, no fills or outlines (the user's 2026-11-10 direction). Clickable
 *   words show a hover underline.
 * - Folder defaults live in settings.agents.folderDefaults, so every window sees a change at
 *   once and it survives restarts. Default for both fields removes the entry.
 * - A pick for a running tab makes the main process restart the agent in the same tab with
 *   session flags and resume the conversation (cmd:agent:switch-model, agent-model-switch.ts).
 *   The agents' own /model is not used: Claude Code saves it as the global default.
 * - Every click answers at once: a menu opens even while the agent is busy (its items are
 *   greyed with the reason), and the line says "switching" until the agent is back.
 * - The status line sits in the existing 34px split-view row, so no terminal is resized.
 * - Usage is polled for the selected tab only: every 5 s while the details are open, every
 *   15 s otherwise. The main process reads only the bytes added since the last poll.
 *
 * @对应文档章节: 软件定义书.md ADR-038, 6.2.3; ipc-protocol.md 5.12
 *
 * @不要在这里做的事:
 * - No keyboard shortcut to open the menus (软件定义书 13.2: mouse first).
 * - No file reading or PTY writes here; both belong to the main process.
 */
import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react';
import {
  CLAUDE_EFFORTS,
  COMPACT_SUGGEST_PERCENT,
  contextLevel,
  effortLevel,
  folderDefaultFor,
  modelAgentOf,
  modelLabel,
  withFolderDefault,
  type AgentUsage,
  type ModelAgent,
  type UsageWindow,
} from '@shared/agent-model';
import {
  COMMAND_CHANNELS,
  type AgentModelOptionsResponse,
  type AgentSwitchModelPayload,
  type AgentSwitchModelResponse,
  type AgentUsagePayload,
  type AgentUsageResponse,
} from '@shared/protocol';
import type { SessionInfo } from '@shared/types';
import { useAppState } from '../store';
import { useContextMenuApi, type ContextMenuItem } from './ContextMenu';
import { useToast } from './Toast';
import { useTranslation } from './LanguageProvider';

const AGENT_SHORT: Record<ModelAgent, string> = { 'claude-code': 'CC', codex: 'CX' };
const AGENT_NAME: Record<ModelAgent, string> = { 'claude-code': 'Claude Code', codex: 'Codex' };
const DETAILS_POLL_MS = 5_000;
const LINE_POLL_MS = 15_000;

type Tx = (zh: string, en: string) => string;

// ──────────────────────────────────────────────────────────────────
// Model options (fetched once per window)
// ──────────────────────────────────────────────────────────────────

let optionsPromise: Promise<AgentModelOptionsResponse> | null = null;

function loadOptions(): Promise<AgentModelOptionsResponse> {
  optionsPromise ??= window.api
    .invoke<undefined, AgentModelOptionsResponse>(COMMAND_CHANNELS.AGENT_MODEL_OPTIONS, undefined)
    .catch((err: unknown) => {
      // A later open tries again rather than keeping the failure
      optionsPromise = null;
      throw err;
    });
  return optionsPromise;
}

function useModelOptions(): AgentModelOptionsResponse | null {
  const [options, setOptions] = useState<AgentModelOptionsResponse | null>(null);
  useEffect(() => {
    let alive = true;
    loadOptions()
      .then((o) => alive && setOptions(o))
      .catch((err: unknown) => console.warn('[AgentModelControls] model options failed', err));
    return () => {
      alive = false;
    };
  }, []);
  return options;
}

/** The name the menus show for a model id ("GPT-6.1 Terra" for Codex), else modelLabel. */
function choiceLabel(
  agent: ModelAgent,
  id: string,
  options: AgentModelOptionsResponse | null,
): string {
  return options?.[agent].models.find((m) => m.id === id)?.label ?? modelLabel(agent, id);
}

/** Efforts for one model: its own list for Codex when known, else the agent's list. */
function effortsFor(
  agent: ModelAgent,
  options: AgentModelOptionsResponse | null,
  model: string,
): string[] {
  if (agent === 'claude-code') return [...CLAUDE_EFFORTS];
  const hit = options?.codex.models.find((m) => m.id === model);
  return hit?.efforts.length ? hit.efforts : (options?.codex.efforts ?? []);
}

/**
 * Menu items for one choice. `withDefault` adds "Default" (folder rows); `disabledHint`
 * greys every item and says why (a busy agent).
 */
function choiceItems(
  values: Array<{ id: string; label: string }>,
  current: string,
  onPick: (id: string) => void,
  opts: { withDefault?: string; disabledHint?: string },
): ContextMenuItem[] {
  const all = opts.withDefault ? [{ id: '', label: opts.withDefault }, ...values] : values;
  return all.map((v) => ({
    label: v.label,
    checked: v.id === current,
    ...(opts.disabledHint ? { disabled: true, hint: opts.disabledHint } : {}),
    onSelect: () => onPick(v.id),
  }));
}

/** Opens a menu just above (or below, near the top) the clicked word. */
function openAt(
  ctxMenu: ReturnType<typeof useContextMenuApi>,
  e: MouseEvent<HTMLElement>,
  title: string,
  items: ContextMenuItem[],
  above: boolean,
): void {
  e.stopPropagation();
  const r = e.currentTarget.getBoundingClientRect();
  // ContextMenu flips a menu that would leave the window, so y = top opens it upward
  ctxMenu.open({ x: r.left, y: above ? r.top - 4 : r.bottom + 4, title, items });
}

// ──────────────────────────────────────────────────────────────────
// Sidebar rows
// ──────────────────────────────────────────────────────────────────

/**
 * Rows under an opened folder, one per agent among `agents` (the agents that have a tab in
 * this folder; nothing renders when there are none).
 */
export function FolderAgentDefaultsRows({
  pathId,
  folderName,
  agents,
}: {
  pathId: string;
  folderName: string;
  agents: readonly ModelAgent[];
}): JSX.Element | null {
  const state = useAppState();
  const ctxMenu = useContextMenuApi();
  const toast = useToast();
  const { tx } = useTranslation();
  const options = useModelOptions();
  if (agents.length === 0) return null;
  const list = state.settings.agents?.folderDefaults;

  const save = (agent: ModelAgent, model: string, effort: string): void => {
    window.api
      .invoke(COMMAND_CHANNELS.SETTINGS_UPDATE, {
        partial: {
          agents: { folderDefaults: withFolderDefault(list, pathId, agent, { model, effort }) },
        },
      })
      .catch((err: unknown) =>
        toast.push({
          kind: 'error',
          message: tx(
            `保存默认模型失败:${err instanceof Error ? err.message : String(err)}`,
            `Could not save the default model: ${err instanceof Error ? err.message : String(err)}`,
          ),
        }),
      );
  };
  const defaultWord = tx('默认', 'Default');

  return (
    <ul className="folder-agent-rows" onClick={(e) => e.stopPropagation()}>
      {agents.map((agent) => {
        const v = folderDefaultFor(list, pathId, agent);
        const title = tx(
          `${folderName} 里新开的 ${AGENT_NAME[agent]}`,
          `New ${AGENT_NAME[agent]} tabs in ${folderName}`,
        );
        const models = (options?.[agent].models ?? []).map((m) => ({ id: m.id, label: m.label }));
        const efforts = effortsFor(agent, options, v.model).map((l) => ({ id: l, label: l }));
        return (
          <li
            key={agent}
            className="folder-agent-row"
            title={tx(
              `${AGENT_NAME[agent]}:这个文件夹里新开终端用的模型和 effort`,
              `${AGENT_NAME[agent]}: model and effort for new tabs in this folder`,
            )}
          >
            <span className="folder-agent-name">{AGENT_SHORT[agent]}</span>
            <span className="bracket-pick">
              [
              <button
                type="button"
                className={`bracket-value model${v.model ? '' : ' unset'}`}
                onClick={(e) =>
                  openAt(
                    ctxMenu,
                    e,
                    title,
                    choiceItems(models, v.model, (id) => save(agent, id, v.effort), {
                      withDefault: defaultWord,
                    }),
                    false,
                  )
                }
              >
                {v.model ? choiceLabel(agent, v.model, options) : defaultWord}
              </button>
              ]
            </span>
            <span className="bracket-pick">
              [
              <button
                type="button"
                className={`bracket-value effort-${effortLevel(v.effort)}${v.effort ? '' : ' unset'}`}
                onClick={(e) =>
                  openAt(
                    ctxMenu,
                    e,
                    title,
                    choiceItems(efforts, v.effort, (id) => save(agent, v.model, id), {
                      withDefault: defaultWord,
                    }),
                    false,
                  )
                }
              >
                {v.effort || defaultWord}
              </button>
              ]
            </span>
          </li>
        );
      })}
    </ul>
  );
}

// ──────────────────────────────────────────────────────────────────
// Status line in the split-view row
// ──────────────────────────────────────────────────────────────────

/** Polls the tab's usage while enabled; other tabs pass enabled=false and never call main. */
function useAgentUsage(
  sessionId: string | null,
  intervalMs: number,
  enabled: boolean,
): [AgentUsage | null, () => void] {
  const [usage, setUsage] = useState<AgentUsage | null>(null);
  const refresh = useCallback(() => {
    if (!sessionId) return;
    window.api
      .invoke<AgentUsagePayload, AgentUsageResponse>(COMMAND_CHANNELS.AGENT_USAGE, { sessionId })
      .then((res) => setUsage(res.usage))
      .catch((err: unknown) => console.warn('[AgentModelControls] usage failed', err));
  }, [sessionId]);
  useEffect(() => {
    setUsage(null);
    if (!enabled) return undefined;
    refresh();
    const timer = window.setInterval(refresh, intervalMs);
    return () => window.clearInterval(timer);
  }, [refresh, intervalMs, enabled]);
  return [usage, refresh];
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

function formatSpan(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

function limitLevel(p: number): 'ok' | 'warn' | 'high' {
  return p >= 90 ? 'high' : p >= 70 ? 'warn' : 'ok';
}

/** "3% (5h)", coloured by level; "— (5h)" when unknown */
function Share({
  name,
  percent,
  level,
}: {
  name: string;
  percent: number | undefined;
  level: 'ok' | 'warn' | 'high';
}): JSX.Element {
  return (
    <span className="agent-share">
      <span className={`agent-share-value ${percent === undefined ? 'none' : level}`}>
        {percent === undefined ? '—' : `${Math.round(percent)}%`}
      </span>{' '}
      <span className="agent-share-name">({name})</span>
    </span>
  );
}

function resetText(name: string, win: UsageWindow | undefined, now: number, tx: Tx): string {
  if (!win) return tx(`${name}:没有数据`, `${name}: no data`);
  const reset = win.resetsAt
    ? tx(
        `,${formatSpan(win.resetsAt - now)} 后重置`,
        `, resets in ${formatSpan(win.resetsAt - now)}`,
      )
    : '';
  return `${name}: ${Math.round(win.usedPercent)}%${reset}`;
}

/** The selected tab's agent line. Renders nothing unless that tab runs Claude Code or Codex. */
export function AgentStatusLine(): JSX.Element | null {
  const state = useAppState();
  const session: SessionInfo | null =
    (state.selectedSessionId && state.sessions.get(state.selectedSessionId)) || null;
  const agent = modelAgentOf(session?.templateId);
  const live = !!session && !!agent && session.state !== 'exited';
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [usage, refresh] = useAgentUsage(
    live ? session.id : null,
    detailsOpen ? DETAILS_POLL_MS : LINE_POLL_MS,
    live,
  );
  const options = useModelOptions();
  const [switching, setSwitching] = useState<string | null>(null);
  const ctxMenu = useContextMenuApi();
  const toast = useToast();
  const { tx } = useTranslation();
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Click outside or Escape closes the details
  useEffect(() => {
    if (!detailsOpen) return undefined;
    const onDown = (e: globalThis.MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setDetailsOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setDetailsOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [detailsOpen]);
  // A different tab never shows the previous tab's switching note or details
  useEffect(() => {
    setSwitching(null);
    setDetailsOpen(false);
  }, [session?.id]);

  if (!live || !agent) return null;

  // What runs now: Ceteris' own record first (it knows a switch before the agent reports it)
  const chosenModel = session.agentModel ?? '';
  const modelText = chosenModel
    ? choiceLabel(agent, chosenModel, options)
    : usage?.model
      ? choiceLabel(agent, usage.model, options)
      : tx('默认模型', 'Default model');
  const effortText = session.agentEffort || usage?.effort || '';
  const models = options?.[agent].models ?? [];
  const activeModelId =
    chosenModel ||
    models.find((m) =>
      agent === 'codex'
        ? m.id === usage?.model
        : usage?.model?.toLowerCase().startsWith(m.label.toLowerCase()),
    )?.id ||
    '';
  const busy = session.agentPhase === 'working' || session.agentPhase === 'blocked';
  const busyHint = busy
    ? tx('agent 正在忙,等它停下来再换', 'The agent is busy; change it when it waits for you')
    : switching
      ? tx('正在切换', 'A switch is running')
      : undefined;
  const now = Date.now();
  const ctx = usage?.context;
  const ctxPct = ctx?.usedPercent;

  const pick = async (next: { model?: string; effort?: string }, label: string): Promise<void> => {
    setSwitching(label);
    try {
      const res = await window.api.invoke<AgentSwitchModelPayload, AgentSwitchModelResponse>(
        COMMAND_CHANNELS.AGENT_SWITCH_MODEL,
        { sessionId: session.id, ...next },
      );
      if (res.applied) {
        toast.push({
          kind: 'success',
          message:
            res.resumed === false
              ? tx(
                  `已换成 ${label},没找到之前的对话,开始了新对话`,
                  `Switched to ${label}. No earlier conversation was found, so a new one started.`,
                )
              : tx(
                  `已换成 ${label},对话接着进行`,
                  `Switched to ${label}; the conversation continues.`,
                ),
        });
      } else {
        const why =
          res.reason === 'busy'
            ? tx(
                'agent 正在忙,等它停下来再换。',
                'The agent is busy. Change it when it waits for you.',
              )
            : res.reason === 'cannot-restart'
              ? tx(
                  '这个标签不能就地重启 agent (SSH 标签,或模板参数不是简单的词,或模板在 agent 退出后不保留 shell)。',
                  'This tab cannot restart its agent in place (an SSH tab, template arguments that are not plain words, or a template that does not keep a shell).',
                )
              : res.reason === 'exit-timeout'
                ? tx(
                    'agent 没有在 20 秒内退出,没有再输入任何内容。',
                    'The agent did not exit within 20 seconds. Nothing else was typed.',
                  )
                : tx('这个终端已经不在了。', 'This tab is no longer running.');
        toast.push({ kind: 'warn', message: why });
      }
      refresh();
    } catch (err) {
      toast.push({
        kind: 'error',
        message: tx(
          `切换失败:${err instanceof Error ? err.message : String(err)}`,
          `Could not switch: ${err instanceof Error ? err.message : String(err)}`,
        ),
      });
    } finally {
      setSwitching(null);
    }
  };

  const openModels = (e: MouseEvent<HTMLElement>): void =>
    openAt(
      ctxMenu,
      e,
      tx(`这个标签的 ${AGENT_NAME[agent]} 模型`, `${AGENT_NAME[agent]} model for this tab`),
      choiceItems(
        models.map((m) => ({ id: m.id, label: m.label })),
        activeModelId,
        (id) => void pick({ model: id }, choiceLabel(agent, id, options)),
        busyHint ? { disabledHint: busyHint } : {},
      ),
      true,
    );
  const openEfforts = (e: MouseEvent<HTMLElement>): void =>
    openAt(
      ctxMenu,
      e,
      tx(`这个标签的 ${AGENT_NAME[agent]} effort`, `${AGENT_NAME[agent]} effort for this tab`),
      choiceItems(
        effortsFor(agent, options, activeModelId || usage?.model || '').map((l) => ({
          id: l,
          label: l,
        })),
        effortText,
        (id) => void pick({ effort: id }, id),
        busyHint ? { disabledHint: busyHint } : {},
      ),
      true,
    );

  const d = usage?.details;
  const calls = d
    ? [
        d.toolCalls !== undefined ? tx(`工具 ${d.toolCalls}`, `tools ${d.toolCalls}`) : null,
        d.agentCalls !== undefined
          ? tx(`子 agent ${d.agentCalls}`, `agents ${d.agentCalls}`)
          : null,
        d.skillCalls !== undefined ? tx(`skill ${d.skillCalls}`, `skills ${d.skillCalls}`) : null,
      ].filter(Boolean)
    : [];

  return (
    <div className="agent-status-line" ref={rootRef}>
      {switching ? (
        <span className="agent-status-switching">
          {tx(`正在换成 ${switching}…`, `Switching to ${switching}…`)}
        </span>
      ) : (
        <>
          <button
            type="button"
            className="agent-status-pick model"
            onClick={openModels}
            title={tx('换模型', 'Change the model')}
          >
            {modelText}
          </button>
          <span className="agent-status-sep">-</span>
          <button
            type="button"
            className={`agent-status-pick effort-${effortLevel(effortText)}`}
            onClick={openEfforts}
            title={tx('换 effort', 'Change the effort')}
          >
            {effortText || tx('默认 effort', 'default effort')}
          </button>
        </>
      )}
      <span className="agent-status-sep">-</span>
      <button
        type="button"
        className="agent-status-usage"
        onClick={() => setDetailsOpen((v) => !v)}
        aria-expanded={detailsOpen}
        title={[
          resetText('5h', usage?.fiveHour, now, tx),
          resetText('wk', usage?.weekly, now, tx),
          tx('点开看详情', 'Click for details'),
        ].join('\n')}
      >
        <Share
          name="5h"
          percent={usage?.fiveHour?.usedPercent}
          level={limitLevel(usage?.fiveHour?.usedPercent ?? 0)}
        />
        <span className="agent-status-sep">-</span>
        <Share
          name="wk"
          percent={usage?.weekly?.usedPercent}
          level={limitLevel(usage?.weekly?.usedPercent ?? 0)}
        />
        <span className="agent-status-sep">-</span>
        <Share name="ctx" percent={ctxPct} level={contextLevel(ctxPct ?? 0)} />
      </button>

      {detailsOpen && (
        <div className="agent-details" role="dialog" aria-label={tx('用量详情', 'Usage details')}>
          <div className="agent-details-head">
            {AGENT_NAME[agent]} · {usage?.model ?? modelText}
            {effortText ? ` · ${effortText}` : ''}
          </div>
          <dl className="agent-details-list">
            <dt>5h</dt>
            <dd>{resetText('5h', usage?.fiveHour, now, tx).replace(/^5h: /, '')}</dd>
            <dt>wk</dt>
            <dd>{resetText('wk', usage?.weekly, now, tx).replace(/^wk: /, '')}</dd>
            <dt>ctx</dt>
            <dd>
              {ctxPct !== undefined ? `${ctxPct}%` : '—'}
              {ctx?.usedTokens !== undefined ? ` · ${formatTokens(ctx.usedTokens)}` : ''}
              {ctx?.windowTokens ? ` / ${formatTokens(ctx.windowTokens)}` : ''}
              {ctxPct !== undefined && ctxPct >= COMPACT_SUGGEST_PERCENT
                ? tx(',可以考虑 /compact', '; consider /compact')
                : ''}
            </dd>
            {d?.startedAt !== undefined && (
              <>
                <dt>{tx('会话', 'Session')}</dt>
                <dd>{formatSpan(now - d.startedAt)}</dd>
              </>
            )}
            {d?.lastPromptAt !== undefined && (
              <>
                <dt>{tx('上次提问', 'Last prompt')}</dt>
                <dd>
                  {new Date(d.lastPromptAt).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                  {tx(
                    `(${formatSpan(now - d.lastPromptAt)} 前)`,
                    ` (${formatSpan(now - d.lastPromptAt)} ago)`,
                  )}
                </dd>
              </>
            )}
            {d?.prompts !== undefined && (
              <>
                <dt>{tx('提问数', 'Prompts')}</dt>
                <dd>{d.prompts}</dd>
              </>
            )}
            {calls.length > 0 && (
              <>
                <dt>{tx('调用', 'Calls')}</dt>
                <dd>{calls.join(' · ')}</dd>
              </>
            )}
            {d?.lastSkill && (
              <>
                <dt>Skill</dt>
                <dd>{d.lastSkill}</dd>
              </>
            )}
            {d?.todos && (
              <>
                <dt>Todos</dt>
                <dd>
                  {d.todos.done}/{d.todos.total}
                </dd>
              </>
            )}
            {d?.costUsd !== undefined && (
              <>
                <dt>{tx('花费', 'Cost')}</dt>
                <dd>${d.costUsd.toFixed(2)}</dd>
              </>
            )}
            <dt>{tx('来源', 'Source')}</dt>
            <dd>
              {d?.source ??
                tx('发出第一条消息后才有记录', 'nothing recorded before the first message')}
            </dd>
          </dl>
        </div>
      )}
    </div>
  );
}
