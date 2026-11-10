/**
 * @file src/renderer/components/RemoteSetupGuide.tsx
 * @purpose The remote setup guide (ADR-032). Two entry points ask "shall your AI agent set this
 *   up?": a bubble under the title bar badge when nothing remote is configured yet, and a card
 *   at the top of Settings → Remote. On yes the user says which side this machine is (host or
 *   client), and Ceteris opens a tab with their agent and pastes a one-line prompt pointing at
 *   the shipped guide file for that role and this platform.
 *
 * @关键设计:
 * - Ceteris does not talk to a model itself (13.2: 让 agent 自己做 agent). It only opens the tab
 *   and types the prompt; the agent reads guides/remote-setup-*.md and does the work.
 * - Pasted, never sent: the user reads the prompt and presses Enter, as the coordinator tour
 *   does. The wait for the agent to be ready is shared (waitUntilSettled).
 * - "Answered" lives in settings.behavior.remoteSetupGuideSeen, so every window stops asking
 *   at once and a reinstall does not ask again. After that the menu and the settings card keep
 *   an entry for whenever the user wants it.
 * - The bubble is not a modal: only the bubble takes clicks, a click elsewhere closes it.
 * - The guide tab opens in the selected local folder when there is one, else the home folder:
 *   the setup touches the system, not a project, so any folder is fine.
 *
 * @对应文档章节: 软件定义书.md ADR-032, 远程访问指南.md
 *
 * @不要在这里做的事:
 * - 不要替用户按 Enter
 * - 不要把指南正文写在这里 (在 guides/ 下的 markdown 里,主进程给路径)
 * - 不要加键盘快捷键 (13.2)
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  COMMAND_CHANNELS,
  type CreateSessionResponse,
  type RemoteSetupGuidePathsResponse,
} from '@shared/protocol';
import { DEFAULT_QUICK_LAUNCH_ITEMS } from '@shared/quick-launch';
import {
  buildRemoteSetupPrompt,
  detectGuidePlatform,
  pickGuideTemplateId,
  type RemoteSetupRole,
} from '@shared/remote-setup-guide';
import { findPathNode, useAppDispatch, useAppState, useAppStateRef } from '../store';
import { useTranslation } from './LanguageProvider';
import { getWslDistroName } from './launch-options';
import { useToast } from './Toast';
import { typeIntoSession, waitUntilSettled } from './type-into-terminal';

/** Mark the offer as answered. A failure only logs: the worst case is being asked once more. */
export function markRemoteSetupGuideSeen(): void {
  window.api
    .invoke(COMMAND_CHANNELS.SETTINGS_UPDATE, {
      partial: { behavior: { remoteSetupGuideSeen: true } },
    })
    .catch((err: unknown) => {
      console.warn('[RemoteSetupGuide] failed to save remoteSetupGuideSeen', err);
    });
}

export interface RemoteSetupGuideStarter {
  /** True while the agent tab is being opened; the role buttons disable themselves. */
  starting: boolean;
  /** Open the agent tab for this role and paste the prompt. Errors go to a toast. */
  start: (role: RemoteSetupRole) => Promise<void>;
}

/**
 * Opens the guide tab: fetches the guide path from main, picks the user's usual agent, creates
 * the session, waits for the agent's start-up screen, then types the prompt without Enter.
 */
