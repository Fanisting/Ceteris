/**
 * @file src/renderer/components/AgentModelControls.tsx
 * @purpose Model and effort controls for Claude Code and Codex (ADR-038):
 *   - FolderAgentDefaultsRow: the row above a folder's sessions in the sidebar, one chip per
 *     agent ("CC Opus · high"), setting what new tabs in that folder start with.
 *   - AgentModelChip: the chip at a tab's bottom left ("Opus · high"). Its panel lets the
 *     user pick model and effort for this running tab and shows usage the way the OMC HUD
 *     does: 5h, wk and ctx always, everything else folded under Details.
 *
 * @关键设计:
 * - Folder defaults live in settings.agents.folderDefaults, so every window sees a change at
 *   once and it survives restarts. A pick of Default for both fields removes the entry.
 * - A pick in the tab panel makes the main process restart the agent in the same tab with
 *   session flags and resume the conversation (cmd:agent:switch-model, agent-model-switch.ts).
 *   The agents' own /model is not used: it would change the user's global default. While the
 *   agent is mid-turn or waits on an approval the picks are greyed.
 * - The chip sits in a fixed 30px strip under the terminal. A floating chip covered the
 *   agent's bottom line; a strip that is there from the first frame never resizes the PTY.
 * - Usage is polled: every 5 s while the panel is open, every 30 s for the chip label.
 *   The main process reads only the bytes added since the last poll.
 *
 * @对应文档章节: 软件定义书.md ADR-038, 6.2.3; ipc-protocol.md 5.12
 *
 * @不要在这里做的事:
 * - No keyboard shortcut to open the panel (软件定义书 13.2: mouse first).
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
  type ModelChoice,
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
import { ChevronRight, ExpandMore } from './material-symbols';

const AGENT_SHORT: Record<ModelAgent, string> = { 'claude-code': 'CC', codex: 'CX' };
const AGENT_NAME: Record<ModelAgent, string> = { 'claude-code': 'Claude Code', codex: 'Codex' };
const PANEL_POLL_MS = 5_000;
const LABEL_POLL_MS = 30_000;

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

// ──────────────────────────────────────────────────────────────────
// Folder row
// ──────────────────────────────────────────────────────────────────

/**
 * One chip per agent that is not hidden in the template list. Clicking opens a menu with
 * the model list above the effort list (option A on the 2026-11-10 options page).
 */
