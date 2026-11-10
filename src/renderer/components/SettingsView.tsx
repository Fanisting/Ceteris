/**
 * @file src/renderer/components/SettingsView.tsx
 * @purpose CP-4 设置页面 — view 形态 (替换整个 body),左侧 7 分类导航 +
 *   右侧详情面板,所有设置项即改即生效 (无保存按钮,软件定义书 6.6.1)。
 *
 * @关键设计:
 * - 不是 modal,不是新窗口,而是替换 app body 的 view (用户决策对齐)
 * - 任一窗口里的设置 UI 完全相同;改一处 → main 广播 → 所有窗口同步
 * - 校验失败由 main 端 SettingsManager 抛 InvalidSettings,renderer 显示
 *   错误条但不阻止用户继续输入 (input 内部状态 = main 实际值)
 * - 7 分类按软件定义书 6.6.2 分组:外观 / Shell 与启动 / 行为 / 数据 /
 *   系统集成 / 高级 / 关于
 *
 * @CP-4 chunk 范围:
 * - chunk 1: 骨架 + 主题
 * - chunk 2 (本): 外观/Shell/行为/高级 全部接通;数据/系统集成 留 placeholder;
 *   关于留 placeholder (chunk 5 接构建信息 + 链接)
 * - chunk 4: 数据导入/导出 (data 分类) + 启动模板管理子页 (shell 分类内)
 * - chunk 5: 关于 + 构建信息
 *
 * @对应文档章节: 软件定义书.md 6.6 节 (设置页面)
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ReactNode,
} from 'react';
import {
  COMMAND_CHANNELS,
  type AddTemplatePayload,
  type AddSshProfileResponse,
  type AddTemplateResponse,
  type ExplorerIntegrationStatus,
  type ImportSettingsResponse,
  type KnownHostsRefreshResponse,
  type ListShellsResponse,
  type ExportSettingsResponse,
  type PickSshKeyFileResponse,
  type SetExplorerIntegrationResponse,
  type SshAgentStatusResponse,
  type SshConfigEntryDto,
  type SshConfigListResponse,
  type UpdateSshProfileResponse,
  type UpdateTemplatePayload,
  type UpdateTemplateResponse,
} from '@shared/protocol';
import { formatDisplayPath, toWslUncPath } from '@shared/path-display';
import type {
  NewTerminalShellPolicy,
  PostExitAction,
  StartupBehavior,
  Template,
  TerminalRightClick,
  WindowStyle,
} from '@shared/types';
import type { DeepPartial } from '@shared/types-helpers';
import type { Settings } from '@shared/types';
import { useAppDispatch, useAppState } from '../store';
import {
  RECOMMENDED_TERMINAL_FONTS,
  RECOMMENDED_UI_FONTS,
  listAllFonts,
  probeFonts,
  type FontEntry,
} from './font-detection';
import { Icon, type IconName } from './icons';
import { LinkPanel } from './LinkPanel';
import { QuickLaunchSettings } from './QuickLaunchSettings';
import { useModal } from './Modal';
import {
  NEXT_PROMPT_DEFAULT_BASE_URL,
  type FrequentPrompt,
  type NextPromptUsage,
  nextPromptConfigured,
} from '@shared/next-prompt';
import {
  AGENT_TITLE_DEFAULT_GUIDE,
  AGENT_TITLE_DEFAULT_MAX_CHARS,
  AGENT_TITLE_MAX_GUIDE_CHARS,
  AGENT_TITLE_MAX_MAX_CHARS,
  AGENT_TITLE_MIN_MAX_CHARS,
} from '@shared/agent-title';
import { NextPromptModelPicker } from './NextPromptModelPicker';
import { OpenRouterAccount } from './OpenRouterAccount';
import type {
  CreateSessionResponse,
  DataAgentStats,
  DataBundleSummary,
  DataExportPayload,
  DataExportResponse,
  DataImportPayload,
  DataImportResponse,
  SuggestNextPromptPayload,
  SuggestNextPromptResponse,
  GetFrequentPromptsResponse,
} from '@shared/protocol';
import { TemplateIcon } from './TemplateIcon';
import { useToast } from './Toast';
import { useTypeIntoNewTerminal } from './type-into-terminal';
import { useTranslation } from './LanguageProvider';
import { ThemePicker } from './ThemePicker';
import { LegadoDynamicControls } from './LegadoDynamicControls';
import { isLegadoDynamicThemeId, LEGADO_DEFAULT_SEED } from '@shared/legado-dynamic-ids';
import { NextPromptCostChart, formatUsd } from './NextPromptCostChart';
import { useUpdateStatus } from '../hooks/useUpdateStatus';
import type { UpdateStatus } from '@shared/update-check';
import { TERMINAL_KEYBINDINGS } from '@shared/terminal-keybindings';
import { latexMathInstallLine, latexMathInstallLines } from '@shared/claude-math-images';
import {
  TAB_CONTROL_UPDATE_COMMAND,
  tabControlInstallLine,
  tabControlInstallLines,
} from '@shared/tab-control';
import { CODEX_MATH_INSTRUCTION, codexMathInstructionCommand } from '@shared/terminal-math';

type CategoryId =
  | 'appearance'
  | 'shell'
  | 'behavior'
  | 'data'
  | 'remote'
  | 'system-integration'
  | 'ai'
  | 'extensions'
  | 'advanced'
  | 'about';

interface CategoryDef {
  id: CategoryId;
  iconName: IconName;
  titleKey: string;
}

// CP-4 勘误 #11:用 lucide 图标替换原有 Emoji。BETA-031 新增 'AI 助手'。
// BETA-004:title 改 i18n key,渲染时由 t() 转。
// SSH 方案 v2.1 §II.6:'remote' 分类条件渲染(见 buildVisibleCategories);
const BASE_CATEGORIES: CategoryDef[] = [
  { id: 'appearance', iconName: 'appearance', titleKey: 'settings.category.appearance' },
  { id: 'shell', iconName: 'shell', titleKey: 'settings.category.shell' },
  { id: 'behavior', iconName: 'behavior', titleKey: 'settings.category.behavior' },
  { id: 'data', iconName: 'data', titleKey: 'settings.category.data' },
  {
    id: 'system-integration',
    iconName: 'systemIntegration',
    titleKey: 'settings.category.systemIntegration',
  },
  { id: 'ai', iconName: 'ai', titleKey: 'settings.category.ai' },
  { id: 'extensions', iconName: 'extensions', titleKey: 'settings.category.extensions' },
  { id: 'advanced', iconName: 'advanced', titleKey: 'settings.category.advanced' },
  { id: 'about', iconName: 'about', titleKey: 'settings.category.about' },
];

const REMOTE_CATEGORY: CategoryDef = {
  id: 'remote',
  iconName: 'server',
  titleKey: 'settings.category.remote',
};

/**
 * 'remote' 放在 'data' 之后、'system-integration' 之前,语义上跟"数据"分类的
 * "远程文件夹"延续。
 */
const VISIBLE_CATEGORIES: CategoryDef[] = BASE_CATEGORIES.flatMap((c) =>
  c.id === 'data' ? [c, REMOTE_CATEGORY] : [c],
);

// 把 settings update 走 IPC 的副作用集中,所有控件都用这个
async function updateSettings(
  partial: DeepPartial<Settings>,
  setError: (msg: string | null) => void,
): Promise<void> {
  setError(null);
  try {
    await window.api.invoke(COMMAND_CHANNELS.SETTINGS_UPDATE, { partial });
  } catch (err: unknown) {
    setError(err instanceof Error ? err.message : String(err));
  }
}

export function SettingsView(): JSX.Element {
  const dispatch = useAppDispatch();
  const { t } = useTranslation();
  // 'link' is the Tailscale tab of the remote category, see RemoteCategory.
  const requestedRaw = useAppState().settingsCategory;
  const requested = (requestedRaw === 'link' ? 'remote' : requestedRaw) as CategoryId | null;
  const [active, setActive] = useState<CategoryId>(requested ?? 'appearance');
  useEffect(() => {
    if (requested) setActive(requested);
  }, [requested]);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const handleClose = useCallback(() => {
    dispatch({ type: 'view/exit-settings' });
  }, [dispatch]);

  return (
    <div className="settings-view">
      <header className="settings-header">
        <button
          type="button"
          className="settings-close"
          onClick={handleClose}
          title={t('settings.close')}
          aria-label={t('settings.close')}
        >
          ×
        </button>
        <h1 className="settings-title">{t('settings.title')}</h1>
        {errorMsg && (
          <span className="settings-error" role="alert">
            <Icon name="alertTriangle" size={12} /> {errorMsg}
          </span>
        )}
      </header>
      <div className="settings-body">
        <nav className="settings-nav" aria-label={t('settings.title')}>
          {VISIBLE_CATEGORIES.map((c) => (
            <button
              key={c.id}
              type="button"
              className={`settings-nav-item${active === c.id ? ' active' : ''}`}
              onClick={() => setActive(c.id)}
              data-testid={`settings-nav-${c.id}`}
            >
              <span className="settings-nav-icon" aria-hidden="true">
                <Icon name={c.iconName} size={14} />
              </span>
              <span className="settings-nav-label">{t(c.titleKey)}</span>
            </button>
          ))}
        </nav>
        <main className="settings-detail">
          <CategoryPanel categoryId={active} setError={setErrorMsg} />
        </main>
      </div>
    </div>
  );
}

interface CategoryPanelProps {
  categoryId: CategoryId;
  setError: (msg: string | null) => void;
}

function CategoryPanel({ categoryId, setError }: CategoryPanelProps): JSX.Element {
  switch (categoryId) {
    case 'appearance':
      return <AppearancePanel setError={setError} />;
    case 'shell':
      return <ShellPanel setError={setError} />;
    case 'behavior':
      return <BehaviorPanel setError={setError} />;
    case 'data':
      return <DataPanel setError={setError} />;
    case 'remote':
      return <RemoteCategory setError={setError} />;
    case 'system-integration':
      return <SystemIntegrationPanel setError={setError} />;
    case 'ai':
      return <AiPanel setError={setError} />;
    case 'extensions':
      return <ExtensionsPanel setError={setError} />;
    case 'advanced':
      return <AdvancedPanel setError={setError} />;
    case 'about':
      return <AboutPanel setError={setError} />;
    default:
      return <></>;
  }
}

// ──────────────────────────────────────────────────────────────────
// 外观分类
// ──────────────────────────────────────────────────────────────────

function AppearancePanel({ setError }: { setError: (msg: string | null) => void }): JSX.Element {
  const { tx } = useTranslation();
  const state = useAppState();
  const a = state.settings.appearance;
  const theme = a?.theme ?? 'light-pink';
  const windowStyle: WindowStyle = a?.windowStyle ?? 'windows';
  const terminalFontFamily = a?.terminalFontFamily ?? '';
  const terminalFontSize = a?.terminalFontSize ?? 13;
  const terminalLineHeight = a?.terminalLineHeight ?? 1.2;
  const uiFontFamily = a?.uiFontFamily ?? '';
  const uiZoom = a?.uiZoom ?? 1;

  const language = a?.language ?? 'system';

  // CP-4 勘误 #3:用 queryLocalFonts 真实枚举系统字体,推荐字体置顶。
  // 异步加载,装载前用 probeFonts(推荐) 快速兜底,UX 上看是"先出推荐再补全"。
  const [terminalFonts, setTerminalFonts] = useState<FontEntry[]>(() =>
    probeFonts(RECOMMENDED_TERMINAL_FONTS),
  );
  const [uiFonts, setUiFonts] = useState<FontEntry[]>(() => probeFonts(RECOMMENDED_UI_FONTS));
  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      listAllFonts(RECOMMENDED_TERMINAL_FONTS, true),
      listAllFonts(RECOMMENDED_UI_FONTS, false),
    ])
      .then(([term, ui]) => {
        if (cancelled) return;
        setTerminalFonts(term);
        setUiFonts(ui);
      })
      .catch((err) => {
        console.warn('[Appearance] listAllFonts failed', err);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section className="settings-panel">
      <h2 className="settings-panel-title">外观</h2>

      <SettingRow
        label={tx('主题', 'Theme')}
        hint={tx(
          '所有窗口立即同步;xterm 颜色与 UI 同步切换',
          'Applies to all windows immediately; xterm colors stay in sync',
        )}
      >
        <ThemePicker
          value={theme}
          onChange={(id) => void updateSettings({ appearance: { theme: id } }, setError)}
        />
      </SettingRow>

      {/* ADR-030:Legado MD3 的 Custom / Windows Accent 主题才显示 */}
      {isLegadoDynamicThemeId(theme) && (
        <SettingRow
          label={tx('Legado MD3 配色', 'Legado MD3 colours')}
          hint={tx(
            '用一个颜色生成整套 Material 3 配色,同 legado-with-MD3 的自定义主题',
            'Builds a full Material 3 scheme from one colour, like the custom theme in legado-with-MD3',
          )}
        >
          <LegadoDynamicControls
            mode={theme.startsWith('legado-md3-seed') ? 'seed' : 'accent'}
            seed={a?.legadoSeedColor ?? LEGADO_DEFAULT_SEED}
            style={a?.legadoPaletteStyle ?? 'tonalSpot'}
            contrast={a?.legadoContrast ?? 'standard'}
            onChange={(patch) => void updateSettings({ appearance: patch }, setError)}
          />
        </SettingRow>
      )}

      <SettingRow
        label={tx('窗口风格', 'Window style')}
        hint={tx(
          '影响标题栏布局与窗口控制按钮位置(不影响主题配色)',
          'Title bar layout and control button position (does not affect theme colors)',
        )}
      >
        <div className="settings-radio-group">
          <label className="settings-radio">
            <input
              type="radio"
              name="window-style"
              value="windows"
              checked={windowStyle === 'windows'}
              onChange={() =>
                void updateSettings(
                  { appearance: { windowStyle: 'windows' as WindowStyle } },
                  setError,
                )
              }
            />
            Windows(按钮在右,方形)
          </label>
          <label className="settings-radio">
            <input
              type="radio"
              name="window-style"
              value="macos"
              checked={windowStyle === 'macos'}
              onChange={() =>
                void updateSettings(
                  { appearance: { windowStyle: 'macos' as WindowStyle } },
                  setError,
                )
              }
            />
            macOS(三色 traffic light 在左,圆形)
          </label>
        </div>
      </SettingRow>

      <SettingRow
        label={tx('终端字体', 'Terminal font')}
        hint={tx('系统已安装的等宽字体 + 推荐字体', 'Installed monospace fonts + recommended')}
      >
        <FontPicker
          value={terminalFontFamily}
          fonts={terminalFonts}
          onChange={(value) =>
            void updateSettings({ appearance: { terminalFontFamily: value } }, setError)
          }
        />
      </SettingRow>

      <SettingRow
        label={tx('终端字号', 'Terminal font size')}
        hint={tx('范围 8 - 24', 'Range 8 - 24')}
      >
        <NumberInput
          value={terminalFontSize}
          min={8}
          max={24}
          step={1}
          onChange={(v) => void updateSettings({ appearance: { terminalFontSize: v } }, setError)}
        />
      </SettingRow>

      <SettingRow
        label={tx('终端行高', 'Terminal line height')}
        hint={tx('范围 1.0 - 2.0', 'Range 1.0 - 2.0')}
      >
        <NumberInput
          value={terminalLineHeight}
          min={1}
          max={2}
          step={0.05}
          onChange={(v) => void updateSettings({ appearance: { terminalLineHeight: v } }, setError)}
        />
      </SettingRow>

      <SettingRow
        label={tx('UI 字体', 'UI font')}
        hint={tx('侧栏 / 按钮 / 标签等 UI 区域', 'Sidebar / buttons / tabs and other UI areas')}
      >
        <FontPicker
          value={uiFontFamily}
          fonts={uiFonts}
          onChange={(value) =>
            void updateSettings({ appearance: { uiFontFamily: value } }, setError)
          }
        />
      </SettingRow>

      <SettingRow
        label={tx('UI 缩放', 'UI zoom')}
        hint={tx('范围 75% - 150%,影响整个 UI 字号', 'Range 75% - 150%, affects all UI font sizes')}
      >
        <NumberInput
          value={uiZoom}
          min={0.75}
          max={1.5}
          step={0.05}
          formatPercent
          onChange={(v) => void updateSettings({ appearance: { uiZoom: v } }, setError)}
        />
      </SettingRow>

      {/* BETA-004:语言切换 */}
      <SettingRow
        label={tx('语言', 'Language')}
        hint={tx(
          "切换 UI 显示语言;'跟随系统'下 zh-* 系统显示中文,其他显示英文",
          "Switch UI language; 'Follow system' picks Chinese for zh-* locales, English otherwise",
        )}
      >
        <select
          className="settings-input"
          value={language}
          onChange={(e) =>
            void updateSettings(
              { appearance: { language: e.target.value as 'system' | 'zh-CN' | 'en-US' } },
              setError,
            )
          }
        >
          <option value="system">{tx('跟随系统', 'Follow system')}</option>
          <option value="zh-CN">中文</option>
          <option value="en-US">English</option>
        </select>
      </SettingRow>

      {/* BETA-023:macOS 风格红绿灯悬浮符号 */}
      {windowStyle === 'macos' && (
        <SettingRow
          label={tx('红绿灯悬浮符号', 'Traffic-light hover symbols')}
          hint={tx(
            'macOS 风格下,鼠标移到红绿灯按钮上是否显示 ×/−/+;默认关(更克制)',
            'Show ×/−/+ when hovering traffic-light buttons in macOS style; off by default (more minimal)',
          )}
        >
          <label className="settings-checkbox">
            <input
              type="checkbox"
              checked={a?.macOSTrafficLightHoverSymbols ?? false}
              onChange={(e) =>
                void updateSettings(
                  { appearance: { macOSTrafficLightHoverSymbols: e.target.checked } },
                  setError,
                )
              }
            />
            <span>启用</span>
          </label>
        </SettingRow>
      )}

      {/* issue #4:隐藏顶部标签栏 */}
      <SettingRow
        label={tx('隐藏顶部标签栏', 'Hide top tab bar')}
        hint={tx(
          '侧栏已按路径分组显示所有会话;隐藏后点路径直接进新建页,要切已有会话从侧栏点',
          'Sidebar already groups sessions by path; when hidden, clicking a path opens the new-session page — switch to an existing session via the sidebar',
        )}
      >
        <label className="settings-checkbox">
          <input
            type="checkbox"
            checked={a?.hideTopTabBar ?? false}
            onChange={(e) =>
              void updateSettings({ appearance: { hideTopTabBar: e.target.checked } }, setError)
            }
          />
          <span>{tx('启用', 'Enable')}</span>
        </label>
      </SettingRow>

      {/* ADR-027:小庆祝与标题栏小石子 */}
      <SettingRow
        label={tx('小庆祝', 'Little celebrations')}
        hint={tx(
          'agent 跑完而你在看别处时,它的圆点上飞出几颗小星星,样式随主题;不抢焦点、不出声',
          'When an agent finishes while you look elsewhere, a few sparkles pop off its dot, styled by the theme. No focus change, no sound',
        )}
      >
        <label className="settings-checkbox">
          <input
            type="checkbox"
            checked={a?.celebrations ?? true}
            onChange={(e) =>
              void updateSettings({ appearance: { celebrations: e.target.checked } }, setError)
            }
          />
          <span>{tx('启用', 'Enable')}</span>
        </label>
      </SettingRow>

      {(a?.celebrations ?? true) && (
        <SettingRow
          label={tx('标题栏小石子', 'Title bar pebble')}
          hint={tx(
            '窗口按钮旁的小圆团:都空闲时打盹,agent 干活时睁眼,跑完时笑一下',
            'A small blob beside the window buttons: dozes when all is idle, watches while agents work, smiles when one finishes',
          )}
        >
          <label className="settings-checkbox">
            <input
              type="checkbox"
              checked={a?.pebble ?? false}
              onChange={(e) =>
                void updateSettings({ appearance: { pebble: e.target.checked } }, setError)
              }
            />
            <span>{tx('启用', 'Enable')}</span>
          </label>
        </SettingRow>
      )}
    </section>
  );
}