export function useRemoteSetupGuide(): RemoteSetupGuideStarter {
  const { tx, locale } = useTranslation();
  const state = useAppState();
  const stateRef = useAppStateRef();
  const dispatch = useAppDispatch();
  const toast = useToast();
  const [starting, setStarting] = useState(false);

  const start = async (role: RemoteSetupRole): Promise<void> => {
    if (starting) return;
    setStarting(true);
    markRemoteSetupGuideSeen();
    try {
      const paths = await window.api.invoke<unknown, RemoteSetupGuidePathsResponse>(
        COMMAND_CHANNELS.GUIDES_REMOTE_SETUP_PATHS,
        {},
      );
      const prompt = buildRemoteSetupPrompt({
        role,
        platform: detectGuidePlatform(navigator.userAgent),
        guidePath: paths[role],
        locale,
      });
      const templateId = pickGuideTemplateId(
        state.settings.behavior?.quickLaunch ?? DEFAULT_QUICK_LAUNCH_ITEMS,
        state.templates,
      );
      // 选中的本地文件夹就在那里开;SSH 文件夹和 WSL 路径 (agent 要配 shell) 都退回主目录
      const node = state.selectedPathId ? findPathNode(state.pathTree, state.selectedPathId) : null;
      const pathId =
        node && node.kind === 'local' && !getWslDistroName(node.path) ? node.id : undefined;
      const dims = state.lastTerminalDims;
      const res = await window.api.invoke<unknown, CreateSessionResponse>(
        COMMAND_CHANNELS.SESSION_CREATE,
        { ...(pathId ? { pathId } : {}), templateId, cols: dims.cols, rows: dims.rows },
      );
      const sessionId = res.session.id;
      dispatch({ type: 'view/exit-settings' });
      dispatch({ type: 'view/select-path', pathId: res.session.pathId });
      dispatch({ type: 'view/select-session', sessionId });
      if (res.warning) toast.push({ kind: 'warn', message: tx(res.warning, res.warning) });

      if (await waitUntilSettled(stateRef, sessionId)) {
        await typeIntoSession(sessionId, prompt);
        toast.push({
          kind: 'success',
          message: tx(
            '提示已粘到 agent 标签,看一眼再按 Enter。',
            'The prompt is pasted into the agent tab. Read it, then press Enter.',
          ),
          durationMs: 8000,
        });
        return;
      }
      await navigator.clipboard.writeText(prompt);
      toast.push({
        kind: 'info',
        message: tx(
          'agent 启动得有点慢,提示已复制,等它好了粘贴进去再按 Enter。',
          'The agent is slow to start; the prompt is copied. Paste it once it is ready, then press Enter.',
        ),
        durationMs: 10000,
      });
    } catch (err) {
      console.error('[RemoteSetupGuide] start failed', err);
      toast.push({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    } finally {
      setStarting(false);
    }
  };

  return { starting, start };
}

export type RemoteSetupStep = 'offer' | 'role';

interface StepsProps {
  step: RemoteSetupStep;
  onStep: (step: RemoteSetupStep) => void;
  /** The user said no, or picked a role (the tab is opening). */
  onClose: () => void;
  starter: RemoteSetupGuideStarter;
}

/** The text and buttons of one step. The bubble and the settings card both render this. */
export function RemoteSetupSteps({ step, onStep, onClose, starter }: StepsProps): JSX.Element {
  const { tx } = useTranslation();

  const pick = (role: RemoteSetupRole): void => {
    void starter.start(role);
    onClose();
  };

  if (step === 'offer') {
    return (
      <>
        <p className="rsg-title">{tx('连接另一台电脑?', 'Connect another machine?')}</p>
        <p className="rsg-body">
          {tx(
            '让你的 AI agent 带你配置 SSH:检查这台电脑缺什么、装上、生成密钥、填好 Ceteris 里的连接。它会在一个新标签里和你一步步做。',
            'Your AI agent can walk you through SSH: check what this machine is missing, install it, make keys, and fill in the connection in Ceteris. It works with you step by step in a new tab.',
          )}
        </p>
        <div className="rsg-actions">
          <button
            type="button"
            className="rsg-quiet"
            onClick={() => {
              markRemoteSetupGuideSeen();
              onClose();
            }}
          >
            {tx('不用了', 'Not now')}
          </button>
          <button type="button" className="rsg-primary" onClick={() => onStep('role')}>
            {tx('好,带我做', 'Yes, guide me')}
          </button>
        </div>
      </>
    );
  }

  return (
    <>
      <p className="rsg-title">{tx('这台电脑是哪一边?', 'Which side is this machine?')}</p>
      <button
        type="button"
        className="rsg-role"
        disabled={starter.starting}
        onClick={() => pick('host')}
      >
        <span className="rsg-role-name">
          {tx('被其他电脑连进来', 'Let other machines connect here')}
        </span>
        <span className="rsg-role-hint">
          {tx(
            '在这台电脑上开 SSH 服务,其他电脑来开它的终端',
            'Run an SSH server here so other machines open terminals on it',
          )}
        </span>
      </button>
      <button
        type="button"
        className="rsg-role"
        disabled={starter.starting}
        onClick={() => pick('client')}
      >
        <span className="rsg-role-name">{tx('连到另一台电脑', 'Connect to another machine')}</span>
        <span className="rsg-role-hint">
          {tx(
            '生成密钥,连上那台电脑,把它加进 Ceteris',
            'Make a key, reach that machine, and add it to Ceteris',
          )}
        </span>
      </button>
      <p className="rsg-note">
        {tx(
          '会打开一个 agent 标签,提示已粘好,看一眼再按 Enter。',
          'An agent tab opens with the prompt pasted in. Read it, then press Enter.',
        )}
      </p>
      <div className="rsg-actions">
        <button type="button" className="rsg-quiet" onClick={onClose}>
          {tx('取消', 'Cancel')}
        </button>
      </div>
    </>
  );
}

interface BubbleProps {
  /** Where the arrow points: the bottom centre of the badge, in viewport px. */
  anchor: { x: number; y: number };
  initialStep: RemoteSetupStep;
  onClose: () => void;
}

/** The bubble under the title bar badge. A click anywhere else closes it. */
export function RemoteSetupBubble({ anchor, initialStep, onClose }: BubbleProps): JSX.Element {
  const [step, setStep] = useState<RemoteSetupStep>(initialStep);
  const starter = useRemoteSetupGuide();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (ref.current && e.target instanceof Node && !ref.current.contains(e.target)) onClose();
    };
    // 延后一帧挂监听,否则打开气泡的那次点击自己就把它关了
    const id = window.setTimeout(() => document.addEventListener('mousedown', onDown), 0);
    return () => {
      window.clearTimeout(id);
      document.removeEventListener('mousedown', onDown);
    };
  }, [onClose]);

  // 气泡左边缘不越过窗口:徽标靠左时箭头仍对准它,气泡本体往右挪
  const left = Math.max(8, anchor.x - 28);
  return createPortal(
    <div
      ref={ref}
      className="rsg-bubble"
      role="dialog"
      aria-modal="false"
      style={{ left, top: anchor.y + 10, ['--arrow-x' as string]: `${anchor.x - left}px` }}
    >
      <RemoteSetupSteps step={step} onStep={setStep} onClose={onClose} starter={starter} />
    </div>,
    document.body,
  );
}

