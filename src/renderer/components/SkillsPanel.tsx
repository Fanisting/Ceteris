/**
 * @file src/renderer/components/SkillsPanel.tsx
 * @purpose The skills card in the lower sidebar (ADR-053): the skills Claude Code or Codex can use
 *   in the selected tab, grouped by where they come from. A click shows the skill's SKILL.md
 *   beside the terminal, the same way the file tree opens a Markdown file.
 *
 * @关键设计:
 * - Same slot, height and resize handle as the file tree (FileTreePanel's useResizableHeight);
 *   Sidebar shows one of the two at a time.
 * - The list comes from the main process (cmd:agent:list-skills), which decides which agent runs
 *   in the tab and reads its folders. It is asked again when the tab, its folder or its agent
 *   changes, and when the window gets focus, so a skill installed meanwhile shows up. No timer:
 *   skills change rarely and a poll would read many files for nothing.
 * - Nothing is typed into the agent. The panel is for seeing what exists; the user invokes a
 *   skill in the agent as usual.
 * - Folded groups are remembered per group kind and label in localStorage, so a long plugin
 *   group stays out of the way across restarts.
 *
 * @对应文档章节: 软件定义书.md ADR-053; ipc-protocol.md 5.15
 *
 * @不要在这里做的事:
 * - No file reading here; the main process lists and the viewer (pdf-view-store) reads.
 * - No keyboard shortcut to open the panel (软件定义书 13.2: mouse first).
 */
import { useEffect, useState } from 'react';
import { countSkills, type ListSkillsResult, type SkillGroup } from '@shared/agent-skills';
import {
  COMMAND_CHANNELS,
  type AgentListSkillsPayload,
  type AgentListSkillsResponse,
} from '@shared/protocol';
import { openPdf } from '../pdf-view-store';
import { getSelectedSession, useAppState } from '../store';
import { focusTerminalDom } from '../focus';
import { pdfViewKey, useResizableHeight } from './FileTreePanel';
import { useTranslation } from './LanguageProvider';
import { AutoAwesome, ChevronRight } from './material-symbols';

const FOLDED_KEY = 'ceteris.sidebar.skillsFolded';

function readFolded(): Set<string> {
  try {
    const raw: unknown = JSON.parse(window.localStorage?.getItem(FOLDED_KEY) ?? '[]');
    return new Set(Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : []);
  } catch {
    return new Set();
  }
}

function saveFolded(folded: ReadonlySet<string>): void {
  try {
    window.localStorage?.setItem(FOLDED_KEY, JSON.stringify([...folded]));
  } catch {
    // Only the folded state is lost on restart.
  }
}

const groupKey = (g: SkillGroup): string => `${g.kind}|${g.label}`;

/** The last part of a folder path, for a project group's title. */
function folderName(path: string): string {
  return (
    path
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .pop() || path
  );
}

export function SkillsPanel(): JSX.Element {
  const state = useAppState();
  const { t } = useTranslation();
  const session = getSelectedSession(state);
  const viewKey = pdfViewKey(state);
  const { height, handleProps } = useResizableHeight();
  const [result, setResult] = useState<ListSkillsResult | null>(null);
  const [folded, setFolded] = useState<ReadonlySet<string>>(readFolded);

  // What decides the list: the tab, its folder, and whether an agent is on its screen (a shell
  // where the user just typed claude turns into an agent tab without a new session).
  const sessionId = session?.id ?? null;
  const cwd = session?.currentCwd ?? '';
  const hasAgent = session?.agentPhase != null;
  const key = `${sessionId ?? ''}|${cwd}|${hasAgent ? 1 : 0}`;

  // A reply that arrives after the tab, folder or agent changed is dropped (cancelled), so a slow
  // answer for tab A can never replace the list of tab B.
  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      const value: ListSkillsResult = !sessionId
        ? { ok: false, reason: 'no-session' }
        : await window.api
            .invoke<
              AgentListSkillsPayload,
              AgentListSkillsResponse
            >(COMMAND_CHANNELS.AGENT_LIST_SKILLS, { sessionId })
            .catch((err: unknown): AgentListSkillsResponse => {
              console.error('[SkillsPanel] list-skills failed', { sessionId, err });
              return { ok: false, reason: 'no-session' };
            });
      if (!cancelled) setResult(value);
    };
    void load();
    const onFocus = (): void => void load();
    window.addEventListener('focus', onFocus);
    return () => {
      cancelled = true;
      window.removeEventListener('focus', onFocus);
    };
  }, [key, sessionId]);

  const toggleGroup = (g: SkillGroup): void => {
    const next = new Set(folded);
    const k = groupKey(g);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    setFolded(next);
    saveFolded(next);
  };

  // While a new tab's list loads, the previous list stays instead of an empty card.
  const value = result;
  const agentName = value?.ok ? t(`skills.agent.${value.agent}`) : null;

  const groupTitle = (g: SkillGroup): string => {
    if (g.kind === 'project') return t('skills.group.project', { name: folderName(g.label) });
    if (g.kind === 'plugin') return t('skills.group.plugin', { name: g.label });
    return t(`skills.group.${g.kind}`);
  };

  return (
    <>
      <div
        className="file-tree-resize"
        role="separator"
        aria-orientation="horizontal"
        title={t('fileTree.resize')}
        {...handleProps}
      />
      <section
        className="file-tree-panel skills-panel"
        aria-label={t('skills.title')}
        style={height === null ? undefined : { flexBasis: height }}
      >
        <div className="file-tree-header">
          <AutoAwesome size={14} />
          <span className="file-tree-header-label">
            {agentName ? t('skills.titleFor', { agent: agentName }) : t('skills.title')}
          </span>
          {value?.ok && <span className="skills-count">{countSkills(value.groups)}</span>}
        </div>
        {!value ? null : !value.ok ? (
          <p className="file-tree-hint">{t(`skills.empty.${value.reason}`)}</p>
        ) : value.groups.length === 0 ? (
          <p className="file-tree-hint">{t('skills.empty.none', { agent: agentName ?? '' })}</p>
        ) : (
          <div className="file-tree-list skills-list">
            {value.groups.map((g) => {
              const open = !folded.has(groupKey(g));
              return (
                <div key={groupKey(g)} className="skills-group" role="group">
                  <button
                    type="button"
                    className="skills-group-header"
                    aria-expanded={open}
                    title={g.label}
                    onClick={() => toggleGroup(g)}
                  >
                    <span className={`file-tree-chevron${open ? ' expanded' : ''}`}>
                      <ChevronRight size={16} />
                    </span>
                    <span className="skills-group-title">{groupTitle(g)}</span>
                    <span className="skills-count">{g.skills.length}</span>
                  </button>
                  {open &&
                    g.skills.map((s) => (
                      <button
                        key={s.path}
                        type="button"
                        className="skills-row"
                        title={s.description ? `${s.description}\n\n${s.path}` : s.path}
                        onClick={() => {
                          if (viewKey) void openPdf(viewKey, { name: 'SKILL.md', path: s.path });
                          else focusTerminalDom();
                        }}
                      >
                        <span className="skills-row-name">{s.name}</span>
                        {s.description && <span className="skills-row-desc">{s.description}</span>}
                      </button>
                    ))}
                </div>
              );
            })}
          </div>
        )}
      </section>
    </>
  );
}