export function FolderAgentDefaultsRow({
  pathId,
  folderName,
}: {
  pathId: string;
  folderName: string;
}): JSX.Element | null {
  const state = useAppState();
  const ctxMenu = useContextMenuApi();
  const toast = useToast();
  const { tx } = useTranslation();
  const options = useModelOptions();
  const list = state.settings.agents?.folderDefaults;
  const agents = (['claude-code', 'codex'] as const).filter((a) =>
    state.templates.some((t) => t.id === a && !t.hidden),
  );
  if (agents.length === 0) return null;

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

  const openMenu = (agent: ModelAgent, e: MouseEvent<HTMLButtonElement>): void => {
    e.stopPropagation();
    const current = folderDefaultFor(list, pathId, agent);
    const models: ModelChoice[] = options?.[agent].models ?? [];
    const efforts = effortsFor(agent, options, current.model);
    const items: ContextMenuItem[] = [
      {
        label: tx('模型:默认', 'Model: default'),
        hint: tx('用 agent 自己的配置', "Use the agent's own setting"),
        checked: current.model === '',
        onSelect: () => save(agent, '', current.effort),
      },
      ...models.map((m) => ({
        label: m.label,
        checked: current.model === m.id,
        onSelect: () => save(agent, m.id, current.effort),
      })),
      { divider: true, label: '' },
      {
        label: tx('Effort:默认', 'Effort: default'),
        checked: current.effort === '',
        onSelect: () => save(agent, current.model, ''),
      },
      ...efforts.map((level) => ({
        label: `Effort: ${level}`,
        checked: current.effort === level,
        onSelect: () => save(agent, current.model, level),
      })),
    ];
    const rect = e.currentTarget.getBoundingClientRect();
    ctxMenu.open({
      x: rect.left,
      y: rect.bottom + 4,
      title: tx(
        `${folderName} 里新开的 ${AGENT_NAME[agent]}`,
        `New ${AGENT_NAME[agent]} tabs in ${folderName}`,
      ),
      items,
    });
  };

  return (
    <div className="folder-agent-defaults" onClick={(e) => e.stopPropagation()}>
      {agents.map((agent) => {
        const v = folderDefaultFor(list, pathId, agent);
        const set = v.model !== '' || v.effort !== '';
        const label = set
          ? [v.model ? choiceLabel(agent, v.model, options) : tx('默认', 'Default'), v.effort]
              .filter(Boolean)
              .join(' · ')
          : tx('默认', 'Default');
        return (
          <button
            key={agent}
            type="button"
            className={`agent-model-chip folder${set ? ' set' : ''}`}
            onClick={(e) => openMenu(agent, e)}
            title={tx(
              `${AGENT_NAME[agent]}:这个文件夹里新开终端用的模型和 effort`,
              `${AGENT_NAME[agent]}: model and effort for new tabs in this folder`,
            )}
          >
            <span className="agent-model-chip-agent">{AGENT_SHORT[agent]}</span>
            <span className="agent-model-chip-label">{label}</span>
            <ExpandMore size={14} />
          </button>
        );
      })}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────
// Tab chip and panel
// ──────────────────────────────────────────────────────────────────

/** Polls the tab's usage while enabled; shell tabs pass enabled=false and never call main. */
function useAgentUsage(
  sessionId: string,
  intervalMs: number,
  enabled: boolean,
): [AgentUsage | null, () => void] {
  const [usage, setUsage] = useState<AgentUsage | null>(null);
  const refresh = useCallback(() => {
    window.api
      .invoke<AgentUsagePayload, AgentUsageResponse>(COMMAND_CHANNELS.AGENT_USAGE, { sessionId })
      .then((res) => setUsage(res.usage))
      .catch((err: unknown) => console.warn('[AgentModelControls] usage failed', err));
  }, [sessionId]);
  useEffect(() => {
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

/** A 10 cell bar, coloured by level */
function Meter({
  percent,
  level,
}: {
  percent: number;
  level: 'ok' | 'warn' | 'high';
}): JSX.Element {
  const clamped = Math.max(0, Math.min(100, percent));
  return (
    <span className={`agent-usage-meter ${level}`} aria-hidden="true">
      <span className="agent-usage-meter-fill" style={{ width: `${clamped}%` }} />
    </span>
  );
}

function limitLevel(p: number): 'ok' | 'warn' | 'high' {
  return p >= 90 ? 'high' : p >= 70 ? 'warn' : 'ok';
}

function LimitRow({
  name,
  win,
  now,
}: {
  name: string;
  win: UsageWindow | undefined;
  now: number;
}): JSX.Element {
  return (
    <div className="agent-usage-row">
      <span className="agent-usage-key">{name}</span>
      {win ? (
        <>
          <Meter percent={win.usedPercent} level={limitLevel(win.usedPercent)} />
          <span className="agent-usage-value">{Math.round(win.usedPercent)}%</span>
          <span className="agent-usage-note">
            {win.resetsAt ? `↻ ${formatSpan(win.resetsAt - now)}` : ''}
          </span>
        </>
      ) : (
        <span className="agent-usage-none">—</span>
      )}
    </div>
  );
}

/**
 * The chip at the tab's bottom left. Renders nothing for templates other than Claude Code
 * and Codex.
 */
export function AgentModelChip({ session }: { session: SessionInfo }): JSX.Element | null {
  const agent = modelAgentOf(session.templateId);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [usage, refresh] = useAgentUsage(
    session.id,
    open ? PANEL_POLL_MS : LABEL_POLL_MS,
    agent !== null && session.state !== 'exited',
  );
  const options = useModelOptions();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const toast = useToast();
  const { tx } = useTranslation();

  // Click outside or Escape closes the panel
  useEffect(() => {
    if (!open) return;
    const onDown = (e: globalThis.MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!agent) return null;
  // The strip stays after the agent exits, so the terminal above does not change size
  if (session.state === 'exited') return <div className="agent-model-footer" />;

  // What runs now: Ceteris' own record first (it knows a switch before the agent reports it)
  const chosenModel = session.agentModel ?? '';
  const chosenEffort = session.agentEffort ?? '';
  const modelText = chosenModel
    ? choiceLabel(agent, chosenModel, options)
    : usage?.model
      ? choiceLabel(agent, usage.model, options)
      : tx('默认', 'Default');
  const effortText = chosenEffort || usage?.effort || '';
  const busy = session.agentPhase === 'working' || session.agentPhase === 'blocked';
  const models = options?.[agent].models ?? [];
  const activeModelId =
    chosenModel ||
    models.find((m) =>
      agent === 'codex'
        ? m.id === usage?.model
        : usage?.model?.toLowerCase().startsWith(m.label.toLowerCase()),
    )?.id ||
    '';
  const efforts = effortsFor(agent, options, activeModelId || usage?.model || '');
  const now = Date.now();
  const ctx = usage?.context;
  const ctxPct = ctx?.usedPercent;

  const pick = async (next: { model?: string; effort?: string }): Promise<void> => {
    if (busy || sending) return;
    setSending(true);
    try {
      const res = await window.api.invoke<AgentSwitchModelPayload, AgentSwitchModelResponse>(
        COMMAND_CHANNELS.AGENT_SWITCH_MODEL,
        { sessionId: session.id, ...next },
      );
      if (res.applied && res.resumed === false) {
        toast.push({
          kind: 'info',
          message: tx(
            '没找到之前的对话,agent 用新模型开始了一段新对话。',
            'No earlier conversation was found, so the agent started a new one with the new model.',
          ),
        });
      }
      if (!res.applied) {
        const why =
          res.reason === 'busy'
            ? tx(
                'agent 正在忙,等它停下来再换。',
                'The agent is busy. Change it when the agent waits for you.',
              )
            : res.reason === 'cannot-restart'
              ? tx(
                  '这个标签不能就地重启 agent (SSH 标签,或模板在 agent 退出后不保留 shell)。',
                  'This tab cannot restart its agent in place (an SSH tab, or a template that does not keep a shell after the agent).',
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
      setSending(false);
    }
  };

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
    <div className="agent-model-footer">
      <div className="agent-model-anchor" ref={rootRef}>
        {open && (
          <div
            className="agent-model-panel"
            role="dialog"
            aria-label={tx('模型与用量', 'Model and usage')}
          >
            <div className="agent-model-panel-head">
              <span className="agent-model-panel-agent">{AGENT_NAME[agent]}</span>
              <span className="agent-model-panel-model">
                {/* The agent's full name ("Opus 5.5") once it matches the pick, else the pick */}
                {usage?.model &&
                (!chosenModel || usage.model.toLowerCase().startsWith(modelText.toLowerCase()))
                  ? usage.model
                  : modelText}
              </span>
              {effortText && (
                <span className={`agent-effort-tag effort-${effortLevel(effortText)}`}>
                  {effortText}
                </span>
              )}
            </div>

            <div className="agent-model-section-title">{tx('模型', 'Model')}</div>
            <div className="agent-model-choices">
              {models.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  className={`agent-model-choice${m.id === activeModelId ? ' chosen' : ''}`}
                  disabled={busy || sending}
                  onClick={() => void pick({ model: m.id })}
                >
                  {m.label}
                </button>
              ))}
            </div>

            <div className="agent-model-section-title">Effort</div>
            <div className="agent-effort-choices" role="radiogroup" aria-label="Effort">
              {efforts.map((level) => (
                <button
                  key={level}
                  type="button"
                  role="radio"
                  aria-checked={level === effortText}
                  className={`agent-effort-choice effort-${effortLevel(level)}${level === effortText ? ' chosen' : ''}`}
                  disabled={busy || sending}
                  onClick={() => void pick({ effort: level })}
                >
                  {level}
                </button>
              ))}
            </div>
            <div className="agent-model-busy">
              {sending
                ? tx(
                    '正在重启 agent,对话会接着进行…',
                    'Restarting the agent; the conversation continues…',
                  )
                : busy
                  ? tx('agent 等你的时候才能换。', 'Available when the agent waits for you.')
                  : tx(
                      '换了之后会在这个标签里重启 agent 并接着当前对话,只影响这个标签。',
                      'A change restarts the agent in this tab and resumes this conversation. Only this tab changes.',
                    )}
            </div>

            <div className="agent-usage-rows">
              <LimitRow name="5h" win={usage?.fiveHour} now={now} />
              <LimitRow name="wk" win={usage?.weekly} now={now} />
              <div className="agent-usage-row">
                <span className="agent-usage-key">ctx</span>
                {ctx ? (
                  <>
                    {ctxPct !== undefined && (
                      <Meter percent={ctxPct} level={contextLevel(ctxPct)} />
                    )}
                    <span className="agent-usage-value">
                      {ctxPct !== undefined ? `${ctxPct}%` : ''}
                    </span>
                    <span className="agent-usage-note">
                      {ctx.usedTokens !== undefined ? formatTokens(ctx.usedTokens) : ''}
                      {ctx.windowTokens ? ` / ${formatTokens(ctx.windowTokens)}` : ''}
                    </span>
                  </>
                ) : (
                  <span className="agent-usage-none">—</span>
                )}
              </div>
              {ctxPct !== undefined && ctxPct >= COMPACT_SUGGEST_PERCENT && (
                <div className="agent-usage-hint">
                  {tx(
                    '上下文快满了,可以考虑 /compact。',
                    'Context is filling up; consider /compact.',
                  )}
                </div>
              )}
              {!usage && (
                <div className="agent-usage-hint">
                  {tx('发出第一条消息后这里会有数字。', 'Numbers appear after the first message.')}
                </div>
              )}
            </div>

            <button
              type="button"
              className="agent-usage-details-toggle"
              onClick={() => setDetailsOpen((v) => !v)}
              aria-expanded={detailsOpen}
            >
              {detailsOpen ? <ExpandMore size={14} /> : <ChevronRight size={14} />}
              {tx('详情', 'Details')}
            </button>
            {detailsOpen && (
              <dl className="agent-usage-details">
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
                <dd>{d?.source ?? tx('还没有记录', 'nothing recorded yet')}</dd>
              </dl>
            )}
          </div>
        )}
        <button
          type="button"
          className={`agent-model-chip tab${open ? ' open' : ''}`}
          onClick={() => setOpen((v) => !v)}
          title={tx('模型、effort 和用量', 'Model, effort and usage')}
          aria-expanded={open}
        >
          <span className="agent-model-chip-label">{modelText}</span>
          {effortText && (
            <>
              <span className="agent-model-chip-dot">·</span>
              <span className={`agent-model-chip-effort effort-${effortLevel(effortText)}`}>
                {effortText}
              </span>
            </>
          )}
          {ctxPct !== undefined && (
            <span className={`agent-model-chip-ctx ${contextLevel(ctxPct)}`}>{ctxPct}%</span>
          )}
          <ExpandMore size={14} className="agent-model-chip-caret" />
        </button>
      </div>
    </div>
  );
}
