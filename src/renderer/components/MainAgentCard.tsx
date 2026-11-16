/**
 * @file src/renderer/components/MainAgentCard.tsx
 * @purpose The one-question card at first start: "Which agent do you use most?" (ADR-042).
 *
 * @关键设计:
 * - Shown while settings.behavior.mainAgentAsked is false: a new install, or the first start
 *   after the update that added it. Continue and Later both write mainAgentAsked = true, so it
 *   never comes back by itself; the wide card in the new tab page changes the choice later.
 * - It goes first among the first start guides. The extension setup card (ADR-041) waits for
 *   it and then puts the chosen agent's group first, so one card is on screen at a time.
 * - Only installed agents are offered (cmd:agent:list-installed). With one installed agent
 *   there is nothing to ask: it is saved silently. With none, the card closes without a choice
 *   and the first agent installed later stands in (resolveMainAgent).
 * - Preselected: the agent opened most often (template usage), else the first installed one.
 * - One click on a choice only selects it; Continue saves. A stray click cannot set it.
 *
 * @对应文档章节:软件定义书.md ADR-042
 *
 * @不要在这里做的事:
 * - 不要在这里开终端或装扩展;那是 ExtensionSetupCard 的事。
 */
import { useEffect, useRef, useState } from 'react';
import { COMMAND_CHANNELS, type ListTemplateUsageResponse } from '@shared/protocol';
import { isAgentTemplateId, preselectMainAgent } from '@shared/main-agent';
import { useAppState } from '../store';
import { useOverlayRegistration } from '../ui-overlay-stack';
import { useTranslation } from './LanguageProvider';
import { saveMainAgent, useMissingAgents } from './main-agent-ui';
import { TemplateIcon } from './TemplateIcon';
import { useToast } from './Toast';

export function MainAgentCard(): JSX.Element | null {
  const { tx } = useTranslation();
  const state = useAppState();
  const toast = useToast();
  const asked = state.settings.behavior?.mainAgentAsked;
  // 设置还没从 main 拿到时 behavior 不存在,asked 是 undefined,不弹
  const pending = asked === false && !state.inSettingsView;
  const missing = useMissingAgents(pending);
  const [usage, setUsage] = useState<Map<string, number> | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const autoSaved = useRef(false);

  useEffect(() => {
    if (!pending || usage) return;
    let cancelled = false;
    window.api
      .invoke<unknown, ListTemplateUsageResponse>(COMMAND_CHANNELS.TEMPLATE_USAGE_LIST, {})
      .then((res) => {
        if (!cancelled) setUsage(new Map(res.entries.map((e) => [e.key, e.count])));
      })
      .catch((err) => {
        console.warn('[MainAgentCard] template-usage-list failed', err);
        if (!cancelled) setUsage(new Map());
      });
    return () => {
      cancelled = true;
    };
  }, [pending, usage]);

  const agents = state.templates.filter(
    (t) => !t.hidden && isAgentTemplateId(t.id) && !(missing?.has(t.id) ?? false),
  );
  const ready = pending && missing !== null && usage !== null && state.templates.length > 0;
  const choice =
    picked ??
    (ready
      ? preselectMainAgent(
          agents.map((a) => a.id),
          usage ?? new Map(),
        )
      : null);

  const showError = (err: unknown): void => {
    toast.push({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
  };

  const markAsked = async (): Promise<void> => {
    try {
      await window.api.invoke(COMMAND_CHANNELS.SETTINGS_UPDATE, {
        partial: { behavior: { mainAgentAsked: true } },
      });
    } catch (err) {
      showError(err);
    }
  };

  // 0 个或 1 个装了的 agent:没什么可问的
  useEffect(() => {
    if (!ready || agents.length > 1 || autoSaved.current) return;
    autoSaved.current = true;
    const only = agents[0];
    if (only) {
      saveMainAgent(only.id, state.settings.behavior?.quickLaunch).catch(showError);
    } else {
      void markAsked();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, agents.length]);

  const open = ready && agents.length > 1;
  const { isTop } = useOverlayRegistration(open);
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && isTop()) void markAsked();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, isTop]);

  if (!open) return null;

  const confirm = async (): Promise<void> => {
    if (!choice) return;
    setBusy(true);
    try {
      await saveMainAgent(choice, state.settings.behavior?.quickLaunch);
    } catch (err) {
      showError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="app-modal-backdrop" data-guide="main-agent">
      <div className="app-modal-panel main-agent-panel" role="dialog" aria-modal="true">
        <div className="app-modal-title extension-setup-title">
          <span>{tx('你最常用哪个 agent?', 'Which agent do you use most?')}</span>
          <span className="extension-setup-once">{tx('只问一次', 'once only')}</span>
        </div>
        <div className="app-modal-message">
          {tx(
            '新建标签、标签栏末尾的快捷启动、设置引导和协调者都先用它。以后在新建页的 Agents 区随时能换。',
            'New tabs, quick launch at the end of the tab strip, setup guides and the coordinator use it first. Change it any time in the Agents section of a new tab.',
          )}
        </div>
        <div className="main-agent-choices" role="radiogroup">
          {agents.map((t) => (
            <button
              key={t.id}
              type="button"
              role="radio"
              aria-checked={choice === t.id}
              className={`main-agent-choice${choice === t.id ? ' selected' : ''}`}
              onClick={() => setPicked(t.id)}
              onDoubleClick={() => {
                setPicked(t.id);
                void saveMainAgent(t.id, state.settings.behavior?.quickLaunch).catch(showError);
              }}
            >
              <span className="main-agent-choice-icon">
                <TemplateIcon template={t} size={22} />
              </span>
              <span className="main-agent-choice-label">{t.name}</span>
            </button>
          ))}
        </div>
        <div className="app-modal-actions">
          <button type="button" className="app-modal-button" onClick={() => void markAsked()}>
            {tx('以后再说', 'Later')}
          </button>
          <button
            type="button"
            className="app-modal-button app-modal-button-primary"
            disabled={busy || !choice}
            onClick={() => void confirm()}
          >
            {tx('继续', 'Continue')}
          </button>
        </div>
      </div>
    </div>
  );
}