/**
 * The card at the top of Settings → Remote. Before the offer is answered it asks the question;
 * afterwards it is one line with a Start button, so the guide stays reachable.
 */
export function RemoteSetupCard(): JSX.Element {
  const { tx } = useTranslation();
  const seen = useAppState().settings.behavior?.remoteSetupGuideSeen ?? false;
  const [step, setStep] = useState<RemoteSetupStep | null>(null);
  // 点了"不用了"后设置事件要稍后才到,这里先记住,免得问题闪回来一下
  const [dismissed, setDismissed] = useState(false);
  const starter = useRemoteSetupGuide();
  const current: RemoteSetupStep | null = step ?? (seen || dismissed ? null : 'offer');

  let content: ReactNode;
  if (current === null) {
    content = (
      <div className="rsg-compact">
        <span className="rsg-body">
          {tx('让 AI agent 带你配置 SSH 连接', 'Let your AI agent set up an SSH connection')}
        </span>
        <button type="button" className="rsg-primary" onClick={() => setStep('role')}>
          {tx('开始', 'Start')}
        </button>
      </div>
    );
  } else {
    content = (
      <RemoteSetupSteps
        step={current}
        onStep={setStep}
        onClose={() => {
          setDismissed(true);
          setStep(null);
        }}
        starter={starter}
      />
    );
  }
  return (
    <div className="rsg-card" data-testid="remote-setup-card">
      {content}
    </div>
  );
}
