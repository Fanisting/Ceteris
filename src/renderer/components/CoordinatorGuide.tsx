/**
 * @file src/renderer/components/CoordinatorGuide.tsx
 * @purpose The coordinator guide (ADR-024): a card in the lower right that walks the user
 *   through letting Claude Code in a coordinator tab run the other tabs of its folder.
 *
 * @关键设计:
 * - When it opens: on launch while settings.extensions.tabControlGuideSeen is false (so a new
 *   install, or the first launch after the update that brought the feature), and the first time
 *   the user ticks Coordinator on a tab (the tab menu fires COORDINATOR_GUIDE_EVENT).
 * - "Got it" writes tabControlGuideSeen = true: gone in every window, for good. "Later" only
 *   hides it in this window; it comes back on the next tick of Coordinator or the next launch.
 * - It is a live checklist, not a slideshow: each step ticks itself from real state (a
 *   coordinator tab exists, the setting is on, Claude Code lists the ceteris-tabs plugin), and
 *   the steps that need an action carry the button that does it.
 * - It never blocks the window: only the card takes clicks.
 *
 * @对应文档章节:软件定义书.md ADR-024;docs/ipc-protocol.md cmd:extensions:tab-control-status
 *
 * @不要在这里做的事:
 * - 不要弹成模态框 (首启不该被拦住,见软件定义书第 2 章)
 * - 不要替用户按 Enter 装插件 (type-into-terminal.ts 只输入,不执行)
 */
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { COMMAND_CHANNELS } from '@shared/protocol';
import {
  COORDINATOR_GUIDE_EVENT,
  tabControlInstallLine,
  type TabControlStatus,
} from '@shared/tab-control';
import { useAppDispatch, useAppState } from '../store';
import { useTranslation } from './LanguageProvider';
import { useToast } from './Toast';
import { useTypeIntoNewTerminal } from './type-into-terminal';

/** How often to look for the plugin again while the guide waits for the install. */
const PLUGIN_POLL_MS = 3000;

/** Save a partial settings update; a failure only shows a toast. */
async function saveExtensions(
  partial: { tabControl?: boolean; tabControlGuideSeen?: boolean },
  onError: (message: string) => void,
): Promise<void> {
  try {
    await window.api.invoke(COMMAND_CHANNELS.SETTINGS_UPDATE, { partial: { extensions: partial } });
  } catch (err) {
    onError(err instanceof Error ? err.message : String(err));
  }
}

