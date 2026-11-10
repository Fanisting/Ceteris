/**
 * @file src/renderer/components/AgentModelControls.tsx
 * @purpose Model and effort controls for Claude Code and Codex (ADR-038):
 *   - FolderAgentDefaultsRows: under an opened folder in the sidebar, one row per agent that
 *     has a tab in it, written `CC [Opus] [high]`. Each bracket opens its own choice and sets
 *     what new tabs of that agent in the folder start with.
 *   - AgentStatusLine: in the split-view row under the terminals, the selected tab's model and
 *     effort as two buttons the size of the split icons. Each opens its choice. Usage numbers
 *     are not shown here (the user keeps them in the OMC status line).
 *
 * @关键设计:
 * - Coloured text, no fills or outlines at rest; the buttons share the split icons' 32px
 *   height, corner and hover tint (the user's 2026-11-10 direction).
 * - Folder defaults live in settings.agents.folderDefaults, so every window sees a change at
 *   once and it survives restarts. Default for both fields removes the entry.
 * - A pick for a running tab makes the main process restart the agent in the same tab with
 *   session flags and resume the conversation (cmd:agent:switch-model, agent-model-switch.ts).
 *   The agents' own /model is not used: Claude Code saves it as the global default.
 * - Every click answers at once: a menu opens even while the agent is busy (its items are
 *   greyed with the reason), and the line says "switching" until the agent is back.
 * - The buttons sit in the existing 34px split-view row, so no terminal is resized.
 * - For a tab started with the agent's own default, the model and effort the agent reports
 *   are read every 15 s (cmd:agent:usage, selected tab only).
 *
 * @对应文档章节: 软件定义书.md ADR-038, 6.2.3; ipc-protocol.md 5.12
 *
 * @不要在这里做的事:
 * - No keyboard shortcut to open the menus (软件定义书 13.2: mouse first).
 * - No file reading or PTY writes here; both belong to the main process.
 */
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
  type RefObject,
} from 'react';
import {
  CLAUDE_EFFORTS,
  effortLevel,
  folderDefaultFor,
  modelAgentOf,
  modelLabel,
  withFolderDefault,
  type AgentUsage,
  type ModelAgent,
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
/** How often the selected tab's reported model and effort are read */
const REPORTED_POLL_MS = 15_000;
/**
 * Claude Code and Codex both draw their status lines (the OMC HUD, Codex's footer) two
 * cells in from the terminal's left edge; the buttons start on that same column.
 */
const HUD_INDENT_CELLS = 2;

/**
 * Left offset (px) that puts the start of `lineRef` on the HUD column of the focused pane's
 * terminal. Measured from the terminal itself, so it follows the font size, the split layout
 * and window resizes. 0 when there is no terminal to measure.
 */
function useHudIndent(
  lineRef: RefObject<HTMLDivElement>,
  sessionId: string | null,
  cols: number,
  layout: string,
): number {
  const [indent, setIndent] = useState(0);
  useLayoutEffect(() => {
    const line = lineRef.current;
    const bar = line?.parentElement;
    if (!line || !bar || cols <= 0) {
      setIndent(0);
      return undefined;
    }
    // The terminal often mounts after this line (a new tab, a layout change), so the screen
    // is looked up on every measure, and DOM changes in the pane area trigger a new measure.
    // Measures are batched to one per frame: the DOM renderer (Linux) changes rows constantly.
    let screen: HTMLElement | null = null;
    let frame = 0;
    const resize = new ResizeObserver(() => schedule());
    const measure = (): void => {
      frame = 0;
      const found =
        document.querySelector<HTMLElement>('.pane-slot.focused .xterm-screen') ??
        document.querySelector<HTMLElement>('.xterm-screen');
      if (found !== screen) {
        if (screen) resize.unobserve(screen);
        screen = found;
        if (screen) resize.observe(screen);
      }
      if (!screen) return; // keep the last indent until a terminal shows up
      const s = screen.getBoundingClientRect();
      if (s.width === 0) return;
      const b = bar.getBoundingClientRect();
      const pad = parseFloat(getComputedStyle(bar).paddingLeft) || 0;
      const column = s.left + (s.width / cols) * HUD_INDENT_CELLS;
      setIndent(Math.max(0, Math.round(column - b.left - pad)));
    };
    const schedule = (): void => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    resize.observe(bar);
    const area = bar.parentElement ?? document.body;
    const mutations = new MutationObserver(schedule);
    mutations.observe(area, { childList: true, subtree: true });
    measure();
    return () => {
      if (frame) cancelAnimationFrame(frame);
      resize.disconnect();
      mutations.disconnect();
    };
  }, [lineRef, sessionId, cols, layout]);
  return indent;
}

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
// Model and effort in the split-view row
// ──────────────────────────────────────────────────────────────────

/**
 * What the agent reports it runs, for tabs started with the agent's own default (Ceteris
 * then has no record of its own). Polled for the selected tab only.
 */
function useReportedModel(sessionId: string | null): AgentUsage | null {
  const [usage, setUsage] = useState<AgentUsage | null>(null);
  useEffect(() => {
    setUsage(null);
    if (!sessionId) return undefined;
    const read = (): void => {
      window.api
        .invoke<AgentUsagePayload, AgentUsageResponse>(COMMAND_CHANNELS.AGENT_USAGE, { sessionId })
        .then((res) => setUsage(res.usage))
        .catch((err: unknown) => console.warn('[AgentModelControls] model read failed', err));
    };
    read();
    const timer = window.setInterval(read, REPORTED_POLL_MS);
    return () => window.clearInterval(timer);
  }, [sessionId]);
  return usage;
}

/**
 * The selected tab's model and effort, two buttons the size of the split-view icons in the
 * same row. Each opens its choice. Renders nothing unless that tab runs Claude Code or Codex.
 */
export function AgentStatusLine(): JSX.Element | null {
  const state = useAppState();
  const session: SessionInfo | null =
    (state.selectedSessionId && state.sessions.get(state.selectedSessionId)) || null;
  const agent = modelAgentOf(session?.templateId);
  const live = !!session && !!agent && session.state !== 'exited';
  const reported = useReportedModel(live ? session.id : null);
  const options = useModelOptions();
  const [switching, setSwitching] = useState<string | null>(null);
  const ctxMenu = useContextMenuApi();
  const toast = useToast();
  const { tx } = useTranslation();
  const lineRef = useRef<HTMLDivElement | null>(null);
  const indent = useHudIndent(
    lineRef,
    live ? session.id : null,
    live ? session.cols : 0,
    state.paneLayout,
  );

  // A different tab never shows the previous tab's switching note
  useEffect(() => {
    setSwitching(null);
  }, [session?.id]);

  if (!live || !agent) return null;

  // What runs now: Ceteris' own record first (it knows a switch before the agent reports it)
  const chosenModel = session.agentModel ?? '';
  const modelText = chosenModel
    ? choiceLabel(agent, chosenModel, options)
    : reported?.model
      ? choiceLabel(agent, reported.model, options)
      : tx('默认模型', 'Default model');
  const effortText = session.agentEffort || reported?.effort || '';
  const models = options?.[agent].models ?? [];
  const activeModelId =
    chosenModel ||
    models.find((m) =>
      agent === 'codex'
        ? m.id === reported?.model
        : reported?.model?.toLowerCase().startsWith(m.label.toLowerCase()),
    )?.id ||
    '';
  const busy = session.agentPhase === 'working' || session.agentPhase === 'blocked';
  const busyHint = busy
    ? tx('agent 正在忙,等它停下来再换', 'The agent is busy; change it when it waits for you')
    : switching
      ? tx('正在切换', 'A switch is running')
      : undefined;

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
        effortsFor(agent, options, activeModelId || reported?.model || '').map((l) => ({
          id: l,
          label: l,
        })),
        effortText,
        (id) => void pick({ effort: id }, id),
        busyHint ? { disabledHint: busyHint } : {},
      ),
      true,
    );

  return (
    <div className="agent-status-line" ref={lineRef} style={{ marginLeft: indent }}>
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
    </div>
  );
}