// ──────────────────────────────────────────────────────────────────
// Shell 与启动分类
// ──────────────────────────────────────────────────────────────────

function ShellPanel({ setError }: { setError: (msg: string | null) => void }): JSX.Element {
  const { tx } = useTranslation();
  const state = useAppState();
  const sh = state.settings.shell;
  const defaultShellId = sh?.defaultShellId ?? '';
  const policy = sh?.newTerminalShellPolicy ?? 'default';

  const [shells, setShells] = useState<
    Array<{ id: string; displayName: string; executablePath: string }>
  >([]);
  const [templateMode, setTemplateMode] = useState<
    { kind: 'list' } | { kind: 'edit'; templateId: string | null /* null = 新建 */ }
  >({ kind: 'list' });

  useEffect(() => {
    let cancelled = false;
    window.api
      .invoke<unknown, ListShellsResponse>(COMMAND_CHANNELS.SETTINGS_LIST_SHELLS, {})
      .then((res) => {
        if (!cancelled) setShells(res.shells);
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        setError(tx(`枚举可用 shell 失败:${msg}`, `Failed to enumerate shells: ${msg}`));
      });
    return () => {
      cancelled = true;
    };
  }, [setError, tx]);

  if (templateMode.kind === 'edit') {
    return (
      <TemplateEditor
        templateId={templateMode.templateId}
        onClose={() => setTemplateMode({ kind: 'list' })}
        setError={setError}
      />
    );
  }

  return (
    <section className="settings-panel">
      <h2 className="settings-panel-title">{tx('Shell 与启动', 'Shell & Startup')}</h2>

      <SettingRow
        label={tx('默认 shell', 'Default shell')}
        hint={tx('新终端启动时使用的 shell', 'Shell used when a new terminal starts')}
      >
        <select
          className="settings-input"
          value={defaultShellId}
          onChange={(e) =>
            void updateSettings({ shell: { defaultShellId: e.target.value } }, setError)
          }
        >
          <option value="">
            {tx(
              '自动检测最优(pwsh > powershell > cmd)',
              'Auto-detect best (pwsh > powershell > cmd)',
            )}
          </option>
          {shells.map((s) => (
            <option key={s.id} value={s.id}>
              {s.displayName} — {s.executablePath}
            </option>
          ))}
        </select>
      </SettingRow>

      <SettingRow
        label={tx('新终端使用的 shell', 'Shell for new terminals')}
        hint={tx('"默认 shell"或"上次用过的 shell"', '"Default shell" or "Last used shell"')}
      >
        <div className="settings-radio-group">
          <label className="settings-radio">
            <input
              type="radio"
              name="shell-policy"
              value="default"
              checked={policy === 'default'}
              onChange={() =>
                void updateSettings(
                  {
                    shell: {
                      newTerminalShellPolicy: 'default' as NewTerminalShellPolicy,
                    },
                  },
                  setError,
                )
              }
            />
            {tx('使用默认 shell', 'Use default shell')}
          </label>
          <label className="settings-radio">
            <input
              type="radio"
              name="shell-policy"
              value="last-used"
              checked={policy === 'last-used'}
              onChange={() =>
                void updateSettings(
                  {
                    shell: {
                      newTerminalShellPolicy: 'last-used' as NewTerminalShellPolicy,
                    },
                  },
                  setError,
                )
              }
            />
            {tx('使用上次用过的 shell', 'Use last used shell')}
          </label>
        </div>
      </SettingRow>

      <SettingRow
        label={tx('启动模板', 'Launch templates')}
        hint={tx(
          '新建终端时可选的模板;内置不可删,可改名',
          'Templates for new terminals; built-ins can be renamed but not deleted',
        )}
      >
        <TemplateList
          onEdit={(id) => setTemplateMode({ kind: 'edit', templateId: id })}
          onCreate={() => setTemplateMode({ kind: 'edit', templateId: null })}
          setError={setError}
        />
      </SettingRow>

      <AgentUpdateSettings setError={setError} />
    </section>
  );
}

/**
 * Agent CLI 更新的两个开关 + 立即检查 (内嵌在 ShellPanel,紧跟启动模板)。
 * 调度逻辑在 main 的 agent-auto-update.ts;这里只写设置、触发一次检查。
 */
function AgentUpdateSettings({
  setError,
}: {
  setError: (msg: string | null) => void;
}): JSX.Element {
  const { tx } = useTranslation();
  const behavior = useAppState().settings.behavior;
  const autoCheck = behavior?.autoCheckAgents ?? true;
  const autoUpdate = behavior?.autoUpdateAgents ?? false;
  const [checking, setChecking] = useState(false);

  const checkNow = (): void => {
    setChecking(true);
    window.api
      .invoke(COMMAND_CHANNELS.AGENT_CHECK_NOW, undefined)
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        setError(tx(`检查 agent 更新失败:${msg}`, `Failed to check agents for updates: ${msg}`));
      })
      .finally(() => setChecking(false));
  };

  return (
    <>
      <SettingRow
        label={tx('自动检查 agent 更新', 'Check agents for updates')}
        hint={tx(
          '启动后和每 6 小时查一次 Claude Code、Codex 等是否有新版本,有就弹通知。Beta 和开发版不自动检查',
          'Checks Claude Code, Codex and the other agents at startup and every 6 hours, and shows a notice when a new version is out. Beta and dev builds do not check automatically',
        )}
      >
        <div className="settings-update-actions">
          <label className="settings-checkbox">
            <input
              type="checkbox"
              checked={autoCheck}
              onChange={(e) =>
                void updateSettings({ behavior: { autoCheckAgents: e.target.checked } }, setError)
              }
            />
            <span>{tx('启用', 'Enable')}</span>
          </label>
          <button type="button" className="settings-button" disabled={checking} onClick={checkNow}>
            {tx('立即检查', 'Check now')}
          </button>
        </div>
      </SettingRow>

      <SettingRow
        label={tx('自动升级 agent', 'Update agents automatically')}
        hint={tx(
          '发现新版本后先弹通知,30 秒后用安装它的工具升级;可以立即升级或跳过此版本。该 agent 还开着时等它关掉再升级',
          'When a new version is found, a notice appears first and the update runs 30 seconds later with the tool that installed the agent. You can update right away or skip that version. An agent that is still open updates after you close it',
        )}
      >
        <label className="settings-checkbox">
          <input
            type="checkbox"
            checked={autoUpdate}
            disabled={!autoCheck}
            onChange={(e) =>
              void updateSettings({ behavior: { autoUpdateAgents: e.target.checked } }, setError)
            }
          />
          <span>{tx('启用', 'Enable')}</span>
        </label>
      </SettingRow>
    </>
  );
}

// ──────────────────────────────────────────────────────────────────
// 启动模板列表 (内嵌在 ShellPanel 中)
// ──────────────────────────────────────────────────────────────────

