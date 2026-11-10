/**
 * @file src/renderer/components/ExtensionSetupCard.tsx
 * @purpose The one-time card on first start that sets up the agent extensions in one go
 *   (ADR-034): Claude Code plugins, Codex config, and the switches that go with them.
 *
 * @关键设计:
 * - Shown while settings.extensions.setupSeen is false (new install, or first start after the
 *   update that added it), and again on the EXTENSION_SETUP_OPEN_EVENT from Settings. Later and
 *   Set up both write setupSeen = true, so it never comes back by itself.
 * - It goes before the other first-start guides: the quick launch bubble and the coordinator
 *   tour wait for setupSeen (MainPane.tsx, CoordinatorTour.tsx).
 * - Preselection follows what is on this machine: Claude Code items when ~/.claude exists,
 *   Codex items when the Codex home exists. The user can tick anything anyway.
 * - Set up does three things in order: flip the switches, write the Codex entry (main does it),
 *   then open ONE terminal with the command line typed and not run. The Enter is the consent,
 *   the same rule as the rows in Settings.
 *
 * @对应文档章节:软件定义书.md ADR-034
 *
 * @不要在这里做的事:
 * - 不要替用户按 Enter;不要在这里判断某个工具装没装(状态来自 main)。
 */
import { useEffect, useState } from 'react';
import { COMMAND_CHANNELS } from '@shared/protocol';
import type { CodexMcpStatus } from '@shared/codex-mcp';
import type { TabControlStatus } from '@shared/tab-control';
import {
  EXTENSION_SETUP_ITEMS,
  EXTENSION_SETUP_OPEN_EVENT,
  extensionSetupCommand,
  extensionSetupNeedsTerminal,
  extensionSetupSettings,
  type ExtensionSetupItemId,
} from '@shared/extension-setup';
import { useAppState } from '../store';
import { useOverlayRegistration } from '../ui-overlay-stack';
import { useTranslation } from './LanguageProvider';
import { useToast } from './Toast';
import { useTypeIntoNewTerminal } from './type-into-terminal';

interface Item {
  id: ExtensionSetupItemId;
  group: 'claude' | 'codex' | 'ceteris';
  title: [string, string];
  detail: [string, string];
}

const ITEMS: Item[] = [
  {
    id: 'claude-tabs',
    group: 'claude',
    title: ['ceteris-tabs 插件', 'ceteris-tabs plugin'],
    detail: [
      '让 Claude Code 把写好的 md 等文件摆在标签旁边;协调者还能指挥其他标签',
      'Claude Code shows a file it wrote beside its tab; a coordinator can also drive other tabs',
    ],
  },
  {
    id: 'claude-math',
    group: 'claude',
    title: ['公式图片', 'Formula images'],
    detail: [
      'Claude Code 回复里的 LaTeX 公式排成图片显示(latex-math 插件 + 开关)',
      'LaTeX in Claude Code replies is typeset as images (latex-math plugin + switch)',
    ],
  },
  {
    id: 'codex-tabs',
    group: 'codex',
    title: ['ceteris-tabs 服务器', 'ceteris-tabs server'],
    detail: [
      '写进 ~/.codex/config.toml,Codex 也能把文件摆在标签旁边',
      'Written to ~/.codex/config.toml so Codex can show files beside its tab too',
    ],
  },
  {
    id: 'codex-math',
    group: 'codex',
    title: ['公式渲染', 'Formula rendering'],
    detail: [
      '终端里的 LaTeX 用 KaTeX 画出来,并在 ~/.codex/AGENTS.md 加一行告诉 Codex 怎么写公式',
      'LaTeX in the terminal is drawn with KaTeX; one line in ~/.codex/AGENTS.md tells Codex how to write it',
    ],
  },
  {
    id: 'coordinator',
    group: 'ceteris',
    title: ['协调者控制标签页', 'Coordinator tab control'],
    detail: [
      '标记为协调者的标签里的 Claude Code 可以新开、输入、读取同文件夹的其他标签',
      'Claude Code in a tab marked Coordinator can open, type into and read the other tabs of its folder',
    ],
  },
];

const GROUPS: { id: Item['group']; title: [string, string] }[] = [
  { id: 'claude', title: ['Claude Code', 'Claude Code'] },
  { id: 'codex', title: ['Codex', 'Codex'] },
  { id: 'ceteris', title: ['Ceteris', 'Ceteris'] },
];