export function CoordinatorGuide(): JSX.Element | null {
  const { tx } = useTranslation();
  const state = useAppState();
  const dispatch = useAppDispatch();
  const toast = useToast();
  const typer = useTypeIntoNewTerminal();
  const seen = state.settings.extensions?.tabControlGuideSeen ?? false;
  const enabled = state.settings.extensions?.tabControl ?? false;
  // 启动时没看过就打开;之后只有勾选协调者能再打开它
  const [open, setOpen] = useState(!seen);
  const [pluginInstalled, setPluginInstalled] = useState<boolean | null>(null);
  const [marketplaceDir, setMarketplaceDir] = useState<string | null>(null);

  const showError = (message: string): void => toast.push({ kind: 'error', message });

  useEffect(() => {
    const onTicked = (): void => setOpen(true);
    window.addEventListener(COORDINATOR_GUIDE_EVENT, onTicked);
    return () => window.removeEventListener(COORDINATOR_GUIDE_EVENT, onTicked);
  }, []);

  const visible = open && !seen;

  // 插件装没装:打开时查一次,没装就每 3 秒再查,用户在新终端按完 Enter 这一步自己打勾
  useEffect(() => {
    if (!visible || pluginInstalled) return;
    let cancelled = false;
    const check = (): void => {
      window.api
        .invoke<unknown, TabControlStatus>(COMMAND_CHANNELS.EXTENSIONS_TAB_CONTROL_STATUS, {})
        .then((res) => {
          if (!cancelled) setPluginInstalled(res.pluginInstalled);
        })
        .catch((err: unknown) => console.warn('[CoordinatorGuide] status check failed', err));
    };
    check();
    const timer = window.setInterval(check, PLUGIN_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [visible, pluginInstalled]);

  useEffect(() => {
    if (!visible || marketplaceDir) return;
    window.api
      .invoke<unknown, { dir: string }>(COMMAND_CHANNELS.EXTENSIONS_GET_MARKETPLACE_DIR, {})
      .then((res) => setMarketplaceDir(res.dir))
      .catch((err: unknown) => console.warn('[CoordinatorGuide] marketplace dir failed', err));
  }, [visible, marketplaceDir]);

  if (!visible) return null;

  const hasCoordinator = [...state.sessions.values()].some(
    (s) => s.coordinator === true && s.state !== 'exited',
  );
  const allDone = hasCoordinator && enabled && pluginInstalled === true;

  const install = (): void => {
    const dir = marketplaceDir;
    if (dir) void typer.run((shellId) => tabControlInstallLine(shellId, dir), showError);
  };

  const steps: { done: boolean; title: string; body: string; action?: JSX.Element }[] = [
    {
      done: hasCoordinator,
      title: tx('把一个标签设为协调者', 'Make one tab a coordinator'),
      body: tx(
        '右键标签,勾选“协调者”。它会移到标签栏上方单独一行。',
        'Right-click a tab and tick Coordinator. It moves to its own row above the tabs.',
      ),
    },
    {
      done: enabled,
      title: tx('打开“协调者控制标签页”', 'Turn on Coordinator tab control'),
      body: tx(
        '在 设置 → 扩展 里,默认是关的。',
        'It lives in Settings → Extensions and is off by default.',
      ),
      action: (
        <button
          type="button"
          className="coordinator-guide-action"
          onClick={() => void saveExtensions({ tabControl: true }, showError)}
        >
          {tx('打开', 'Turn on')}
        </button>
      ),
    },
    {
      done: pluginInstalled === true,
      title: tx(
        '给 Claude Code 装 ceteris-tabs 插件',
        'Add the ceteris-tabs plugin to Claude Code',
      ),
      body: tx(
        '插件随 Ceteris 安装,只需加一次。按钮会把两条命令输入到新终端,你按 Enter 才执行。',
        'It ships with Ceteris and is added once. The button types two commands into a new terminal; nothing runs until you press Enter.',
      ),
      action: (
        <button
          type="button"
          className="coordinator-guide-action"
          disabled={typer.preparing || !marketplaceDir}
          onClick={install}
        >
          {tx('输入安装命令', 'Type the commands')}
        </button>
      ),
    },
    {
      done: false,
      title: tx('在协调者标签里开 Claude Code,交给它', 'Start Claude Code in the coordinator tab'),
      body: tx(
        '比如:“开两个 Claude Code 标签,一个写测试,一个修这个 bug,都做完告诉我。”它能开、关、输入、读屏幕,只限同一文件夹;别的标签一律被拒绝。',
        'For example: “Open two Claude Code tabs, one writing tests and one fixing this bug, and tell me when both are done.” It can open, close, type into and read tabs in its own folder only; every other tab is refused.',
      ),
    },
  ];

  return createPortal(
    <section
      className="coordinator-guide"
      role="dialog"
      aria-modal="false"
      aria-labelledby="coordinator-guide-title"
    >
      <header className="coordinator-guide-header">
        <span className="coordinator-guide-badge">{tx('新功能', 'New')}</span>
        <h2 id="coordinator-guide-title" className="coordinator-guide-title">
          {tx('让协调者标签指挥其他标签', 'Let a coordinator tab run your other tabs')}
        </h2>
      </header>
      <ol className="coordinator-guide-steps">
        {steps.map((step, i) => (
          <li
            key={step.title}
            className="coordinator-guide-step"
            data-done={step.done ? 'true' : 'false'}
          >
            <span className="coordinator-guide-mark" aria-hidden="true">
              {step.done ? '✓' : i + 1}
            </span>
            <div className="coordinator-guide-text">
              <p className="coordinator-guide-step-title">
                {step.title}
                {step.done && (
                  <span className="coordinator-guide-sr">{tx('(已完成)', ' (done)')}</span>
                )}
              </p>
              <p className="coordinator-guide-step-body">{step.body}</p>
            </div>
            {!step.done && step.action}
          </li>
        ))}
      </ol>
      <footer className="coordinator-guide-footer">
        <button
          type="button"
          className="coordinator-guide-link"
          onClick={() => dispatch({ type: 'view/enter-settings', category: 'extensions' })}
        >
          {tx('设置 → 扩展', 'Settings → Extensions')}
        </button>
        <span className="coordinator-guide-spacer" />
        {!allDone && (
          <button type="button" className="coordinator-guide-later" onClick={() => setOpen(false)}>
            {tx('以后再说', 'Later')}
          </button>
        )}
        <button
          type="button"
          className="coordinator-guide-ok"
          onClick={() => void saveExtensions({ tabControlGuideSeen: true }, showError)}
        >
          {tx('知道了', 'Got it')}
        </button>
      </footer>
    </section>,
    document.body,
  );
}