function TemplateList({
  onEdit,
  onCreate,
  setError,
}: {
  onEdit: (id: string) => void;
  onCreate: () => void;
  setError: (msg: string | null) => void;
}): JSX.Element {
  const { tx } = useTranslation();
  const state = useAppState();
  const templates = state.templates;
  const defaultId = state.defaultTemplateId;
  const modal = useModal();

  const handleSetDefault = (id: string): void => {
    setError(null);
    window.api.invoke(COMMAND_CHANNELS.TEMPLATE_SET_DEFAULT, { id }).catch((err: unknown) => {
      setError(err instanceof Error ? err.message : String(err));
    });
  };

  const handleSetHidden = (id: string, hidden: boolean): void => {
    setError(null);
    window.api
      .invoke(COMMAND_CHANNELS.TEMPLATE_UPDATE, { id, partial: { hidden } })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
      });
  };

  const handleDelete = async (id: string): Promise<void> => {
    // CPB-P2 / FOC-5 一致化:原生 confirm 关闭后焦点不可控,且不走主题样式。
    // 统一走 modal.confirm,与项目其他危险操作风格一致。
    const ok = await modal.confirm({
      title: tx('删除自定义模板', 'Delete custom template'),
      message: tx(
        '该操作不可撤销。删除后任何引用此模板的会话仍可运行,但新建终端时不会再出现。',
        'This action cannot be undone. Existing sessions keep running, but new terminals will no longer offer this template.',
      ),
      confirmLabel: tx('删除', 'Delete'),
      danger: true,
    });
    if (!ok) return;
    setError(null);
    window.api.invoke(COMMAND_CHANNELS.TEMPLATE_DELETE, { id }).catch((err: unknown) => {
      setError(err instanceof Error ? err.message : String(err));
    });
  };

  return (
    <div className="template-list">
      {templates.map((t) => (
        <div key={t.id} className={`template-list-item${t.hidden ? ' hidden-template' : ''}`}>
          <span className="template-list-icon">
            {/* P2-14:与 MainPane.TemplateLaunchButton 一致 — builtin 走 lucide
                矢量,自定义模板 fallback emoji。原 {t.icon} 让 builtin 列表里
                也只显示 emoji 与启动按钮视觉脱节。 */}
            <TemplateIcon template={t} size={16} />
          </span>
          <span className="template-list-name">{t.name}</span>
          {t.isBuiltin && <span className="template-list-tag">{tx('内置', 'Built-in')}</span>}
          {t.id === defaultId && (
            <span className="template-list-tag default">{tx('默认', 'Default')}</span>
          )}
          {t.hidden && <span className="template-list-tag">{tx('已隐藏', 'Hidden')}</span>}
          <span
            className="template-list-cmd"
            title={t.command || tx('(纯 shell)', '(plain shell)')}
          >
            {t.command || tx('(纯 shell)', '(plain shell)')}
          </span>
          <div className="template-list-actions">
            {t.id !== defaultId && (
              <button
                type="button"
                className="settings-button"
                onClick={() => handleSetDefault(t.id)}
              >
                {tx('设为默认', 'Set as default')}
              </button>
            )}
            <button type="button" className="settings-button" onClick={() => onEdit(t.id)}>
              {tx('编辑', 'Edit')}
            </button>
            {t.id !== defaultId && (
              <button
                type="button"
                className="settings-button"
                title={tx('控制是否显示在新建页面', 'Whether it appears on the new tab page')}
                onClick={() => handleSetHidden(t.id, !t.hidden)}
              >
                {t.hidden ? tx('显示', 'Show') : tx('隐藏', 'Hide')}
              </button>
            )}
            {!t.isBuiltin && (
              <button
                type="button"
                className="settings-button danger"
                onClick={() => void handleDelete(t.id)}
              >
                {tx('删除', 'Delete')}
              </button>
            )}
          </div>
        </div>
      ))}
      <button
        type="button"
        className="settings-button"
        style={{ marginTop: 8, alignSelf: 'flex-start' }}
        onClick={onCreate}
      >
        {tx('+ 新建自定义模板', '+ New custom template')}
      </button>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────
// 启动模板编辑器
// ──────────────────────────────────────────────────────────────────

function TemplateEditor({
  templateId,
  onClose,
  setError,
}: {
  templateId: string | null;
  onClose: () => void;
  setError: (msg: string | null) => void;
}): JSX.Element {
  const { tx } = useTranslation();
  const state = useAppState();
  const isCreate = templateId === null;
  const existing = templateId ? state.templates.find((t) => t.id === templateId) : null;

  const [draft, setDraft] = useState<Template>(() => {
    if (existing) {
      return {
        ...existing,
        args: [...existing.args],
        env: { ...existing.env },
      };
    }
    return {
      id: '',
      name: '',
      icon: '🔧',
      isBuiltin: false,
      command: '',
      args: [],
      env: {},
      shellFirst: true,
      postExitAction: 'keep_shell' as PostExitAction,
    };
  });

  const [argsText, setArgsText] = useState<string>(() => draft.args.join(' '));
  const [envText, setEnvText] = useState<string>(() =>
    Object.entries(draft.env)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n'),
  );
  const [saving, setSaving] = useState(false);

  const handleSave = async (): Promise<void> => {
    setError(null);
    setSaving(true);
    try {
      const parsedArgs = argsText.trim() ? argsText.trim().split(/\s+/) : [];
      const parsedEnv: Record<string, string> = {};
      for (const line of envText.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx <= 0) {
          throw new Error(
            tx(
              `环境变量行格式错: "${line}" 应为 KEY=VALUE`,
              `Invalid env line "${line}", expected KEY=VALUE`,
            ),
          );
        }
        const key = trimmed.slice(0, eqIdx).trim();
        const value = trimmed.slice(eqIdx + 1);
        if (!key)
          throw new Error(
            tx(`环境变量名不能为空: "${line}"`, `Env var name cannot be empty: "${line}"`),
          );
        parsedEnv[key] = value;
      }

      if (isCreate) {
        const payload: AddTemplatePayload = {
          name: draft.name,
          icon: draft.icon,
          command: draft.command,
          args: parsedArgs,
          env: parsedEnv,
          shellFirst: draft.shellFirst,
          postExitAction: draft.postExitAction,
        };
        await window.api.invoke<AddTemplatePayload, AddTemplateResponse>(
          COMMAND_CHANNELS.TEMPLATE_ADD,
          payload,
        );
      } else {
        const payload: UpdateTemplatePayload = {
          id: draft.id,
          partial: {
            name: draft.name,
            icon: draft.icon,
            command: draft.command,
            args: parsedArgs,
            env: parsedEnv,
            shellFirst: draft.shellFirst,
            postExitAction: draft.postExitAction,
          },
        };
        await window.api.invoke<UpdateTemplatePayload, UpdateTemplateResponse>(
          COMMAND_CHANNELS.TEMPLATE_UPDATE,
          payload,
        );
      }
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="settings-panel">
      <h2 className="settings-panel-title">
        <button
          type="button"
          className="settings-button"
          style={{ marginRight: 8 }}
          onClick={onClose}
        >
          {tx('< 返回', '< Back')}
        </button>
        {isCreate
          ? tx('新建模板', 'New template')
          : tx(`编辑模板:${draft.name}`, `Edit template: ${draft.name}`)}
        {draft.isBuiltin && (
          <span className="template-list-tag" style={{ marginLeft: 8 }}>
            {tx(
              '内置(可改 name/icon/command/args/env,不可删)',
              'Built-in (editable, not deletable)',
            )}
          </span>
        )}
      </h2>

      <SettingRow label={tx('名称', 'Name')}>
        <input
          type="text"
          className="settings-input"
          value={draft.name}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          placeholder={tx('例如:My Claude', 'e.g. My Claude')}
        />
      </SettingRow>

      <SettingRow label={tx('图标 (emoji)', 'Icon (emoji)')}>
        <input
          type="text"
          className="settings-input"
          value={draft.icon}
          onChange={(e) => setDraft({ ...draft, icon: e.target.value })}
          placeholder="🔧"
          maxLength={4}
          style={{ minWidth: 60 }}
        />
      </SettingRow>

      <SettingRow
        label={tx('命令', 'Command')}
        hint={tx(
          '留空表示启动纯 shell;不要写 shell 路径,Ceteris 会自动注入 shell',
          'Leave empty for plain shell; do not specify the shell binary, Ceteris injects it',
        )}
      >
        <input
          type="text"
          className="settings-input"
          value={draft.command}
          onChange={(e) => setDraft({ ...draft, command: e.target.value })}
          placeholder={tx('例如:claude / codex / 留空', 'e.g. claude / codex / leave empty')}
        />
      </SettingRow>

      <SettingRow
        label={tx('参数', 'Arguments')}
        hint={tx(
          '空格分隔(简单 shell quoting,有空格的参数请避免)',
          'Space-separated (avoid args with spaces — simple shell quoting only)',
        )}
      >
        <input
          type="text"
          className="settings-input"
          value={argsText}
          onChange={(e) => setArgsText(e.target.value)}
          placeholder={tx('例如:--foo bar --baz', 'e.g. --foo bar --baz')}
        />
      </SettingRow>

      <SettingRow
        label={tx('环境变量', 'Environment variables')}
        hint={tx(
          '每行一个 KEY=VALUE。默认遮罩,点👁切显示(防被旁人看到 API key)',
          'One KEY=VALUE per line. Masked by default; click 👁 to reveal (avoid leaking API keys)',
        )}
      >
        <EnvTextarea value={envText} onChange={setEnvText} />
      </SettingRow>

      <SettingRow
        label={tx('启动方式', 'Launch mode')}
        hint={tx(
          '"先启动 shell"让命令退出后用户能继续看到 shell 提示符;"直接运行命令"启动更快',
          '"Shell first" keeps a prompt visible after the command exits; "Run command directly" is faster to start',
        )}
      >
        <div className="settings-radio-group">
          <label className="settings-radio">
            <input
              type="radio"
              name="shell-first"
              checked={draft.shellFirst}
              onChange={() => setDraft({ ...draft, shellFirst: true })}
            />
            {tx('先启动 shell 再运行命令', 'Start shell, then run command')}
          </label>
          <label className="settings-radio">
            <input
              type="radio"
              name="shell-first"
              checked={!draft.shellFirst}
              onChange={() => setDraft({ ...draft, shellFirst: false })}
            />
            {tx('直接运行命令', 'Run command directly')}
          </label>
        </div>
      </SettingRow>

      <SettingRow label={tx('命令退出后', 'After command exits')}>
        <div className="settings-radio-group">
          <label className="settings-radio">
            <input
              type="radio"
              name="post-exit"
              checked={draft.postExitAction === 'keep_shell'}
              onChange={() =>
                setDraft({ ...draft, postExitAction: 'keep_shell' as PostExitAction })
              }
            />
            {tx('留在 shell(若启动方式为先 shell)', 'Stay in shell (only if "Shell first")')}
          </label>
          <label className="settings-radio">
            <input
              type="radio"
              name="post-exit"
              checked={draft.postExitAction === 'close_session'}
              onChange={() =>
                setDraft({
                  ...draft,
                  postExitAction: 'close_session' as PostExitAction,
                })
              }
            />
            {tx('关闭 session', 'Close session')}
          </label>
          <label className="settings-radio">
            <input
              type="radio"
              name="post-exit"
              checked={draft.postExitAction === 'hold'}
              onChange={() => setDraft({ ...draft, postExitAction: 'hold' as PostExitAction })}
            />
            {tx('保留显示,等待用户手动关闭', 'Hold view until user closes manually')}
          </label>
        </div>
      </SettingRow>

      <div style={{ marginTop: 16, display: 'flex', gap: 8 }}>
        <button
          type="button"
          className="settings-button"
          onClick={() => void handleSave()}
          disabled={saving || !draft.name.trim()}
          style={{
            background: 'var(--md-primary, #f0f)',
            color: 'var(--md-on-primary, #f0f)',
            borderColor: 'var(--md-primary, #f0f)',
          }}
        >
          {saving ? tx('保存中…', 'Saving…') : isCreate ? tx('创建', 'Create') : tx('保存', 'Save')}
        </button>
        <button type="button" className="settings-button" onClick={onClose}>
          {tx('取消', 'Cancel')}
        </button>
      </div>
    </section>
  );
}

// ──────────────────────────────────────────────────────────────────
// 行为分类
// ──────────────────────────────────────────────────────────────────

function BehaviorPanel({ setError }: { setError: (msg: string | null) => void }): JSX.Element {
  const { tx } = useTranslation();
  const state = useAppState();
  const b = state.settings.behavior;
  const startupBehavior = b?.startupBehavior ?? 'open-window';
  const confirmOnQuit = b?.confirmOnQuit ?? true;
  const selectOnCopy = b?.selectOnCopy ?? true;
  const terminalRightClick = b?.terminalRightClick ?? 'menu';

  return (
    <section className="settings-panel">
      <h2 className="settings-panel-title">{tx('行为', 'Behavior')}</h2>

      <SettingRow
        label={tx('启动时行为', 'Startup behavior')}
        hint={tx('配开机启动用', 'Used together with auto-start at login')}
      >
        <div className="settings-radio-group">
          <label className="settings-radio">
            <input
              type="radio"
              name="startup"
              value="open-window"
              checked={startupBehavior === 'open-window'}
              onChange={() =>
                void updateSettings(
                  {
                    behavior: {
                      startupBehavior: 'open-window' as StartupBehavior,
                    },
                  },
                  setError,
                )
              }
            />
            {tx('打开一个窗口', 'Open a window')}
          </label>
          <label className="settings-radio">
            <input
              type="radio"
              name="startup"
              value="tray-only"
              checked={startupBehavior === 'tray-only'}
              onChange={() =>
                void updateSettings(
                  {
                    behavior: {
                      startupBehavior: 'tray-only' as StartupBehavior,
                    },
                  },
                  setError,
                )
              }
            />
            {tx('仅启动到托盘', 'Tray only')}
          </label>
        </div>
      </SettingRow>

      <SettingRow
        label={tx('完全退出前确认', 'Confirm before full quit')}
        hint={tx(
          '托盘点"完全退出"且有 session 在跑时弹确认。关单窗口永远不弹',
          'Asks for confirmation when quitting from the tray with active sessions. Never asked when closing a single window.',
        )}
      >
        <label className="settings-checkbox">
          <input
            type="checkbox"
            checked={confirmOnQuit}
            onChange={(e) =>
              void updateSettings({ behavior: { confirmOnQuit: e.target.checked } }, setError)
            }
          />
          <span>{tx('启用', 'Enable')}</span>
        </label>
      </SettingRow>

      <SettingRow
        label={tx('选中即复制', 'Copy on select')}
        hint={tx(
          '终端选中文本自动复制(类 Linux)',
          'Automatically copy selected text in terminal (Linux style)',
        )}
      >
        <label className="settings-checkbox">
          <input
            type="checkbox"
            checked={selectOnCopy}
            onChange={(e) =>
              void updateSettings({ behavior: { selectOnCopy: e.target.checked } }, setError)
            }
          />
          <span>{tx('启用', 'Enable')}</span>
        </label>
      </SettingRow>

      <SettingRow
        label={tx('快捷启动', 'Quick launch')}
        hint={tx(
          '显示在标签栏末尾、+ 号旁边,点一下即启动',
          'Shown next to the + at the end of the tab bar, one click to start',
        )}
      >
        <QuickLaunchSettings
          onChange={(quickLaunch) => void updateSettings({ behavior: { quickLaunch } }, setError)}
        />
      </SettingRow>

      <SettingRow
        label={tx('终端右键行为', 'Terminal right-click action')}
        hint={tx('弹菜单 或 直接粘贴', 'Show menu or paste directly')}
      >
        <div className="settings-radio-group">
          <label className="settings-radio">
            <input
              type="radio"
              name="rclick"
              value="menu"
              checked={terminalRightClick === 'menu'}
              onChange={() =>
                void updateSettings(
                  {
                    behavior: {
                      terminalRightClick: 'menu' as TerminalRightClick,
                    },
                  },
                  setError,
                )
              }
            />
            {tx('弹菜单', 'Show menu')}
          </label>
          <label className="settings-radio">
            <input
              type="radio"
              name="rclick"
              value="paste"
              checked={terminalRightClick === 'paste'}
              onChange={() =>
                void updateSettings(
                  {
                    behavior: {
                      terminalRightClick: 'paste' as TerminalRightClick,
                    },
                  },
                  setError,
                )
              }
            />
            {tx('直接粘贴', 'Paste directly')}
          </label>
        </div>
      </SettingRow>

      <KeybindingsReference />
    </section>
  );
}

// ──────────────────────────────────────────────────────────────────
// 终端快捷键速查(KBD-1 整改,2026-05-24)— 数据源:terminal-keybindings.ts
//
// spec §7.2.2 写明唯一权威清单在代码侧的 TERMINAL_KEYBINDINGS,本卡片直接
// 渲染该数组,保证 spec / 代码 / UI 三处永不漂移。
//
// macOS 检测:用 navigator.platform(renderer 不能读 process.platform)。
// 命中 mac 时优先显示 specMac,否则 spec。
// ──────────────────────────────────────────────────────────────────

function KeybindingsReference(): JSX.Element {
  const { tx } = useTranslation();
  const isMac = navigator.platform.toLowerCase().includes('mac');
  return (
    <div className="settings-keybindings-card">
      <h3 className="settings-keybindings-title">{tx('终端快捷键速查', 'Terminal keybindings')}</h3>
      <p className="settings-keybindings-hint">
        {tx(
          '此清单为唯一权威。Ceteris 不支持其他应用内快捷键(spec §7.1)。',
          'Authoritative list. Ceteris does not support any other in-app shortcuts (spec §7.1).',
        )}
      </p>
      <table className="settings-keybindings-table">
        <thead>
          <tr>
            <th>{tx('键位', 'Key')}</th>
            <th>{tx('功能', 'Function')}</th>
          </tr>
        </thead>
        <tbody>
          {TERMINAL_KEYBINDINGS.map((b) => (
            <tr key={b.id}>
              <td>
                <kbd>{isMac && b.specMac ? b.specMac : b.spec}</kbd>
              </td>
              <td>{b.description}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────
// 数据分类 (chunk 4 完整接通,chunk 2 仅 "打开数据目录")
// ──────────────────────────────────────────────────────────────────

const formatSize = (bytes: number): string => {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
};

/**
 * Carry a setup to another PC as one folder. Ceteris's own data always goes and stays
 * small; each agent's chats are optional because they can run to gigabytes.
 */
function MoveToPcSection({ setError }: { setError: (msg: string | null) => void }): JSX.Element {
  const { tx } = useTranslation();
  const toast = useToast();
  const modal = useModal();
  const state = useAppState();
  const dispatch = useAppDispatch();
  const [sizes, setSizes] = useState<{ claude: DataAgentStats; codex: DataAgentStats } | null>(
    null,
  );
  const [claude, setClaude] = useState(false);
  const [codex, setCodex] = useState(false);
  const [busy, setBusy] = useState<'export' | 'import' | null>(null);

  useEffect(() => {
    let cancelled = false;
    window.api
      .invoke<undefined, { claude: DataAgentStats; codex: DataAgentStats }>(
        COMMAND_CHANNELS.DATA_MEASURE_AGENTS,
        undefined,
      )
      .then((res) => {
        if (!cancelled) setSizes(res);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const handleExport = async (): Promise<void> => {
    setError(null);
    setBusy('export');
    try {
      const res = await window.api.invoke<DataExportPayload, DataExportResponse>(
        COMMAND_CHANNELS.DATA_EXPORT_BUNDLE,
        { claude, codex },
      );
      if (!res.dir) return;
      const failed = (res.claude?.failed ?? 0) + (res.codex?.failed ?? 0);
      toast.push({
        kind: failed > 0 ? 'warn' : 'success',
        message:
          tx(`已导出到 ${res.dir}`, `Exported to ${res.dir}`) +
          (failed > 0
            ? tx(
                `。${failed} 个文件正被占用未能复制,关闭 Claude Code 和 Codex 后再导出可包含它们。`,
                `. ${failed} files were in use and skipped. Close Claude Code and Codex and export again to include them.`,
              )
            : ''),
        durationMs: 10000,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const handleImport = async (): Promise<void> => {
    setError(null);
    setBusy('import');
    try {
      const found = await window.api.invoke<undefined, DataBundleSummary | null>(
        COMMAND_CHANNELS.DATA_PICK_BUNDLE,
        undefined,
      );
      if (!found) return;
      const lines = [
        tx(
          `来自 ${found.hostname} 的导出,将导入:`,
          `Export from ${found.hostname}. This will import:`,
        ),
        tx(
          '· Ceteris 设置和文件夹(替换当前的,你的 API Key 和远程访问设置保持不变)',
          '· Ceteris settings and bookmarks (replacing the current ones; your API keys and remote access setup stay)',
        ),
        tx(`· ${found.tabs} 个标签页`, `· ${found.tabs} tabs`),
      ];
      if (found.claude) {
        lines.push(
          tx(
            `· Claude Code 聊天,复制到 ~/.claude(${formatSize(found.claude.bytes)})`,
            `· Claude Code chats into ~/.claude (${formatSize(found.claude.bytes)})`,
          ),
        );
      }
      if (found.codex) {
        lines.push(
          tx(
            `· Codex 聊天,复制到 ~/.codex(${formatSize(found.codex.bytes)})`,
            `· Codex chats into ~/.codex (${formatSize(found.codex.bytes)})`,
          ),
        );
      }
      lines.push(
        tx(
          '已有的聊天不会被删除,更新的文件也不会被覆盖。',
          'Existing chats are never deleted, and newer files are not overwritten.',
        ),
      );
      const ok = await modal.confirm({
        title: tx('导入 Ceteris 数据', 'Import Ceteris data'),
        message: lines.join('\n'),
        confirmLabel: tx('导入', 'Import'),
      });
      if (!ok) return;

      const res = await window.api.invoke<DataImportPayload, DataImportResponse>(
        COMMAND_CHANNELS.DATA_IMPORT_BUNDLE,
        { dir: found.dir },
      );
      const dims = state.lastTerminalDims;
      for (const tab of res.tabs) {
        const created = await window.api.invoke<unknown, CreateSessionResponse>(
          COMMAND_CHANNELS.SESSION_CREATE,
          { pathId: tab.pathId, templateId: tab.templateId, cols: dims.cols, rows: dims.rows },
        );
        if (tab.input) {
          await window.api.invoke(COMMAND_CHANNELS.SESSION_SEND_INPUT, {
            sessionId: created.session.id,
            data: tab.input,
          });
        }
      }
      if (res.tabs.length > 0) dispatch({ type: 'view/exit-settings' });
      toast.push({
        kind: res.missingTabs > 0 ? 'warn' : 'success',
        message:
          tx(
            `导入完成,已打开 ${res.tabs.length} 个标签页`,
            `Imported. Opened ${res.tabs.length} tabs`,
          ) +
          (res.missingTabs > 0
            ? tx(
                `,${res.missingTabs} 个的文件夹在这台电脑上不存在`,
                `. ${res.missingTabs} folders do not exist on this PC`,
              )
            : ''),
        durationMs: 10000,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const agentLabel = (name: string, stats: DataAgentStats | undefined): string => {
    if (!sizes) return name;
    return `${name} (${stats?.files ? formatSize(stats.bytes) : tx('未找到', 'not found')})`;
  };

  return (
    <>
      <h3 className="link-subsection-title">{tx('搬到另一台电脑', 'Move to another PC')}</h3>
      <p className="settings-panel-hint">
        {tx(
          '导出一个文件夹,复制到新电脑后在这里导入。Ceteris 数据总是包含,而且很小。聊天是复制的,原来的不受影响。账号登录、API Key 和令牌不会导出,所以换电脑后需要重新登录。聊天记录本身可能包含敏感内容,请妥善保管导出的文件夹。',
          'Export a folder, copy it over, and import it here. Ceteris data is always included and stays small. Chats are copied, so the originals are untouched. Logins, API keys and tokens are never exported, so you will log in again on the new PC. Chats themselves can hold private content, so keep the folder safe.',
        )}
      </p>
      <SettingRow label={tx('同时导出聊天', 'Also export chats')}>
        <div className="data-agent-options">
          <label className="settings-checkbox">
            <input
              type="checkbox"
              checked={claude}
              disabled={!sizes?.claude.files}
              onChange={(e) => setClaude(e.target.checked)}
            />
            <span>{agentLabel('Claude Code', sizes?.claude)}</span>
          </label>
          <label className="settings-checkbox">
            <input
              type="checkbox"
              checked={codex}
              disabled={!sizes?.codex.files}
              onChange={(e) => setCodex(e.target.checked)}
            />
            <span>{agentLabel('Codex', sizes?.codex)}</span>
          </label>
        </div>
      </SettingRow>
      <SettingRow label={tx('操作', 'Actions')}>
        <button
          type="button"
          className="settings-button"
          disabled={busy !== null}
          onClick={() => void handleExport()}
        >
          {busy === 'export' ? tx('导出中…', 'Exporting…') : tx('导出…', 'Export…')}
        </button>{' '}
        <button
          type="button"
          className="settings-button"
          disabled={busy !== null}
          onClick={() => void handleImport()}
        >
          {busy === 'import' ? tx('导入中…', 'Importing…') : tx('导入…', 'Import…')}
        </button>
      </SettingRow>
    </>
  );
}

function DataPanel({ setError }: { setError: (msg: string | null) => void }): JSX.Element {
  const { tx } = useTranslation();
  const [busy, setBusy] = useState<'export' | 'import' | null>(null);
  const [lastExportPath, setLastExportPath] = useState<string | null>(null);
  // SSH 相关 state/handlers 已迁到 RemotePanel(v2.1 §II.6),DataPanel 只保留
  // 与设备无关的"数据"操作 + WSL(WSL 仍属本机视野)。
  const [wslDistros, setWslDistros] = useState<Array<{ id: string; name: string }>>([]);
  const [wslDistroId, setWslDistroId] = useState('');
  const [wslPath, setWslPath] = useState('/home');
  const [wslPickedUncPath, setWslPickedUncPath] = useState<string | null>(null);
  const [wslName, setWslName] = useState('');
  // BETA-039:从主进程取真实 userData 路径(app.getPath('userData')),
  // portable / dev / 自定义 userData 场景下 UI 都准确;首次渲染前显示占位。
  const [dataDir, setDataDir] = useState<string>('…');
  useEffect(() => {
    let cancelled = false;
    window.api
      .invoke<unknown, { dataDir: string }>(COMMAND_CHANNELS.SYSTEM_GET_DATA_DIR, {})
      .then((res) => {
        if (!cancelled && res?.dataDir) setDataDir(res.dataDir);
      })
      .catch(() => {
        // 静默:UI 退回到占位文本;真实路径取不到不影响其他功能。
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    window.api
      .invoke<unknown, ListShellsResponse>(COMMAND_CHANNELS.SETTINGS_LIST_SHELLS, {})
      .then((res) => {
        if (cancelled) return;
        const distros = res.shells
          .filter((shell) => shell.id.startsWith('wsl:'))
          .map((shell) => ({
            id: shell.id,
            name: shell.id.slice('wsl:'.length),
          }));
        setWslDistros(distros);
        setWslDistroId((current) => current || distros[0]?.id || '');
      })
      .catch(() => {
        if (!cancelled) setWslDistros([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleOpenDataDir = (): void => {
    setError(null);
    window.api.invoke(COMMAND_CHANNELS.SYSTEM_OPEN_DATA_DIR, {}).catch((err: unknown) => {
      setError(err instanceof Error ? err.message : String(err));
    });
  };

  const handleExport = async (): Promise<void> => {
    setError(null);
    setLastExportPath(null);
    setBusy('export');
    try {
      const res = await window.api.invoke<unknown, ExportSettingsResponse>(
        COMMAND_CHANNELS.SETTINGS_EXPORT,
        {},
      );
      if (res.filePath) setLastExportPath(res.filePath);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const handleImport = async (): Promise<void> => {
    setError(null);
    setBusy('import');
    try {
      const res = await window.api.invoke<unknown, ImportSettingsResponse>(
        COMMAND_CHANNELS.SETTINGS_IMPORT,
        {},
      );
      if (res.status === 'error') {
        setError(
          tx(
            `导入失败:${res.errorMessage ?? '未知错误'}`,
            `Import failed: ${res.errorMessage ?? 'unknown error'}`,
          ),
        );
      }
      // 'imported' / 'cancelled' 不需提示;'imported' 之后 main 会立即 relaunch
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const handleAddWslBookmark = async (): Promise<void> => {
    setError(null);
    try {
      const distro = wslDistroId.startsWith('wsl:') ? wslDistroId.slice('wsl:'.length) : '';
      if (!distro) {
        setError(tx('请先选择 WSL 发行版', 'Select a WSL distro first'));
        return;
      }
      const normalizedPath = wslPath.trim().replaceAll('\\', '/');
      const usePickedUnc =
        wslPickedUncPath !== null && formatDisplayPath(wslPickedUncPath) === normalizedPath;
      if (!normalizedPath.startsWith('/') && !usePickedUnc) {
        setError(
          tx(
            'WSL 路径必须是 Linux 绝对路径,例如 /home/user/project',
            'WSL path must be an absolute Linux path, for example /home/user/project',
          ),
        );
        return;
      }
      const uncPath = usePickedUnc ? wslPickedUncPath : toWslUncPath(distro, normalizedPath);
      await window.api.invoke(COMMAND_CHANNELS.BOOKMARK_ADD, {
        path: uncPath,
        ...(wslName.trim() ? { displayName: wslName.trim() } : {}),
      });
      setWslPath('/home');
      setWslPickedUncPath(null);
      setWslName('');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handlePickWslFolder = async (): Promise<void> => {
    setError(null);
    try {
      const distro = wslDistroId.startsWith('wsl:') ? wslDistroId.slice('wsl:'.length) : '';
      if (!distro) {
        setError(tx('请先选择 WSL 发行版', 'Select a WSL distro first'));
        return;
      }
      const result = await window.api.invoke<unknown, { path: string | null }>(
        COMMAND_CHANNELS.BOOKMARK_PICK_FOLDER,
        { defaultPath: toWslUncPath(distro, wslPath) },
      );
      if (!result.path) return;
      setWslPickedUncPath(result.path);
      setWslPath(formatDisplayPath(result.path));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <section className="settings-panel">
      <h2 className="settings-panel-title">{tx('数据', 'Data')}</h2>
      <MoveToPcSection setError={setError} />

      <SettingRow
        label={tx('WSL 文件夹', 'WSL folder')}
        hint={tx(
          '选择 WSL 发行版并填写 Linux 绝对路径;添加后会出现在左侧对应 WSL 分组',
          'Pick a WSL distro and enter an absolute Linux path; it appears under the matching WSL group in the sidebar',
        )}
      >
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          <select
            className="settings-input"
            value={wslDistroId}
            onChange={(e) => setWslDistroId(e.target.value)}
            disabled={wslDistros.length === 0}
          >
            {wslDistros.length === 0 ? (
              <option value="">{tx('未检测到 WSL 发行版', 'No WSL distro detected')}</option>
            ) : (
              wslDistros.map((distro) => (
                <option key={distro.id} value={distro.id}>
                  {distro.name}
                </option>
              ))
            )}
          </select>
          <input
            className="settings-input"
            value={wslPath}
            onChange={(e) => {
              setWslPickedUncPath(null);
              setWslPath(e.target.value);
            }}
            placeholder="/home/user/project"
          />
          <input
            className="settings-input"
            value={wslName}
            onChange={(e) => setWslName(e.target.value)}
            placeholder={tx('显示名(可选)', 'Display name (optional)')}
          />
          <button
            type="button"
            className="settings-button"
            onClick={() => void handleAddWslBookmark()}
            disabled={wslDistros.length === 0}
          >
            {tx('加入 WSL', 'Add WSL')}
          </button>
          <button
            type="button"
            className="settings-button"
            onClick={() => void handlePickWslFolder()}
          >
            {tx('选择文件夹', 'Pick folder')}
          </button>
        </div>
      </SettingRow>

      <SettingRow
        label={tx('数据目录', 'Data directory')}
        hint={tx('所有 Ceteris 配置文件存放处', 'Where all Ceteris configuration files live')}
      >
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span className="settings-info-text" title={dataDir}>
            {dataDir}
          </span>
          <button type="button" className="settings-button" onClick={handleOpenDataDir}>
            {tx('在文件管理器中打开', 'Open in file manager')}
          </button>
        </div>
      </SettingRow>

      <SettingRow
        label={tx('导出设置', 'Export settings')}
        hint={tx(
          '把全部配置(文件夹 / 模板 / 设置)导出为 JSON 文件',
          'Export everything (folders / templates / settings) to a JSON file',
        )}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <button
            type="button"
            className="settings-button"
            disabled={busy !== null}
            onClick={() => void handleExport()}
          >
            {busy === 'export' ? tx('导出中…', 'Exporting…') : tx('导出…', 'Export…')}
          </button>
          {lastExportPath && (
            <span className="settings-info-text" style={{ fontSize: 11 }}>
              {tx('已导出到', 'Exported to')}: {lastExportPath}
            </span>
          )}
        </div>
      </SettingRow>

      <SettingRow
        label={tx('导入设置', 'Import settings')}
        hint={tx(
          '选择导出文件,二次确认后整体替换并重启应用',
          'Pick an export file; after a confirm, everything is replaced and the app restarts',
        )}
      >
        <button
          type="button"
          className="settings-button"
          disabled={busy !== null}
          onClick={() => void handleImport()}
        >
          {busy === 'import' ? tx('导入中…', 'Importing…') : tx('导入…', 'Import…')}
        </button>
      </SettingRow>
    </section>
  );
}

// ──────────────────────────────────────────────────────────────────
// 远程分类(SSH 方案 v2.1 §II.6)。本面板承载:
//   - SSH 服务器(CRUD + edit + 文件选择器 + 保存密码)
//   - 远程文件夹收藏(挂在某个 profile 下的 RemoteBookmark)
// ──────────────────────────────────────────────────────────────────

/**
 * Both ways of reaching another machine in one place. A tab each, because the two pages are
 * long and most people use only one of them. The title bar badge opens the matching tab.
 */
function RemoteCategory({ setError }: { setError: (msg: string | null) => void }): JSX.Element {
  const { tx } = useTranslation();
  const requested = useAppState().settingsCategory;
  const [tab, setTab] = useState<'link' | 'ssh'>(requested === 'remote' ? 'ssh' : 'link');
  useEffect(() => {
    if (requested === 'link') setTab('link');
    if (requested === 'remote') setTab('ssh');
  }, [requested]);

  return (
    <>
      <h2 className="settings-panel-title">{tx('远程', 'Remote')}</h2>
      <div className="settings-tabs" role="tablist">
        {(['link', 'ssh'] as const).map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={`settings-tab${tab === id ? ' active' : ''}`}
            onClick={() => setTab(id)}
          >
            {id === 'link' ? 'Tailscale' : 'SSH'}
          </button>
        ))}
      </div>
      {tab === 'link' ? <LinkPanel setError={setError} /> : <RemotePanel setError={setError} />}
    </>
  );
}

function RemotePanel({ setError }: { setError: (msg: string | null) => void }): JSX.Element {
  const { tx } = useTranslation();
  const state = useAppState();
  const [sshName, setSshName] = useState('');
  const [sshHost, setSshHost] = useState('');
  const [sshPort, setSshPort] = useState('22');
  const [sshUser, setSshUser] = useState('');
  const [sshAuthType, setSshAuthType] = useState<'keyFile' | 'password'>('password');
  const [sshKeyFile, setSshKeyFile] = useState('');
  const [sshPassword, setSshPassword] = useState('');
  const [sshSavePassword, setSshSavePassword] = useState(false);
  /** SSH 方案 §阶段 2.3:ProxyJump 多跳板,UI 用逗号分隔字符串展示 */
  const [sshProxyJump, setSshProxyJump] = useState('');
  const [editingProfileId, setEditingProfileId] = useState<string | null>(null);
  const [remoteProfileId, setRemoteProfileId] = useState('');
  const [remotePath, setRemotePath] = useState('~');
  const [remoteName, setRemoteName] = useState('');

  const includeSshConfig = state.settings?.advanced?.includeSshConfig === true;
  const enableControlMaster = state.settings?.advanced?.enableControlMaster !== false;

  // §阶段 2.2 / 2.1 / 3.1:ssh-agent / ssh_config / known_hosts 异步查询 — UI
  // 加载时拉一次,提供"刷新"按钮供用户手动重查
  const [agentStatus, setAgentStatus] = useState<SshAgentStatusResponse | null>(null);
  const [sshConfigEntries, setSshConfigEntries] = useState<SshConfigEntryDto[]>([]);
  const [knownHosts, setKnownHosts] = useState<KnownHostsRefreshResponse | null>(null);

  const refreshAgent = useCallback(() => {
    window.api
      .invoke<unknown, SshAgentStatusResponse>(COMMAND_CHANNELS.SSH_AGENT_STATUS, {})
      .then(setAgentStatus)
      .catch((err) => {
        console.warn('[RemotePanel] ssh-agent status query failed', err);
      });
  }, []);
  const refreshSshConfig = useCallback(() => {
    window.api
      .invoke<unknown, SshConfigListResponse>(COMMAND_CHANNELS.SSH_CONFIG_LIST, {})
      .then((r) => setSshConfigEntries(r.entries))
      .catch((err) => {
        console.warn('[RemotePanel] ssh_config list failed', err);
      });
  }, []);
  const refreshKnownHosts = useCallback(() => {
    window.api
      .invoke<unknown, KnownHostsRefreshResponse>(COMMAND_CHANNELS.KNOWN_HOSTS_REFRESH, {})
      .then(setKnownHosts)
      .catch((err) => {
        console.warn('[RemotePanel] known_hosts refresh failed', err);
      });
  }, []);

  useEffect(() => {
    refreshAgent();
    refreshKnownHosts();
  }, [refreshAgent, refreshKnownHosts]);
  useEffect(() => {
    if (includeSshConfig) refreshSshConfig();
    else setSshConfigEntries([]);
  }, [includeSshConfig, refreshSshConfig]);

  const resetSshForm = (): void => {
    setEditingProfileId(null);
    setSshName('');
    setSshHost('');
    setSshPort('22');
    setSshUser('');
    setSshAuthType('password');
    setSshKeyFile('');
    setSshPassword('');
    setSshSavePassword(false);
    setSshProxyJump('');
  };

  const handleEditSshProfile = (id: string): void => {
    const p = state.sshProfiles.find((x) => x.id === id);
    if (!p) return;
    setError(null);
    setEditingProfileId(id);
    setSshName(p.name);
    setSshHost(p.host);
    setSshPort(String(p.port));
    setSshUser(p.username);
    setSshAuthType(p.authType === 'keyFile' ? 'keyFile' : 'password');
    setSshKeyFile(p.keyFilePath ?? '');
    setSshPassword('');
    setSshSavePassword(false);
    setSshProxyJump((p.proxyJump ?? []).join(', '));
  };

  const parsedProxyJump = (): string[] =>
    sshProxyJump
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

  const handleSubmitSshProfile = async (): Promise<void> => {
    setError(null);
    try {
      const port = Number.parseInt(sshPort, 10);
      const proxyJump = parsedProxyJump();
      if (editingProfileId) {
        const partial: Record<string, unknown> = {
          name: sshName,
          host: sshHost,
          port,
          username: sshUser,
          authType: sshAuthType,
          defaultRemoteCwd: remotePath || '~',
          proxyJump,
        };
        if (sshAuthType === 'keyFile' && sshKeyFile.trim()) {
          partial.keyFilePath = sshKeyFile.trim();
        }
        if (sshAuthType === 'password') {
          if (sshSavePassword && sshPassword) {
            partial.password = sshPassword;
          } else if (sshSavePassword && !sshPassword) {
            partial.password = '';
          }
        }
        await window.api.invoke<unknown, UpdateSshProfileResponse>(
          COMMAND_CHANNELS.SSH_PROFILE_UPDATE,
          { id: editingProfileId, partial },
        );
        resetSshForm();
      } else {
        const res = await window.api.invoke<unknown, AddSshProfileResponse>(
          COMMAND_CHANNELS.SSH_PROFILE_ADD,
          {
            name: sshName,
            host: sshHost,
            port,
            username: sshUser,
            authType: sshAuthType,
            ...(sshAuthType === 'keyFile' && sshKeyFile.trim()
              ? { keyFilePath: sshKeyFile.trim() }
              : {}),
            ...(sshAuthType === 'password' && sshSavePassword && sshPassword
              ? { password: sshPassword }
              : {}),
            defaultRemoteCwd: remotePath || '~',
            proxyJump,
          },
        );
        setRemoteProfileId(res.profile.id);
        resetSshForm();
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handlePickSshKeyFile = async (): Promise<void> => {
    setError(null);
    try {
      const res = await window.api.invoke<unknown, PickSshKeyFileResponse>(
        COMMAND_CHANNELS.SSH_PROFILE_PICK_KEY_FILE,
        { ...(sshKeyFile.trim() ? { defaultPath: sshKeyFile.trim() } : {}) },
      );
      if (res.path) setSshKeyFile(res.path);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleDeleteSshProfile = async (id: string): Promise<void> => {
    setError(null);
    try {
      await window.api.invoke(COMMAND_CHANNELS.SSH_PROFILE_DELETE, { id });
      if (remoteProfileId === id) setRemoteProfileId('');
      if (editingProfileId === id) resetSshForm();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleAddRemoteBookmark = async (): Promise<void> => {
    setError(null);
    try {
      const profileId = remoteProfileId || state.sshProfiles[0]?.id;
      if (!profileId) {
        setError(tx('请先添加 SSH 服务器', 'Add an SSH server first'));
        return;
      }
      await window.api.invoke(COMMAND_CHANNELS.REMOTE_BOOKMARK_ADD, {
        sshProfileId: profileId,
        remotePath,
        ...(remoteName.trim() ? { displayName: remoteName.trim() } : {}),
      });
      setRemotePath('~');
      setRemoteName('');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <section className="settings-panel" data-testid="settings-remote-panel">
      <SettingRow
        label={tx('SSH 服务器', 'SSH servers')}
        hint={tx(
          '保存连接参数;勾选"保存密码"会用 OS 凭据加密保存,登录时需 sshpass 才能自动注入',
          'Saves connection parameters; "Save password" stores the password via OS keychain — auto-login requires sshpass on PATH',
        )}
      >
        <div className="ssh-profile-form">
          {state.sshProfiles.length > 0 && (
            <ul className="ssh-profile-list">
              {state.sshProfiles.map((p) => (
                <li key={p.id}>
                  <span className="settings-info-text">
                    {p.name} — {p.username}@{p.host}:{p.port}
                    {p.hasSavedPassword ? tx(' · 已保存密码', ' · password saved') : ''}
                    {editingProfileId === p.id ? tx(' · 编辑中', ' · editing') : ''}
                  </span>
                  <button
                    type="button"
                    className="settings-button ssh-profile-button"
                    onClick={() => handleEditSshProfile(p.id)}
                  >
                    {tx('编辑', 'Edit')}
                  </button>
                  <button
                    type="button"
                    className="settings-button danger ssh-profile-button"
                    onClick={() => void handleDeleteSshProfile(p.id)}
                  >
                    {tx('删除', 'Delete')}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="ssh-profile-grid">
            <input
              className="settings-input"
              value={sshName}
              onChange={(e) => setSshName(e.target.value)}
              placeholder={tx('名称', 'Name')}
            />
            <input
              className="settings-input"
              value={sshHost}
              onChange={(e) => setSshHost(e.target.value)}
              placeholder="host.example.com"
            />
            <input
              className="settings-input"
              value={sshUser}
              onChange={(e) => setSshUser(e.target.value)}
              placeholder={tx('用户名', 'Username')}
            />
            <input
              className="settings-input"
              type="number"
              value={sshPort}
              onChange={(e) => setSshPort(e.target.value)}
              placeholder="22"
            />
            <select
              className="settings-input"
              value={sshAuthType}
              onChange={(e) => setSshAuthType(e.target.value as 'keyFile' | 'password')}
            >
              <option value="password">{tx('密码', 'Password')}</option>
              <option value="keyFile">{tx('密钥文件', 'Key file')}</option>
            </select>
            <div className="ssh-key-picker">
              <input
                className="settings-input ssh-key-input"
                value={sshKeyFile}
                onChange={(e) => setSshKeyFile(e.target.value)}
                placeholder={tx('密钥路径', 'Key path')}
                disabled={sshAuthType !== 'keyFile'}
              />
              <button
                type="button"
                className="settings-button"
                disabled={sshAuthType !== 'keyFile'}
                onClick={() => void handlePickSshKeyFile()}
              >
                {tx('选择', 'Select')}
              </button>
            </div>
          </div>
          <div className="ssh-password-field">
            <input
              className="settings-input"
              value={sshProxyJump}
              onChange={(e) => setSshProxyJump(e.target.value)}
              placeholder={tx(
                'ProxyJump 跳板(可选,逗号分隔,如 bastion1, user@bastion2:2222)',
                'ProxyJump hops (optional, comma-separated, e.g. bastion1, user@bastion2:2222)',
              )}
            />
          </div>
          {sshAuthType === 'password' && (
            <div className="ssh-password-field">
              <input
                className="settings-input"
                type="password"
                value={sshPassword}
                onChange={(e) => setSshPassword(e.target.value)}
                placeholder={
                  editingProfileId
                    ? tx('新密码(留空则保留旧密码)', 'New password (leave blank to keep existing)')
                    : tx(
                        '密码(可选,留空则连接时手动输入)',
                        'Password (optional; leave blank to type at connect time)',
                      )
                }
                autoComplete="new-password"
              />
              <label className="settings-checkbox">
                <input
                  type="checkbox"
                  checked={sshSavePassword}
                  onChange={(e) => setSshSavePassword(e.target.checked)}
                />
                <span>
                  {editingProfileId
                    ? tx(
                        '应用密码修改(勾选 + 留空可清除已保存密码)',
                        'Apply password change (checked + empty clears saved password)',
                      )
                    : tx(
                        '保存密码(OS 加密;需 sshpass 才能自动登录)',
                        'Save password (OS-encrypted; needs sshpass on PATH for auto-login)',
                      )}
                </span>
              </label>
            </div>
          )}
          <div className="ssh-profile-actions">
            <button
              type="button"
              className="settings-button"
              onClick={() => void handleSubmitSshProfile()}
            >
              {editingProfileId ? tx('保存修改', 'Save changes') : tx('添加服务器', 'Add server')}
            </button>
            {editingProfileId && (
              <button type="button" className="settings-button" onClick={resetSshForm}>
                {tx('取消', 'Cancel')}
              </button>
            )}
          </div>
        </div>
      </SettingRow>

      <SettingRow
        label={tx('添加远程文件夹', 'Add remote folder')}
        hint={tx(
          '添加后会出现在左侧对应服务器分组;双击即通过 SSH 进入该远程目录',
          'Appears under the matching server group; double-click opens SSH in that remote directory',
        )}
      >
        <div className="remote-bookmark-form">
          <select
            className="settings-input"
            value={remoteProfileId || state.sshProfiles[0]?.id || ''}
            onChange={(e) => setRemoteProfileId(e.target.value)}
            disabled={state.sshProfiles.length === 0}
          >
            {state.sshProfiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <input
            className="settings-input"
            value={remotePath}
            onChange={(e) => setRemotePath(e.target.value)}
            placeholder="/home/user/project"
          />
          <input
            className="settings-input"
            value={remoteName}
            onChange={(e) => setRemoteName(e.target.value)}
            placeholder={tx('显示名(可选)', 'Display name (optional)')}
          />
          <button
            type="button"
            className="settings-button"
            onClick={() => void handleAddRemoteBookmark()}
          >
            {tx('添加文件夹', 'Add folder')}
          </button>
        </div>
      </SettingRow>

      <SettingRow
        label={tx('SSH-agent 状态', 'SSH agent status')}
        hint={tx(
          '查询当前 ssh-agent 是否运行 + 已加载的密钥。POSIX 通过 SSH_AUTH_SOCK / Windows 通过 OpenSSH Service。',
          'Probes ssh-agent (via SSH_AUTH_SOCK on POSIX, OpenSSH Service on Windows) and lists loaded keys.',
        )}
      >
        <div className="ssh-agent-card">
          {agentStatus === null ? (
            <span className="settings-info-text">{tx('正在探测…', 'Probing…')}</span>
          ) : agentStatus.status === 'agent-running' ? (
            <>
              <span className="ssh-agent-status-line ok">
                ✅ {tx('agent 正在运行', 'agent running')}
                {agentStatus.keys.length === 0
                  ? tx('(0 把密钥)', ' (0 keys)')
                  : tx(
                      `,已加载 ${agentStatus.keys.length} 把密钥`,
                      `, ${agentStatus.keys.length} key(s) loaded`,
                    )}
              </span>
              {agentStatus.keys.length > 0 && (
                <ul className="ssh-agent-key-list">
                  {agentStatus.keys.map((k) => (
                    <li key={k.fingerprint}>
                      <code>{k.fingerprint}</code> · {k.keyType} · {k.bits} bit
                      {k.comment && ` · ${k.comment}`}
                    </li>
                  ))}
                </ul>
              )}
            </>
          ) : (
            <span className="ssh-agent-status-line warn">⚠️ {agentStatus.message}</span>
          )}
          <button type="button" className="settings-button" onClick={refreshAgent}>
            {tx('刷新', 'Refresh')}
          </button>
        </div>
      </SettingRow>

      <SettingRow
        label={tx('集成 ~/.ssh/config', 'Integrate ~/.ssh/config')}
        hint={tx(
          '启用后,sidebar / 设置页同时显示 ssh_config 里的 Host 条目(只读;改请直接编辑 ~/.ssh/config)。Match 块当前跳过,V1 仅支持 Host + Include。',
          'When on, Host entries from ssh_config appear in the sidebar / settings (read-only — edit ~/.ssh/config directly). Match blocks are skipped in V1; Host + Include supported.',
        )}
      >
        <div className="ssh-agent-card">
          <label className="settings-checkbox">
            <input
              type="checkbox"
              checked={includeSshConfig}
              onChange={(e) =>
                void updateSettings({ advanced: { includeSshConfig: e.target.checked } }, setError)
              }
            />
            <span>
              {tx('合并 ~/.ssh/config 到 profile 列表', 'Merge ~/.ssh/config into profile list')}
            </span>
          </label>
          {includeSshConfig && (
            <>
              <span className="settings-info-text">
                {tx(
                  `发现 ${sshConfigEntries.length} 条 Host`,
                  `Discovered ${sshConfigEntries.length} Host entries`,
                )}
              </span>
              {sshConfigEntries.length > 0 && (
                <ul className="ssh-config-list">
                  {sshConfigEntries.slice(0, 20).map((e) => (
                    <li key={`${e.sourceFile}#${e.alias}`} title={e.sourceFile}>
                      <strong>{e.alias}</strong> → {e.user ? `${e.user}@` : ''}
                      {e.hostName}:{e.port}
                      {e.proxyJump.length > 0 && (
                        <span className="ssh-config-hint">
                          {' '}
                          · {tx('via', 'via')} {e.proxyJump.join(',')}
                        </span>
                      )}
                    </li>
                  ))}
                  {sshConfigEntries.length > 20 && (
                    <li className="ssh-config-hint">
                      {tx(
                        `… 还有 ${sshConfigEntries.length - 20} 条未显示`,
                        `… ${sshConfigEntries.length - 20} more not shown`,
                      )}
                    </li>
                  )}
                </ul>
              )}
              <button type="button" className="settings-button" onClick={refreshSshConfig}>
                {tx('重新加载 ssh_config', 'Reload ssh_config')}
              </button>
            </>
          )}
        </div>
      </SettingRow>

      <SettingRow
        label={tx('启用 ControlMaster 连接复用', 'Enable ControlMaster connection sharing')}
        hint={tx(
          '同一主机的多个 session 共享首次握手,从 ~3 秒降到 <100ms。Windows OpenSSH 8.x+ 走 named pipe;不稳定时 OpenSSH 自动回退到新连接。',
          'Reuse the first SSH handshake across sessions to the same host (~3s → <100ms). Windows OpenSSH 8.x+ uses a named pipe; falls back to a fresh connection if unavailable.',
        )}
      >
        <label className="settings-checkbox">
          <input
            type="checkbox"
            checked={enableControlMaster}
            onChange={(e) =>
              void updateSettings({ advanced: { enableControlMaster: e.target.checked } }, setError)
            }
          />
          <span>{tx('启用 ControlMaster(推荐)', 'Enable ControlMaster (recommended)')}</span>
        </label>
      </SettingRow>

      <SettingRow
        label={tx('已知主机指纹', 'Known host fingerprints')}
        hint={tx(
          '解析 ~/.ssh/known_hosts;同主机指纹变化时高亮(可能是 MITM 或服务器换 key)。Ceteris 记录指纹历史跨重启保留。',
          'Parses ~/.ssh/known_hosts; highlights host-key changes (potential MITM or server key rotation). Ceteris keeps fingerprint history across restarts.',
        )}
      >
        <div className="ssh-agent-card">
          {knownHosts === null ? (
            <span className="settings-info-text">{tx('正在加载…', 'Loading…')}</span>
          ) : (
            <>
              {knownHosts.changes.length > 0 && (
                <ul className="ssh-known-hosts-changes">
                  {knownHosts.changes.map((c) => (
                    <li key={`${c.host}:${c.newFingerprint}`}>
                      ⚠️ <strong>{c.host}</strong> {c.keyType}{' '}
                      {tx('指纹已变化', 'fingerprint changed')}:
                      <br />
                      &nbsp;&nbsp;{tx('原', 'was')}: <code>{c.previousFingerprint}</code>
                      <br />
                      &nbsp;&nbsp;{tx('现', 'now')}: <code>{c.newFingerprint}</code>
                    </li>
                  ))}
                </ul>
              )}
              <span className="settings-info-text">
                {tx(`共 ${knownHosts.entries.length} 条`, `${knownHosts.entries.length} entries`)}
              </span>
              {knownHosts.entries.length > 0 && (
                <ul className="ssh-known-hosts-list">
                  {knownHosts.entries.slice(0, 10).map((e) => (
                    <li key={`${e.hosts}#${e.fingerprint}`}>
                      <strong>{e.isHashed ? '(hashed)' : e.hosts}</strong> · {e.keyType} ·{' '}
                      <code>{e.fingerprint}</code>
                    </li>
                  ))}
                  {knownHosts.entries.length > 10 && (
                    <li className="ssh-config-hint">
                      {tx(
                        `… 还有 ${knownHosts.entries.length - 10} 条未显示`,
                        `… ${knownHosts.entries.length - 10} more not shown`,
                      )}
                    </li>
                  )}
                </ul>
              )}
              <button type="button" className="settings-button" onClick={refreshKnownHosts}>
                {tx('刷新', 'Refresh')}
              </button>
            </>
          )}
        </div>
      </SettingRow>
    </section>
  );
}

// ──────────────────────────────────────────────────────────────────
// 系统集成分类 — Explorer 右键 "在 Ceteris 终端中打开"
//
// 经典菜单(HKCU 注册表)和 Win11 新菜单(MSIX + 证书)各自独立卡片,
// 独立开关。状态来自现场查 HKCU / Get-AppxPackage(IPC),不进 settings.json。
// dev 全部置灰。便携版可用经典菜单和开机启动,Win11 新菜单需要安装版。
// ──────────────────────────────────────────────────────────────────

function SystemIntegrationPanel({
  setError,
}: {
  setError: (msg: string | null) => void;
}): JSX.Element {
  const { tx } = useTranslation();
  const state = useAppState();
  const sys = state.settings?.systemIntegration;
  const openIn = sys?.explorerOpenIn ?? 'new-window';
  const autoStart = state.settings.behavior?.autoStart ?? false;
  const toast = useToast();

  const [status, setStatus] = useState<ExplorerIntegrationStatus | null>(null);
  const [busy, setBusy] = useState<'classic' | 'modern' | null>(null);

  const refreshStatus = useCallback(async () => {
    try {
      const s = await window.api.invoke<undefined, ExplorerIntegrationStatus>(
        COMMAND_CHANNELS.EXPLORER_INTEGRATION_GET_STATUS,
        undefined,
      );
      setStatus(s);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [setError]);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  const handleSet = async (kind: 'classic' | 'modern', enabled: boolean): Promise<void> => {
    setError(null);
    setBusy(kind);
    try {
      const channel =
        kind === 'classic'
          ? COMMAND_CHANNELS.EXPLORER_INTEGRATION_SET_CLASSIC
          : COMMAND_CHANNELS.EXPLORER_INTEGRATION_SET_MODERN;
      const res = await window.api.invoke<{ enabled: boolean }, SetExplorerIntegrationResponse>(
        channel,
        { enabled },
      );
      setStatus(res.status);
      if (!res.ok) {
        setError(res.message || `操作失败 (${kind})`);
      } else if (kind === 'modern') {
        // BETA-044:Win11 新菜单 install/uninstall 后,MSIX 加载有 OS 级延迟
        // (不是 Ceteris bug)。提示用户重启电脑确保生效;不做"一键重启 Explorer"
        // 按钮(用户选了最保守的方案)。详见 docs/known-issues.md。
        toast.push({
          kind: 'info',
          message: tx(
            '右键菜单已更新,确保设置生效请重启计算机',
            'Context menu updated. Restart the computer to ensure the change takes effect.',
          ),
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="settings-panel">
      <h2 className="settings-panel-title">{tx('系统集成', 'System integration')}</h2>

      <SettingRow
        label={tx('开机启动', 'Launch on login')}
        hint={tx(
          '系统启动时自动启动 Ceteris',
          'Automatically start Ceteris when the system starts',
        )}
      >
        <label className="settings-checkbox">
          <input
            type="checkbox"
            checked={autoStart}
            onChange={(e) =>
              void updateSettings({ behavior: { autoStart: e.target.checked } }, setError)
            }
          />
          <span>{tx('开机启动', 'Launch on login')}</span>
        </label>
      </SettingRow>

      {/* —— Win11 新菜单卡片 —— */}
      <ExplorerIntegrationCard
        title={tx('Win11 新菜单', 'Win11 modern menu')}
        subtitle={tx(
          '圆角右键菜单,无需展开「显示更多选项」;走 IExplorerCommand,需 MSIX 包 + 证书',
          'Modern right-click menu; uses IExplorerCommand, requires MSIX package + cert',
        )}
        status={status?.modern}
        unsupportedReason={status?.modernUnsupportedReason ?? null}
        busy={busy === 'modern'}
        onToggle={(next) => void handleSet('modern', next)}
        detail={
          status?.modern === 'enabled' && status.package ? (
            <div className="explorer-integration-meta">
              <div>
                <strong>{tx('包:', 'Package:')}</strong> {status.package.name}{' '}
                {status.package.version}
              </div>
              <div className="text-muted" style={{ wordBreak: 'break-all' }}>
                {status.package.installLocation}
              </div>
            </div>
          ) : null
        }
        certInfo={status?.cert ?? null}
      />

      {/* —— 经典右键菜单卡片 —— */}
      <ExplorerIntegrationCard
        title={tx('经典右键菜单', 'Classic right-click menu')}
        subtitle={tx(
          'HKCU 注册表项,藏在「显示更多选项」内;Win10 / Win11 通用,无 UAC、无证书',
          'HKCU registry entries, under "Show more options"; works on Win10 / Win11, no UAC or cert needed',
        )}
        status={status?.classic}
        unsupportedReason={status?.classicUnsupportedReason ?? null}
        busy={busy === 'classic'}
        onToggle={(next) => void handleSet('classic', next)}
        detail={
          status?.buildType === 'portable' ? (
            <div className="explorer-integration-meta">
              {tx(
                '便携版没有卸载程序。删除这个程序之前,请先在这里关闭菜单。',
                'A portable build has no uninstaller. Turn this off here before deleting the app.',
              )}
            </div>
          ) : null
        }
        certInfo={null}
      />

      {/* —— 打开方式(纯偏好,保留在 settings.json) —— */}
      <SettingRow
        label={tx('打开方式', 'Open in')}
        hint={tx(
          'Ceteris 已在运行时,从 Explorer 触发的新会话开在哪里',
          'When Ceteris is already running, where new sessions from the file manager appear',
        )}
      >
        <div className="settings-radio-group">
          <label className="settings-radio">
            <input
              type="radio"
              name="explorer-open-in"
              value="new-window"
              checked={openIn === 'new-window'}
              onChange={() =>
                void updateSettings(
                  { systemIntegration: { explorerOpenIn: 'new-window' } },
                  setError,
                )
              }
            />
            {tx('新窗口打开', 'New window')}
          </label>
          <label className="settings-radio">
            <input
              type="radio"
              name="explorer-open-in"
              value="recent-window-tab"
              checked={openIn === 'recent-window-tab'}
              onChange={() =>
                void updateSettings(
                  {
                    systemIntegration: { explorerOpenIn: 'recent-window-tab' },
                  },
                  setError,
                )
              }
            />
            {tx('在最近活动的窗口新开标签', 'New tab in the most recently active window')}
          </label>
        </div>
      </SettingRow>
    </section>
  );
}

interface ExplorerIntegrationCardProps {
  title: string;
  subtitle: string;
  status: ExplorerIntegrationStatus['classic'] | undefined;
  unsupportedReason: string | null;
  busy: boolean;
  onToggle: (enabled: boolean) => void;
  detail: ReactNode;
  certInfo: ExplorerIntegrationStatus['cert'];
}

function ExplorerIntegrationCard({
  title,
  subtitle,
  status,
  unsupportedReason,
  busy,
  onToggle,
  detail,
  certInfo,
}: ExplorerIntegrationCardProps): JSX.Element {
  const { tx } = useTranslation();
  const isUnsupported = status === 'unsupported';
  const isEnabled = status === 'enabled';
  const disabled = isUnsupported || busy || status === undefined;

  const statusLabel = (() => {
    if (status === undefined) return tx('查询中…', 'Querying…');
    if (status === 'unsupported') return tx('不可用', 'Unavailable');
    if (status === 'enabled') return tx('已启用', 'Enabled');
    return tx('未启用', 'Disabled');
  })();

  return (
    <div className="explorer-integration-card">
      <div className="explorer-integration-header">
        <div>
          <div className="explorer-integration-title">{title}</div>
          <div className="explorer-integration-subtitle">{subtitle}</div>
        </div>
        <label className="settings-checkbox">
          <input
            type="checkbox"
            checked={isEnabled}
            disabled={disabled}
            onChange={(e) => onToggle(e.target.checked)}
          />
          <span>{busy ? tx('处理中…', 'Working…') : statusLabel}</span>
        </label>
      </div>

      {isUnsupported && unsupportedReason && (
        <div className="explorer-integration-unsupported">{unsupportedReason}</div>
      )}

      {detail}

      {certInfo && (
        <div className="explorer-integration-meta">
          <div>
            <strong>{tx('证书:', 'Cert:')}</strong> {certInfo.subject}
          </div>
          <div className="text-muted">
            {tx('指纹', 'Fingerprint')} {certInfo.thumbprint.slice(0, 8)}…
            {certInfo.thumbprint.slice(-4)} · {tx('至', 'until')}{' '}
            {new Date(certInfo.notAfter).toISOString().slice(0, 10)} · {tx('已信任', 'trusted')}
          </div>
        </div>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────
// AI 助手分类(BETA-031)
// ──────────────────────────────────────────────────────────────────

function AiPanel({ setError }: { setError: (msg: string | null) => void }): JSX.Element {
  const { tx } = useTranslation();
  const state = useAppState();
  const toast = useToast();
  const ai = state.settings.ai;
  const nextPrompt = ai?.nextPrompt ?? { enabled: false, keySaved: false, baseURL: '', model: '' };
  const nextPromptReady = nextPromptConfigured(nextPrompt);
  const [testingNextPrompt, setTestingNextPrompt] = useState(false);
  const [usage, setUsage] = useState<NextPromptUsage | null>(null);
  const refreshUsage = useCallback(() => {
    window.api
      .invoke<undefined, NextPromptUsage>(COMMAND_CHANNELS.AI_GET_NEXT_PROMPT_USAGE, undefined)
      .then(setUsage)
      .catch((err) => console.error('[Settings] read usage failed', err));
  }, []);
  useEffect(refreshUsage, [refreshUsage]);
  const [habits, setHabits] = useState<FrequentPrompt[] | null>(null);
  useEffect(() => {
    window.api
      .invoke<undefined, GetFrequentPromptsResponse>(
        COMMAND_CHANNELS.AI_GET_FREQUENT_PROMPTS,
        undefined,
      )
      .then((res) => setHabits(res.prompts))
      .catch((err) => console.error('[Settings] read frequent prompts failed', err));
  }, []);

  const handleTestNextPrompt = async (): Promise<void> => {
    setTestingNextPrompt(true);
    const started = performance.now();
    try {
      const res = await window.api.invoke<SuggestNextPromptPayload, SuggestNextPromptResponse>(
        COMMAND_CHANNELS.AI_SUGGEST_NEXT_PROMPT,
        { screen: 'All tests pass, but I have not committed the change yet.\n> \n? for shortcuts' },
      );
      const ms = Math.round(performance.now() - started);
      toast.push({
        kind: 'success',
        message: `${ms}ms: ${res.suggestion ?? tx('模型没有给出建议', 'no suggestion')}`,
      });
    } catch (err) {
      toast.push({
        kind: 'error',
        message: tx(
          `测试失败:${err instanceof Error ? err.message : String(err)}`,
          `Test failed: ${err instanceof Error ? err.message : String(err)}`,
        ),
      });
    } finally {
      setTestingNextPrompt(false);
      refreshUsage();
    }
  };

  return (
    <section className="settings-panel">
      <h2 className="settings-panel-title">{tx('AI 助手', 'AI Assistant')}</h2>
      <p className="settings-panel-hint">
        {tx(
          'Agent 停下时猜你的下一句,点击只填入不发送。屏幕末尾的文字和下面的常用消息会发给该 API。',
          'When an agent stops, guesses your next prompt. Clicking fills it in without sending. The end of the screen and the frequent messages below go to this API.',
        )}
      </p>

      <SettingRow
        label={tx('OpenRouter 账号', 'OpenRouter account')}
        hint={
          nextPrompt.keySaved
            ? tx(
                'key 已加密保存在本机,只发给 OpenRouter。断开只删除本机这份;要作废它,到 openrouter.ai 的 Keys 页删除 "Ceteris next prompt"',
                'The key is encrypted on this PC and sent only to OpenRouter. Disconnecting deletes this copy; to revoke it, delete "Ceteris next prompt" on the Keys page at openrouter.ai',
              )
            : tx(
                '在浏览器里登录 OpenRouter 并同意,Ceteris 会自动拿到一个专用 key 并加密保存,不用复制粘贴',
                'Sign in to OpenRouter in your browser and approve. Ceteris receives its own key and stores it encrypted; nothing to copy or paste',
              )
        }
      >
        <OpenRouterAccount
          connected={nextPrompt.keySaved}
          onError={(msg) => toast.push({ kind: 'error', message: msg })}
          onConnected={() =>
            toast.push({
              kind: 'success',
              message: tx('已连接 OpenRouter', 'Connected to OpenRouter'),
            })
          }
        />
      </SettingRow>

      <SettingRow label={tx('启用建议', 'Enable suggestions')}>
        <label className="settings-checkbox">
          <input
            type="checkbox"
            checked={nextPrompt.enabled}
            onChange={(e) =>
              void updateSettings({ ai: { nextPrompt: { enabled: e.target.checked } } }, setError)
            }
            disabled={!nextPromptReady}
          />
          <span>{tx('启用', 'Enable')}</span>
        </label>
      </SettingRow>

      <SettingRow
        label={tx('API 地址', 'API address')}
        hint={tx(
          '留空使用 OpenRouter。也可填本地模型服务(如 Ollama 的 http://127.0.0.1:11434/v1),这时不需要账号,OpenRouter key 也不会发给它',
          'Leave empty for OpenRouter. Or a local model server, such as Ollama at http://127.0.0.1:11434/v1; it needs no account and never receives the OpenRouter key',
        )}
      >
        <input
          className="settings-input"
          type="text"
          spellCheck={false}
          placeholder={NEXT_PROMPT_DEFAULT_BASE_URL}
          value={nextPrompt.baseURL ?? ''}
          onChange={(e) =>
            void updateSettings({ ai: { nextPrompt: { baseURL: e.target.value } } }, setError)
          }
        />
      </SettingRow>

      <SettingRow
        label={tx('模型', 'Model')}
        hint={tx(
          '列表来自上面的 API 地址。小模型够用:每次只猜一句话,停下就猜一次',
          'Listed from the API address above. A small model is enough: each guess is one line, made at every stop',
        )}
      >
        <NextPromptModelPicker
          model={nextPrompt.model}
          baseURL={nextPrompt.baseURL ?? ''}
          keySaved={nextPrompt.keySaved}
          onChange={(value) =>
            void updateSettings({ ai: { nextPrompt: { model: value } } }, setError)
          }
        />
      </SettingRow>

      <SettingRow
        label={tx('你的常用消息', 'Your frequent messages')}
        hint={tx(
          '从 Claude Code 和 Codex 的历史记录里找出发过 3 次以上的短消息,随每次猜测一起发送,模型合适时会原样建议',
          'Short messages you sent to Claude Code or Codex 3 or more times, read from their history. Sent with each guess so the model can offer them word for word',
        )}
      >
        {habits === null ? (
          <span className="settings-usage">…</span>
        ) : habits.length === 0 ? (
          <span className="settings-usage">{tx('还没有', 'None yet')}</span>
        ) : (
          <ol className="next-prompt-habits">
            {[...habits]
              .sort((a, b) => b.count - a.count)
              .map((h) => (
                <li key={h.text}>
                  <span className="next-prompt-habit-count">{h.count}×</span>
                  <span>{h.text}</span>
                </li>
              ))}
          </ol>
        )}
      </SettingRow>

      <SettingRow label={tx('测试', 'Test')}>
        <button
          type="button"
          className="settings-button"
          disabled={testingNextPrompt || !nextPromptReady}
          onClick={() => void handleTestNextPrompt()}
        >
          {testingNextPrompt ? tx('测试中…', 'Testing…') : tx('发送一次测试', 'Send a test')}
        </button>
      </SettingRow>

      <SettingRow
        label={tx('累计花费', 'Total cost')}
        hint={
          usage?.unpricedCalls
            ? tx(
                `其中 ${usage.unpricedCalls} 次服务商未返回价格,没有计入金额`,
                `${usage.unpricedCalls} calls had no price from the provider and are not in the total`,
              )
            : tx('从开启这项统计起计算', 'Counted from when this was added')
        }
      >
        <span className="settings-usage">
          {usage
            ? `${formatUsd(usage.costUsd)} · ${usage.calls} ${tx('次', 'calls')} · ${(
                usage.inputTokens + usage.outputTokens
              ).toLocaleString()} tokens`
            : '…'}
        </span>
        <button
          type="button"
          className="settings-button"
          disabled={!usage?.calls}
          onClick={() => {
            window.api
              .invoke(COMMAND_CHANNELS.AI_RESET_NEXT_PROMPT_USAGE, undefined)
              .then(refreshUsage)
              .catch((err: unknown) => setError(String(err)));
          }}
        >
          {tx('清零', 'Reset')}
        </button>
      </SettingRow>

      {usage && usage.calls > 0 && (
        <SettingRow
          label={tx('每日花费', 'Daily cost')}
          hint={tx('把鼠标移到某一天上看当天的金额和次数', 'Hover a day to see its cost and calls')}
        >
          <NextPromptCostChart usage={usage} />
        </SettingRow>
      )}

      <AgentTitleSettings ready={nextPromptReady} setError={setError} />
    </section>
  );
}

/**
 * ADR-029:标签标题。agent 自己的标题总是按长度缩短;开启后,每跑完一轮由上面
 * 同一个 API 和模型按用户的规则写标题。花费计入上面的累计花费。
 */
function AgentTitleSettings({
  ready,
  setError,
}: {
  ready: boolean;
  setError: (msg: string | null) => void;
}): JSX.Element {
  const { tx } = useTranslation();
  const state = useAppState();
  const titles = state.settings.ai?.tabTitles ?? {
    enabled: false,
    guide: '',
    maxChars: AGENT_TITLE_DEFAULT_MAX_CHARS,
  };
  return (
    <>
      <h3 className="link-subsection-title">{tx('标签标题', 'Tab titles')}</h3>
      <p className="settings-panel-hint">
        {tx(
          'agent 标签(Claude Code、Codex、OpenCode、Gemini、Copilot、Cursor、Aider)的名字。agent 自己设的标题总会去掉转圈符号并截到下面的长度。开启 AI 标题后,每跑完一轮,上面的 API 读屏幕末尾,按你的规则写一个标题;任务没变时保留原标题。手动改过名的标签不受影响。',
          'Names for agent tabs (Claude Code, Codex, OpenCode, Gemini, Copilot, Cursor, Aider). The title an agent sets itself always loses its spinner and is cut to the length below. With AI titles on, the API above reads the end of the screen after each finished turn and writes a title by your rules, keeping the old one while the task is the same. Tabs you renamed yourself are left alone.',
        )}
      </p>

      <SettingRow label={tx('AI 标题', 'AI titles')}>
        <label className="settings-checkbox">
          <input
            type="checkbox"
            checked={titles.enabled}
            onChange={(e) =>
              void updateSettings({ ai: { tabTitles: { enabled: e.target.checked } } }, setError)
            }
            disabled={!ready && !titles.enabled}
          />
          <span>{tx('启用', 'Enable')}</span>
        </label>
      </SettingRow>

      <SettingRow
        label={tx('最长字数', 'Longest title')}
        hint={tx(
          `${AGENT_TITLE_MIN_MAX_CHARS} 到 ${AGENT_TITLE_MAX_MAX_CHARS} 个字符,更长的在词边界截断并加 …`,
          `${AGENT_TITLE_MIN_MAX_CHARS} to ${AGENT_TITLE_MAX_MAX_CHARS} characters; longer titles are cut at a word and end with …`,
        )}
      >
        <input
          className="settings-input"
          type="number"
          min={AGENT_TITLE_MIN_MAX_CHARS}
          max={AGENT_TITLE_MAX_MAX_CHARS}
          step={1}
          value={titles.maxChars}
          style={{ width: 80 }}
          onChange={(e) => {
            const n = Number(e.target.value);
            if (!Number.isInteger(n)) return;
            if (n < AGENT_TITLE_MIN_MAX_CHARS || n > AGENT_TITLE_MAX_MAX_CHARS) return;
            void updateSettings({ ai: { tabTitles: { maxChars: n } } }, setError);
          }}
        />
      </SettingRow>

      <SettingRow
        label={tx('标题规则', 'Title rules')}
        hint={tx(
          '发给模型的说明,写你想要的标题样子。留空使用灰色的默认规则',
          'Instructions sent to the model: describe the titles you want. Leave empty for the default shown in grey',
        )}
      >
        <textarea
          className="settings-input"
          rows={4}
          maxLength={AGENT_TITLE_MAX_GUIDE_CHARS}
          spellCheck={false}
          placeholder={AGENT_TITLE_DEFAULT_GUIDE}
          value={titles.guide}
          style={{ minWidth: 320, resize: 'vertical' }}
          onChange={(e) =>
            void updateSettings({ ai: { tabTitles: { guide: e.target.value } } }, setError)
          }
          disabled={!titles.enabled}
        />
      </SettingRow>
    </>
  );
}

// ──────────────────────────────────────────────────────────────────
// 扩展分类 (ADR-019):可选功能,默认关,只影响打开之后新建的终端
// ──────────────────────────────────────────────────────────────────

function ExtensionsPanel({ setError }: { setError: (msg: string | null) => void }): JSX.Element {
  const { tx } = useTranslation();
  const state = useAppState();
  const enabled = state.settings.extensions?.claudeMathImages ?? false;
  const tabControl = state.settings.extensions?.tabControl ?? false;
  const terminalMath = state.settings.extensions?.terminalMath ?? false;
  const typer = useTypeIntoNewTerminal();
  const preparing = typer.preparing;
  // 随 Ceteris 安装的插件 marketplace 目录 (安装版 resources/extensions,dev 为仓库目录)
  const [marketplaceDir, setMarketplaceDir] = useState<string | null>(null);

  // The ceteris-tabs install row is always shown (ADR-033: open_file needs no switch), so the
  // directory is fetched as soon as the panel opens.
  useEffect(() => {
    if (marketplaceDir) return;
    window.api
      .invoke<unknown, { dir: string }>(COMMAND_CHANNELS.EXTENSIONS_GET_MARKETPLACE_DIR, {})
      .then((res) => setMarketplaceDir(res.dir))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, [marketplaceDir, setError]);

  /** 开一个新终端,把命令敲进去但不按 Enter (见 type-into-terminal.ts) */
  const typeIntoNewTerminal = async (buildLine: (shellId: string) => string): Promise<void> => {
    setError(null);
    await typer.run(buildLine, setError);
  };

  const handlePrepareInstall = (): void => {
    const dir = marketplaceDir;
    if (dir) void typeIntoNewTerminal((shellId) => latexMathInstallLine(shellId, dir));
  };

  const handlePrepareTabControl = (): void => {
    const dir = marketplaceDir;
    if (dir) void typeIntoNewTerminal((shellId) => tabControlInstallLine(shellId, dir));
  };

  return (
    <section className="settings-panel">
      <h2 className="settings-panel-title">{tx('扩展', 'Extensions')}</h2>

      <SettingRow
        label={tx('Claude Code 公式图片', 'Claude Code formula images')}
        hint={tx(
          '在 Claude Code 的回复里把 LaTeX 公式排成图片。打开后:终端支持 iTerm2 内联图片并自报 iTerm2 3.5;Windows 上新终端改用自带的 ConPTY。只影响打开之后新建的终端。',
          'Typesets the LaTeX math in Claude Code replies as images. When on, terminals accept iTerm2 inline images and identify as iTerm2 3.5, and new terminals on Windows use the bundled ConPTY. Applies to terminals opened afterwards.',
        )}
      >
        <label className="settings-checkbox">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) =>
              void updateSettings({ extensions: { claudeMathImages: e.target.checked } }, setError)
            }
          />
          <span>{tx('启用', 'Enable')}</span>
        </label>
      </SettingRow>

      {enabled && (
        <SettingRow
          label={tx('还需要的插件', 'Plugin you also need')}
          hint={tx(
            '公式由 Claude Code 的 latex-math 插件排版(需要 TeX Live、ImageMagick 和 Git Bash)。插件随 Ceteris 一起安装,在终端里跑一次下面两条命令把它加进 Claude Code,然后新开一个 Claude Code。若装过原版 latex-math@claude-latex-math,请先停用它。',
            'The latex-math Claude Code plugin typesets the formulas (it needs TeX Live, ImageMagick and Git Bash). The plugin ships with Ceteris. Run these two commands once in a terminal to add it to Claude Code, then start a new Claude Code session. If you installed the original latex-math@claude-latex-math, disable it first.',
          )}
        >
          <div className="settings-code-stack">
            <pre className="settings-code-block">
              <code>{marketplaceDir ? latexMathInstallLines(marketplaceDir) : '…'}</code>
            </pre>
            <button
              type="button"
              className="settings-button"
              disabled={preparing || !marketplaceDir}
              onClick={handlePrepareInstall}
              title={tx(
                '打开一个新终端并输入这两条命令,不会自动执行',
                'Opens a new terminal with both commands typed in; nothing runs until you press Enter',
              )}
            >
              {tx('在新终端里输入命令', 'Type them in a new terminal')}
            </button>
          </div>
        </SettingRow>
      )}

      <SettingRow
        label={tx('Codex 公式渲染', 'Codex formula rendering')}
        hint={tx(
          'Codex 没有插件接口,会把公式转成 Unicode 文字。打开后,Ceteris 把终端里以文本出现的 $$…$$、\\(…\\) 和 \\[…\\] 用 KaTeX 画在原处(任何程序的输出都算)。立即对已打开的终端生效。',
          'Codex has no plugin interface and turns formulas into Unicode text. When on, Ceteris draws the $$…$$, \\(…\\) and \\[…\\] it finds as text in a terminal with KaTeX, in place (in any program’s output). Applies to open terminals right away.',
        )}
      >
        <label className="settings-checkbox">
          <input
            type="checkbox"
            checked={terminalMath}
            onChange={(e) =>
              void updateSettings({ extensions: { terminalMath: e.target.checked } }, setError)
            }
          />
          <span>{tx('启用', 'Enable')}</span>
        </label>
      </SettingRow>

      {terminalMath && (
        <SettingRow
          label={tx('告诉 Codex 怎么写公式', 'Tell Codex how to write formulas')}
          hint={tx(
            'Codex 只在行内代码里保留 LaTeX 原文。把下面这条指示加进 ~/.codex/AGENTS.md(Codex 的全局指示,只加一次),之后新开的 Codex 会话就会这样写公式。',
            'Codex keeps LaTeX as written only inside inline code. Add this instruction to ~/.codex/AGENTS.md (Codex’s global instructions; added once), and new Codex sessions will write formulas this way.',
          )}
        >
          <div className="settings-code-stack">
            <pre className="settings-code-block settings-code-wrap">
              <code>{CODEX_MATH_INSTRUCTION}</code>
            </pre>
            <button
              type="button"
              className="settings-button"
              disabled={preparing}
              onClick={() => void typeIntoNewTerminal(codexMathInstructionCommand)}
              title={tx(
                '打开一个新终端并输入添加这条指示的命令,不会自动执行',
                'Opens a new terminal with the command that adds this instruction; nothing runs until you press Enter',
              )}
            >
              {tx('在新终端里输入命令', 'Type it in a new terminal')}
            </button>
          </div>
        </SettingRow>
      )}

      <SettingRow
        label={tx('Claude Code 的 ceteris-tabs 插件', 'The ceteris-tabs plugin for Claude Code')}
        hint={tx(
          '随 Ceteris 安装的插件。装上后,任何标签里的 Claude Code 都能把它写的文件(md、txt、json、tex、pdf、图片)摆在自己标签旁边:对它说"把回答写成 md 在 Ceteris 里打开"就行,不用开下面的开关。在终端里跑一次这两条命令,然后新开 Claude Code。',
          'Ships with Ceteris. Once installed, Claude Code in any tab can show a file it wrote (md, txt, json, tex, pdf, image) beside its own tab: say "write the answer as md and open it in Ceteris". No switch below needed for that. Run these two commands once in a terminal, then start a new Claude Code.',
        )}
      >
        <div className="settings-code-stack">
          <pre className="settings-code-block">
            <code>{marketplaceDir ? tabControlInstallLines(marketplaceDir) : '…'}</code>
          </pre>
          <button
            type="button"
            className="settings-button"
            disabled={preparing || !marketplaceDir}
            onClick={handlePrepareTabControl}
            title={tx(
              '打开一个新终端并输入这两条命令,不会自动执行',
              'Opens a new terminal with both commands typed in; nothing runs until you press Enter',
            )}
          >
            {tx('在新终端里输入命令', 'Type them in a new terminal')}
          </button>
        </div>
      </SettingRow>

      <SettingRow
        label={tx('旧版装过插件?', 'Installed it from an older Ceteris?')}
        hint={tx(
          'Claude Code 保存着自己那份插件副本,Ceteris 更新了插件它也不会跟着变。更新 Ceteris 后跑一次这条命令,再新开 Claude Code。',
          'Claude Code keeps its own copy of the plugin, so a Ceteris update does not change it. After updating Ceteris, run this once, then start a new Claude Code.',
        )}
      >
        <div className="settings-code-stack">
          <pre className="settings-code-block">
            <code>{TAB_CONTROL_UPDATE_COMMAND}</code>
          </pre>
          <button
            type="button"
            className="settings-button"
            disabled={preparing}
            onClick={() => void typeIntoNewTerminal(() => TAB_CONTROL_UPDATE_COMMAND)}
            title={tx(
              '打开一个新终端并输入这条命令,不会自动执行',
              'Opens a new terminal with the command typed in; nothing runs until you press Enter',
            )}
          >
            {tx('在新终端里输入命令', 'Type it in a new terminal')}
          </button>
        </div>
      </SettingRow>

      <SettingRow
        label={tx('协调者控制标签页', 'Coordinator tab control')}
        hint={tx(
          '让标记为协调者的标签里的 Claude Code 管理同一文件夹的其他标签:列出、新开、关闭、改名、输入、读取屏幕、等待完成。只有协调者标签可以用,其他标签一律拒绝。打开或关闭立即生效。需要上面的插件;右键标签,勾选"协调者"。',
          'Lets Claude Code in a tab marked as coordinator manage the other tabs of its folder: list, open, close, rename, type into, read the screen, and wait for them to finish. Only coordinator tabs may use it; every other tab is refused. Takes effect at once. Needs the plugin above; right-click a tab and tick Coordinator.',
        )}
      >
        <label className="settings-checkbox">
          <input
            type="checkbox"
            checked={tabControl}
            onChange={(e) =>
              void updateSettings({ extensions: { tabControl: e.target.checked } }, setError)
            }
          />
          <span>{tx('启用', 'Enable')}</span>
        </label>
      </SettingRow>
    </section>
  );
}

// ──────────────────────────────────────────────────────────────────
// 高级分类
// ──────────────────────────────────────────────────────────────────

function AdvancedPanel({ setError }: { setError: (msg: string | null) => void }): JSX.Element {
  const { tx } = useTranslation();
  const state = useAppState();
  const adv = state.settings.advanced;
  const logLevel = adv?.logLevel ?? 'INFO';
  const terminalRenderer = adv?.terminalRenderer ?? 'auto';

  const [confirmingReset, setConfirmingReset] = useState(false);

  const handleOpenLogs = (): void => {
    setError(null);
    window.api.invoke(COMMAND_CHANNELS.SYSTEM_OPEN_LOGS_DIR, {}).catch((err: unknown) => {
      setError(err instanceof Error ? err.message : String(err));
    });
  };

  const handleReset = (): void => {
    setError(null);
    window.api
      .invoke(COMMAND_CHANNELS.SETTINGS_RESET, {})
      .then(() => {
        setConfirmingReset(false);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
      });
  };

  return (
    <section className="settings-panel">
      <h2 className="settings-panel-title">{tx('高级', 'Advanced')}</h2>

      <SettingRow
        label={tx('日志级别', 'Log level')}
        hint={tx(
          'DEBUG 会记录所有 IPC 与 PTY 字节(性能影响)',
          'DEBUG logs all IPC and PTY bytes (performance impact)',
        )}
      >
        <div className="settings-radio-group">
          <label className="settings-radio">
            <input
              type="radio"
              name="loglevel"
              value="INFO"
              checked={logLevel === 'INFO'}
              onChange={() => void updateSettings({ advanced: { logLevel: 'INFO' } }, setError)}
            />
            INFO
          </label>
          <label className="settings-radio">
            <input
              type="radio"
              name="loglevel"
              value="DEBUG"
              checked={logLevel === 'DEBUG'}
              onChange={() => void updateSettings({ advanced: { logLevel: 'DEBUG' } }, setError)}
            />
            DEBUG
          </label>
        </div>
      </SettingRow>

      <SettingRow
        label={tx('日志目录', 'Log directory')}
        hint={tx('用户数据目录下的 logs/ 子目录', 'logs/ under the user data directory')}
      >
        <button type="button" className="settings-button" onClick={handleOpenLogs}>
          {tx('打开日志目录', 'Open log directory')}
        </button>
      </SettingRow>

      <SettingRow
        label={tx('终端渲染器', 'Terminal renderer')}
        hint={tx(
          'auto=平台默认(Win/macOS WebGL,Linux DOM);dom=强制软渲(性能差但稳,某些 TUI 光标在 WebGL 下异常时用)。变更对已打开的 tab 不生效,需关 tab 重开。',
          'auto = platform default (Win/macOS WebGL, Linux DOM); dom = force DOM (slower but compatible — useful when some TUIs render cursors incorrectly under WebGL). Takes effect on next opened tab.',
        )}
      >
        <select
          className="settings-input"
          value={terminalRenderer}
          onChange={(e) =>
            void updateSettings(
              {
                advanced: {
                  terminalRenderer: e.target.value as 'auto' | 'webgl' | 'dom',
                },
              },
              setError,
            )
          }
        >
          <option value="auto">{tx('auto (平台默认)', 'auto (platform default)')}</option>
          <option value="webgl">{tx('webgl (强制)', 'webgl (force)')}</option>
          <option value="dom">{tx('dom (强制软渲)', 'dom (force DOM)')}</option>
        </select>
      </SettingRow>

      <SettingRow
        label={tx('重置所有设置', 'Reset all settings')}
        hint={tx(
          '把所有设置回到出厂默认。文件夹 / 模板不受影响',
          'Reset all settings to factory default. Folders / templates are unaffected.',
        )}
      >
        {!confirmingReset ? (
          <button
            type="button"
            className="settings-button danger"
            onClick={() => setConfirmingReset(true)}
          >
            {tx('重置…', 'Reset…')}
          </button>
        ) : (
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <span style={{ color: 'var(--color-danger, #f0f)', fontSize: 12 }}>
              {tx('确认重置?', 'Confirm reset?')}
            </span>
            <button type="button" className="settings-button danger" onClick={handleReset}>
              {tx('确认', 'Confirm')}
            </button>
            <button
              type="button"
              className="settings-button"
              onClick={() => setConfirmingReset(false)}
            >
              {tx('取消', 'Cancel')}
            </button>
          </div>
        )}
      </SettingRow>
    </section>
  );
}

// ──────────────────────────────────────────────────────────────────
// 关于分类
// ──────────────────────────────────────────────────────────────────

const GITHUB_REPO = 'https://github.com/Fanisting/ceteris';
const GITHUB_RELEASES = `${GITHUB_REPO}/releases`;

const ACKNOWLEDGEMENTS: Array<{ name: string; url: string; tone: string }> = [
  { name: 'Electron', url: 'https://www.electronjs.org/', tone: '应用框架 (MIT)' },
  { name: 'React', url: 'https://react.dev/', tone: 'UI 库 (MIT)' },
  { name: 'electron-vite + Vite', url: 'https://electron-vite.org/', tone: '构建工具 (MIT)' },
  { name: 'xterm.js', url: 'https://xtermjs.org/', tone: '终端模拟器 (MIT)' },
  { name: 'node-pty', url: 'https://github.com/microsoft/node-pty', tone: 'PTY 绑定 (MIT)' },
  { name: 'Material Symbols', url: 'https://fonts.google.com/icons', tone: 'UI 图标 (Apache 2.0)' },
  { name: 'Rose Pine theme', url: 'https://rosepinetheme.com/', tone: '默认主题灵感 (MIT)' },
  {
    name: '霞鹜文楷 (LXGW WenKai)',
    url: 'https://github.com/lxgw/LxgwWenKai',
    tone: '中文字体 (OFL)',
  },
];

/**
 * 关于页"检查更新"一行的说明文字(ADR-018)。按状态给出最有用的一句,
 * 例如"已是最新(v0.3.0)",或失败时的原因,方便用户判断要不要手动去下载。
 */
function describeUpdateStatus(
  status: UpdateStatus | null,
  tx: (zh: string, en: string) => string,
): string {
  if (!status) return tx('读取中…', 'Loading…');
  const checked = status.checkedAt
    ? tx('上次检查 ', 'Last checked ') + new Date(status.checkedAt).toLocaleString()
    : tx('还没检查过', 'Not checked yet');
  switch (status.state) {
    case 'checking':
      return tx('正在检查 GitHub…', 'Checking GitHub…');
    case 'available':
      return status.update
        ? tx(
            `有新版本 v${status.update.version}(当前 v${status.currentVersion})。下载的是适合本机系统的安装包:${status.update.assetName ?? '发布页'}`,
            `v${status.update.version} is available (you have v${status.currentVersion}). Download gets the file for this computer: ${status.update.assetName ?? 'release page'}`,
          )
        : checked;
    case 'up-to-date':
      return (
        tx(`已是最新(v${status.currentVersion})。`, `Up to date (v${status.currentVersion}). `) +
        checked
      );
    case 'error': {
      const reason =
        status.error === 'rate-limited'
          ? tx('GitHub 访问次数超限,稍后会自动重试', 'GitHub rate limit reached; it retries later')
          : status.error === 'network'
            ? tx(
                '连不上 GitHub,检查网络或代理',
                'Could not reach GitHub; check the network or proxy',
              )
            : tx('GitHub 返回的内容无法识别', 'Unexpected answer from GitHub');
      return `${reason}。${checked}`;
    }
    default:
      return checked;
  }
}

function AboutPanel({ setError }: { setError: (msg: string | null) => void }): JSX.Element {
  const { tx } = useTranslation();
  const settings = useAppState().settings;
  const autoCheckUpdates = settings.behavior?.autoCheckUpdates ?? true;
  const { status: updateStatus, checkNow, openLink } = useUpdateStatus();
  const update = updateStatus?.state === 'available' ? updateStatus.update : null;
  // build define 在 dev 模式可能未定义,做个兜底
  // (vite 实际上 dev 时也会做 string 替换,但为了万无一失)
  const commit = typeof __CETERIS_BUILD_COMMIT__ !== 'undefined' ? __CETERIS_BUILD_COMMIT__ : 'dev';
  const builtAt = typeof __CETERIS_BUILD_TIME__ !== 'undefined' ? __CETERIS_BUILD_TIME__ : 'dev';

  // app 版本号通过 handshake 已经拿到,从 store 读不太合适 (store 里没存)
  // 走一次 getProtocolVersion 就够,这里 inline state
  const [appVersion, setAppVersion] = useState<string>('—');
  useEffect(() => {
    let cancelled = false;
    window.api
      .getProtocolVersion()
      .then((res) => {
        if (!cancelled) setAppVersion(res.buildVersion);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const openExternal = (url: string): void => {
    window.api
      .invoke(COMMAND_CHANNELS.SYSTEM_OPEN_EXTERNAL, { url })
      .catch((err) => console.warn('[About] open-external failed', err));
  };

  return (
    <section className="settings-panel">
      <h2 className="settings-panel-title">{tx('关于', 'About')}</h2>

      <SettingRow label={tx('版本号', 'Version')}>
        <span className="settings-info-text">v{appVersion}</span>
      </SettingRow>

      <SettingRow label={tx('构建信息', 'Build info')}>
        <span className="settings-info-text">
          commit {commit} · {builtAt}
        </span>
      </SettingRow>

      <SettingRow
        label={tx('检查更新', 'Check for updates')}
        hint={describeUpdateStatus(updateStatus, tx)}
      >
        <div className="settings-update-actions">
          {update && (
            <button
              type="button"
              className="settings-button primary"
              onClick={() => openLink(update.downloadUrl)}
              title={update.downloadUrl}
            >
              {tx(`下载 v${update.version}`, `Download v${update.version}`)}
            </button>
          )}
          {update && (
            <button
              type="button"
              className="settings-button"
              onClick={() => openLink(update.htmlUrl)}
            >
              {tx('更新说明', 'Release notes')}
            </button>
          )}
          <button
            type="button"
            className="settings-button"
            disabled={updateStatus?.state === 'checking'}
            onClick={() => void checkNow()}
          >
            {tx('立即检查', 'Check now')}
          </button>
          {!update && (
            <button
              type="button"
              className="settings-button"
              onClick={() => openExternal(GITHUB_RELEASES)}
            >
              {tx('打开 GitHub Releases', 'Open GitHub Releases')}
            </button>
          )}
        </div>
      </SettingRow>

      <SettingRow
        label={tx('自动检查更新', 'Check for updates automatically')}
        hint={tx(
          '启动后和每 6 小时查一次 GitHub,有新版本时在这里和侧栏设置按钮上提示。只给下载链接,不会自动下载或安装。Beta 和开发版不自动检查',
          'Checks GitHub at startup and every 6 hours, and shows new versions here and on the sidebar settings button. It only offers a download link and never downloads or installs by itself. Beta and dev builds do not check automatically',
        )}
      >
        <label className="settings-checkbox">
          <input
            type="checkbox"
            checked={autoCheckUpdates}
            onChange={(e) =>
              void updateSettings({ behavior: { autoCheckUpdates: e.target.checked } }, setError)
            }
          />
          <span>{tx('启用', 'Enable')}</span>
        </label>
      </SettingRow>

      <SettingRow label={tx('GitHub 仓库', 'GitHub repository')}>
        <button type="button" className="settings-button" onClick={() => openExternal(GITHUB_REPO)}>
          {GITHUB_REPO}
        </button>
      </SettingRow>

      <SettingRow label="License">
        <span className="settings-info-text">MIT</span>
      </SettingRow>

      <SettingRow
        label={tx('致谢', 'Acknowledgements')}
        hint={tx('Ceteris 站在这些项目的肩上', 'Ceteris stands on the shoulders of these projects')}
      >
        <ul className="acknowledgements-list">
          {ACKNOWLEDGEMENTS.map((a) => (
            <li key={a.name}>
              <button
                type="button"
                className="acknowledgements-link"
                onClick={() => openExternal(a.url)}
              >
                {a.name}
              </button>
              <span className="acknowledgements-tone"> — {a.tone}</span>
            </li>
          ))}
        </ul>
      </SettingRow>
    </section>
  );
}

// ──────────────────────────────────────────────────────────────────
// 通用控件
// ──────────────────────────────────────────────────────────────────

export function SettingRow({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="settings-row">
      <div className="settings-row-meta">
        <div className="settings-row-label">{label}</div>
        {hint && <div className="settings-row-hint">{hint}</div>}
      </div>
      <div className="settings-row-control">{children}</div>
    </div>
  );
}

interface NumberInputProps {
  value: number;
  min: number;
  max: number;
  step: number;
  /** 显示成 100% 而不是 1 (UI 缩放用) */
  formatPercent?: boolean;
  onChange: (v: number) => void;
}

function NumberInput({
  value,
  min,
  max,
  step,
  formatPercent,
  onChange,
}: NumberInputProps): JSX.Element {
  // 内部 string state 让用户能输入"1.2" → 不被立即截成 1
  const [text, setText] = useState<string>(
    formatPercent ? `${Math.round(value * 100)}` : `${value}`,
  );
  const inputRef = useRef<HTMLInputElement | null>(null);

  // value (来自 main 广播) 变化时同步内部 text。仅在 input 当前不聚焦时
  // 同步:跨窗口场景下另一窗口在改字号/UI 缩放等会广播 SETTINGS_CHANGED,
  // 若本地正在输入则会被无条件覆盖(FBK-3)。聚焦时跳过,blur/commit 时
  // 自然走 onChange 路径,不丢用户输入。
  useEffect(() => {
    if (inputRef.current && document.activeElement === inputRef.current) return;
    setText(formatPercent ? `${Math.round(value * 100)}` : `${value}`);
  }, [value, formatPercent]);

  const commit = (): void => {
    const raw = parseFloat(text);
    if (!Number.isFinite(raw)) return;
    const v = formatPercent ? raw / 100 : raw;
    if (v < min || v > max) {
      // 越界回退显示
      setText(formatPercent ? `${Math.round(value * 100)}` : `${value}`);
      return;
    }
    if (v === value) return;
    onChange(v);
  };

  const handleChange = (e: ChangeEvent<HTMLInputElement>): void => {
    setText(e.target.value);
  };

  const handleBlur = (): void => commit();

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <input
        ref={inputRef}
        type="number"
        className="settings-input numeric"
        value={text}
        min={formatPercent ? min * 100 : min}
        max={formatPercent ? max * 100 : max}
        step={formatPercent ? Math.round(step * 100) : step}
        onChange={handleChange}
        onBlur={handleBlur}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        }}
      />
      {formatPercent && <span style={{ color: 'var(--color-text-secondary, #f0f)' }}>%</span>}
    </span>
  );
}

/**
 * M1-I:模板编辑器环境变量输入框 — 默认遮罩(显示 ***),点眼睛切真实。
 * 模糊视觉用 CSS filter blur,真值始终在 input value 里,不影响保存。
 * 复制粘贴时浏览器拿真值;肉眼看不见。
 *
 * 安全:遮罩仅靠"显示/隐藏"按钮显式切换。早期版本把 hover/focus 也作为
 * 自动 reveal,被审计判定与 hint("防被旁人看到 API key")矛盾 — 鼠标偶然
 * 路过即明文,违背设计意图。现回归"显式开关"。
 */
function EnvTextarea({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}): JSX.Element {
  const { tx } = useTranslation();
  const [revealed, setRevealed] = useState(false);
  return (
    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'flex-start' }}>
      <textarea
        className="settings-input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="ANTHROPIC_API_KEY=sk-..."
        rows={4}
        style={{
          minWidth: 320,
          fontFamily: 'var(--terminal-font-family, monospace)',
          filter: revealed ? 'none' : 'blur(4px)',
          transition: 'filter 120ms ease',
        }}
      />
      <button
        type="button"
        className="settings-button"
        onClick={() => setRevealed((v) => !v)}
        title={revealed ? tx('遮罩内容', 'Mask content') : tx('查看明文', 'Reveal content')}
        style={{ padding: '4px 8px' }}
      >
        {revealed ? tx('隐藏', 'Hide') : tx('显示', 'Show')}
      </button>
    </span>
  );
}

interface FontPickerProps {
  value: string;
  fonts: FontEntry[];
  onChange: (value: string) => void;
}

/**
 * 字体下拉:推荐字体 + 系统已装字体 + "自定义" 选项。
 *
 * CP-4 勘误 #3:fonts 数组现在含 recommended 字段;UI 把它分两组显示
 * (<optgroup>) — 推荐组在上,系统其他在下,直观且不遗漏用户已装但不在
 * 我们推荐里的字体。
 */
function FontPicker({ value, fonts, onChange }: FontPickerProps): JSX.Element {
  const { tx } = useTranslation();
  const firstFamily = useMemo(() => extractFirstFontFamily(value), [value]);
  const knownFamily = fonts.find((f) => f.family === firstFamily);
  const [isCustom, setIsCustom] = useState<boolean>(!knownFamily);
  const [customText, setCustomText] = useState<string>(value);

  useEffect(() => {
    setCustomText(value);
    setIsCustom(!fonts.find((f) => f.family === extractFirstFontFamily(value)));
  }, [value, fonts]);

  // 分组:推荐 vs 系统其他
  const { recommended, others } = useMemo(() => {
    const rec: FontEntry[] = [];
    const oth: FontEntry[] = [];
    for (const f of fonts) {
      if (f.recommended) rec.push(f);
      else oth.push(f);
    }
    return { recommended: rec, others: oth };
  }, [fonts]);

  if (isCustom) {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <input
          type="text"
          className="settings-input"
          value={customText}
          onChange={(e) => setCustomText(e.target.value)}
          onBlur={() => onChange(customText)}
          placeholder={tx("例如 'My Font', monospace", "e.g. 'My Font', monospace")}
        />
        <button type="button" className="settings-button" onClick={() => setIsCustom(false)}>
          {tx('切回下拉', 'Back to dropdown')}
        </button>
      </span>
    );
  }

  return (
    <select
      className="settings-input"
      value={firstFamily}
      onChange={(e) => {
        if (e.target.value === '__custom__') {
          setIsCustom(true);
          return;
        }
        onChange(e.target.value);
      }}
    >
      <optgroup label={tx('推荐', 'Recommended')}>
        {recommended.map((f) => (
          <option
            key={f.family}
            value={f.family}
            style={{ fontFamily: `"${f.family}", monospace` }}
          >
            {f.family}
            {f.installed ? '' : tx(' (未装)', ' (not installed)')}
          </option>
        ))}
      </optgroup>
      {others.length > 0 && (
        <optgroup
          label={tx(`系统已安装 (${others.length})`, `Installed on system (${others.length})`)}
        >
          {others.map((f) => (
            <option
              key={f.family}
              value={f.family}
              style={{ fontFamily: `"${f.family}", monospace` }}
            >
              {f.family}
            </option>
          ))}
        </optgroup>
      )}
      <option value="__custom__">{tx('— 自定义 —', '— Custom —')}</option>
    </select>
  );
}

function extractFirstFontFamily(cssFontFamily: string): string {
  // 取逗号前第一个 token,去引号
  const first = (cssFontFamily.split(',')[0] ?? '').trim();
  return first.replace(/^['"]|['"]$/g, '');
}