export function ExtensionSetupCard(): JSX.Element | null {
  const { tx } = useTranslation();
  const state = useAppState();
  const toast = useToast();
  const typer = useTypeIntoNewTerminal();
  const seen = state.settings.extensions?.setupSeen;
  // 第一次启动自动打开;设置页的按钮再打开
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Set<ExtensionSetupItemId>>(new Set());
  const [preselected, setPreselected] = useState(false);
  const [marketplaceDir, setMarketplaceDir] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (seen === false && !state.inSettingsView) setOpen(true);
  }, [seen, state.inSettingsView]);
  useEffect(() => {
    const onOpen = (): void => setOpen(true);
    window.addEventListener(EXTENSION_SETUP_OPEN_EVENT, onOpen);
    return () => window.removeEventListener(EXTENSION_SETUP_OPEN_EVENT, onOpen);
  }, []);

  // 预选:这台机器上有哪个 agent 就勾哪个的项;两个查询都失败就全勾,让用户自己去掉
  useEffect(() => {
    if (!open || preselected) return;
    setPreselected(true);
    void Promise.all([
      window.api
        .invoke<unknown, TabControlStatus>(COMMAND_CHANNELS.EXTENSIONS_TAB_CONTROL_STATUS, {})
        .catch(() => null),
      window.api
        .invoke<unknown, CodexMcpStatus>(COMMAND_CHANNELS.EXTENSIONS_CODEX_MCP_STATUS, {})
        .catch(() => null),
      window.api
        .invoke<unknown, { dir: string }>(COMMAND_CHANNELS.EXTENSIONS_GET_MARKETPLACE_DIR, {})
        .catch(() => null),
    ]).then(([claude, codex, dir]) => {
      if (dir) setMarketplaceDir(dir.dir);
      const next = new Set<ExtensionSetupItemId>();
      const claudeHere = claude?.claudeInstalled ?? true;
      const codexHere = codex?.codexInstalled ?? true;
      if (claudeHere) next.add('claude-tabs').add('claude-math');
      if (codexHere) next.add('codex-tabs');
      setSelected(next);
    });
  }, [open, preselected]);

  const { isTop } = useOverlayRegistration(open);
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && isTop()) void dismiss();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, isTop]);

  const showError = (message: string): void => toast.push({ kind: 'error', message });

  const markSeen = async (): Promise<void> => {
    try {
      await window.api.invoke(COMMAND_CHANNELS.SETTINGS_UPDATE, {
        partial: { extensions: { setupSeen: true } },
      });
    } catch (err) {
      showError(err instanceof Error ? err.message : String(err));
    }
  };

  const dismiss = async (): Promise<void> => {
    setOpen(false);
    await markSeen();
  };

  const setUp = async (): Promise<void> => {
    setBusy(true);
    try {
      const switches = extensionSetupSettings(selected);
      await window.api.invoke(COMMAND_CHANNELS.SETTINGS_UPDATE, {
        partial: { extensions: { ...switches, setupSeen: true } },
      });
      if (selected.has('codex-tabs')) {
        await window.api.invoke<unknown, CodexMcpStatus>(
          COMMAND_CHANNELS.EXTENSIONS_CODEX_MCP_INSTALL,
          {},
        );
      }
      setOpen(false);
      if (extensionSetupNeedsTerminal(selected)) {
        const dir = marketplaceDir;
        if (!dir)
          throw new Error(
            tx('还没拿到插件目录,请稍后再试', 'Plugin folder not known yet; try again'),
          );
        await typer.run(
          (shellId) => extensionSetupCommand(shellId, dir, selected) ?? '',
          showError,
        );
      } else {
        toast.push({ kind: 'info', message: tx('扩展已设置好', 'Extensions set up') });
      }
    } catch (err) {
      showError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;

  const toggle = (id: ExtensionSetupItemId): void =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const count = EXTENSION_SETUP_ITEMS.filter((id) => selected.has(id)).length;
  const needsTerminal = extensionSetupNeedsTerminal(selected);

  return (
    <div className="app-modal-backdrop" data-guide="extension-setup">
      <div className="app-modal-panel extension-setup-panel" role="dialog" aria-modal="true">
        <div className="app-modal-title extension-setup-title">
          <span>{tx('一次装好 agent 扩展', 'Set up agent extensions')}</span>
          <span className="extension-setup-once">{tx('只问一次', 'once only')}</span>
        </div>
        <div className="app-modal-message">
          {tx(
            '勾选要用的,点"设置选中的"。开关立即打开,Codex 的配置由 Ceteris 写入;要在终端里跑的命令会一起输进一个新终端,你按一次 Enter。以后在 设置 → 扩展 还能改。',
            'Tick what you use and press Set up. Switches turn on at once and Ceteris writes the Codex entry; the terminal commands are typed together into one new terminal, and you press Enter once. Everything stays adjustable in Settings, Extensions.',
          )}
        </div>
        <div className="extension-setup-groups">
          {GROUPS.map((g) => (
            <div key={g.id} className="extension-setup-group">
              <div className="extension-setup-group-title">{tx(g.title[0], g.title[1])}</div>
              {ITEMS.filter((it) => it.group === g.id).map((it) => (
                <label key={it.id} className="settings-checkbox extension-setup-item">
                  <input
                    type="checkbox"
                    checked={selected.has(it.id)}
                    onChange={() => toggle(it.id)}
                  />
                  <span className="extension-setup-item-text">
                    <span className="extension-setup-item-title">
                      {tx(it.title[0], it.title[1])}
                    </span>
                    <span className="extension-setup-item-detail">
                      {tx(it.detail[0], it.detail[1])}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          ))}
        </div>
        {needsTerminal && (
          <div className="extension-setup-note">
            {tx(
              '会打开一个新终端并输入命令,不会自动执行;看一眼再按 Enter。',
              'A new terminal opens with the commands typed in; nothing runs until you press Enter.',
            )}
          </div>
        )}
        <div className="app-modal-actions">
          <button type="button" className="app-modal-button" onClick={() => void dismiss()}>
            {tx('以后再说', 'Later')}
          </button>
          <button
            type="button"
            className="app-modal-button app-modal-button-primary"
            disabled={busy || count === 0 || typer.preparing}
            onClick={() => void setUp()}
          >
            {count > 0
              ? tx(`设置选中的 ${count} 项`, `Set up ${count} selected`)
              : tx('设置选中的', 'Set up selected')}
          </button>
        </div>
      </div>
    </div>
  );
}
