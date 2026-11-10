/**
 * @file src/main/settings-manager.ts
 * @purpose 维护应用设置:加载 / deep merge partial update / 校验 / 持久化 /
 *   广播变更。设置即改即生效,无"保存"按钮 (ADR-007、软件定义书 6.6.1)。
 *
 * @关键设计:
 * - 默认值集中在 DEFAULT_SETTINGS,持久化文件缺字段时自动填默认 (deep
 *   merge 保证向前兼容)
 * - update(partial) deep-merge → validate → commit,validate 失败不 commit
 * - emit('settingsChanged', { settings, changedKeys }) 给 IPC 广播,
 *   changedKeys 是 dotted path (e.g. "appearance.theme") 给 renderer 做局部更新
 * - 写盘走 JsonStore 的 debounce 500ms (软件定义书 11.3)
 *
 * @对应文档章节: 软件定义书.md 6.6、11.1、11.3 节;
 *   ipc-protocol.md 5.5、6.4 节
 *
 * @CP-2 范围:
 * 完整 schema 已定义,validate 只校验基础范围 (theme 枚举、字号范围等)。
 * 完整 schema 校验 + 版本迁移 + export/import 在 CP-4。
 */
import { EventEmitter } from 'node:events';
import {
  AGENT_TITLE_DEFAULT_MAX_CHARS,
  AGENT_TITLE_MAX_GUIDE_CHARS,
  AGENT_TITLE_MAX_MAX_CHARS,
  AGENT_TITLE_MIN_MAX_CHARS,
} from '@shared/agent-title';
import { BEAMER_THEME_IDS } from '@shared/beamer-themes';
import { isCustomThemeId } from '@shared/custom-themes';
import { LEGADO_THEME_IDS } from '@shared/legado-themes';
import { PILI_THEME_IDS } from '@shared/pili-themes';
import {
  isHexColor,
  LEGADO_CONTRAST_LEVELS,
  LEGADO_DEFAULT_SEED,
  LEGADO_DYNAMIC_THEME_IDS,
  LEGADO_PALETTE_STYLES,
} from '@shared/legado-dynamic-ids';
import { LINK_DEFAULT_PORT } from '@shared/link-protocol';
import {
  DEFAULT_QUICK_LAUNCH_ITEMS,
  QUICK_LAUNCH_MAX_ITEMS,
  isValidQuickLaunchItems,
} from '@shared/quick-launch';
import type { BuiltinThemeId, Settings } from '@shared/types';
import type { DeepPartial } from '@shared/types-helpers';
import type { JsonStore } from './persistence';

export type { DeepPartial };

/**
 * 默认设置 (软件定义书 11.1 settings.json)。
 *
 * 任何字段缺失时,deep merge 会自动用此处的值填充 — 这是版本兼容的关键。
 * 修改默认值前确认是否需要 bump Settings.version。
 */
export const DEFAULT_SETTINGS: Settings = {
  version: 1,
  appearance: {
    theme: 'light-pink',
    windowStyle: 'windows',
    language: 'system',
    terminalFontFamily:
      "'Cascadia Mono', 'JetBrains Mono', 'Consolas', 'LXGW WenKai Mono', monospace",
    terminalFontSize: 13,
    terminalLineHeight: 1.2,
    uiFontFamily: "'Segoe UI', Roboto, 'Microsoft YaHei UI', system-ui, sans-serif",
    uiZoom: 1.0,
    // BETA-023 macOS 红绿灯悬浮符号,默认关(与 CP-4 勘误第二轮决策一致)
    macOSTrafficLightHoverSymbols: false,
    // issue #4 默认关。TabBar 与 Sidebar 内容重复,用户可勾上更紧凑。
    hideTopTabBar: false,
    // ADR-027:小庆祝默认开,小石子一直可见所以默认关。
    celebrations: true,
    pebble: false,
    // ADR-030:Legado MD3 实时主题的输入,只在选了 Custom / Windows 强调色主题时用到
    legadoSeedColor: LEGADO_DEFAULT_SEED,
    legadoPaletteStyle: 'tonalSpot',
    legadoContrast: 'standard',
  },
  shell: {
    defaultShellId: '',
    newTerminalShellPolicy: 'default',
  },
  behavior: {
    startupBehavior: 'open-window',
    autoStart: false,
    confirmOnQuit: true,
    selectOnCopy: true,
    terminalRightClick: 'menu',
    quickLaunch: [...DEFAULT_QUICK_LAUNCH_ITEMS],
    // 首次使用引导:老用户升级后字段缺失,deep merge 补 false,也会看到一次。
    quickLaunchTipSeen: false,
    // fix/robustness-pass-20260513 / CPB-P8:默认开 bracketed paste
    // (Ceteris 默认 shell 是 PowerShell,7+ ReadLine 默认识别 ?2004)。
    bracketedPaste: true,
    // ADR-018:默认检查更新。只提示并给下载链接,不自动下载安装。
    autoCheckUpdates: true,
    // 新建页 agent 状态点:后台检查默认开,自动升级默认关 (升级前总会先通知)
    autoCheckAgents: true,
    autoUpdateAgents: false,
  },
  systemIntegration: {
    explorerOpenIn: 'new-window',
  },
  advanced: {
    logLevel: 'INFO',
    activeIdleThresholdSeconds: 2,
    // SSH 方案 v2.1 §阶段 2.1:默认不读 ~/.ssh/config,用户在 RemotePanel
    // 主动启用才合并显示。避免出现没看过 ssh_config 的用户误以为 Ceteris
    // 暴露了他们的远端清单。
    includeSshConfig: false,
    // SSH 方案 v2.1 §阶段 3.5:默认开 ControlMaster,同 host 多 session
    // 性能从 ~3s 握手 / 个降到 <100ms / 个。只在 Linux / macOS 生效,Windows
    // 版 OpenSSH 不支持,SessionManager 会跳过。
    enableControlMaster: true,
    // 终端渲染器默认 'auto':Windows/macOS WebGL、Linux DOM(PER-LINUX,
    // BETA-003 修复)。'webgl' / 'dom' 是显式覆盖,通常给调研某些 WebGL
    // 兼容性 bug 用(例如某些 TUI 的光标渲染在 WebGL 下异常)。
    terminalRenderer: 'auto',
  },
  // 扩展默认全关 (ADR-019):公式图片会改 XTVERSION 回复与 Windows 的 ConPTY,
  // 只给主动打开的用户。
  extensions: {
    claudeMathImages: false,
    terminalMath: false,
    tabControl: false,
    // 协调者引导 (ADR-024):老设置文件缺这个字段,deep merge 补 false,升级后也会看到一次
    tabControlGuideSeen: false,
    // 扩展一次装好的卡片 (ADR-034):同上,升级后也会出现一次
    setupSeen: false,
  },
  // BETA-031 AI 助手默认全 disabled,用户开启 + 填 key 后才生效
  ai: {
    provider: null,
    apiKey: '',
    // F6(beta 勘误2):自定义 endpoint,空串走官方默认地址
    baseURL: '',
    model: '',
    nextPrompt: { enabled: false, keySaved: false, baseURL: '', model: '' },
    // ADR-029:默认关,因为屏幕末尾会发给 API;缩短 agent 自己的标题不需要开
    tabTitles: { enabled: false, guide: '', maxChars: AGENT_TITLE_DEFAULT_MAX_CHARS },
    statusRecheckEnabled: false,
    // BETA-006 v2:默认走 headless(已渲染文本),消除 ANSI 噪音与 PSReadLine
    // 重绘残影。老用户升级后字段缺失也会因为 SettingsManager.merge 走 default。
    statusRecheckSource: 'headless',
  },
  // Ceteris Link 默认全关。hostToken 留空,用户第一次打开 Host 开关时
  // 由 UI 调 cmd:link:regenerate-token 生成 —— 不在默认值里预生成,
  // 因为那会让每个从没用过远程功能的用户的 settings.json 里凭空多一个
  // 看起来像密钥的字符串,徒增困惑。
  link: {
    hostEnabled: false,
    hostBindAddress: 'auto',
    hostPort: LINK_DEFAULT_PORT,
    hostToken: '',
    savedHosts: [],
  },
};

const VALID_THEMES: BuiltinThemeId[] = [
  'ceteris-dark',
  'ceteris-light',
  'rose-pine',
  'rose-pine-dawn',
  'rose-pine-moon',
  'cutie',
  'business',
  'ubuntu',
  'windows-terminal',
  // BETA-033
  'one-dark-pro',
  'dracula',
  'tokyo-night',
  'catppuccin-mocha',
  // UI-2
  'catppuccin-latte',
  'tokyo-night-day',
  'light-pink',
  'fairyfloss',
  // 珠光系列
  'pearl-lapis',
  'pearl-sapphire',
  'pearl-rose',
  'pearl-ember',
  'pearl-jade',
  'pearl-moon',
  'pearl-frost',
  // 梅子
  'meizi',
  ...BEAMER_THEME_IDS,
  ...LEGADO_THEME_IDS,
  ...LEGADO_DYNAMIC_THEME_IDS,
  ...PILI_THEME_IDS,
];

/**
 * 设置变更错误。code 与 ipc-protocol 7.1 对齐。
 */
export class SettingsError extends Error {
  constructor(
    public readonly code: 'InvalidSettings' | 'IncompatibleVersion',
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(`[SettingsManager] ${code}: ${message}`);
    this.name = 'SettingsError';
  }
}

export class SettingsManager extends EventEmitter {
  private settings: Settings;
  private legacyNextPromptKey = '';

  /** @param defaults what a new data folder starts with. Each channel changes a little. */
  constructor(
    private readonly store: JsonStore<Settings>,
    private readonly defaults: Settings = DEFAULT_SETTINGS,
  ) {
    super();
    this.settings = defaults;
  }

  /**
   * 应用启动时调一次。从 store 加载,与默认值 deep-merge 填充缺字段。
   *
   * @returns 来源:'main' / 'bak' / 'default'
   */
  async initialize(): Promise<'main' | 'bak' | 'default'> {
    const result = await this.store.load(this.defaults);
    // v1.5+ 迁移:explorerContextMenu 从 settings 移到系统状态,如果老 settings.json
    // 残留这个字段,静默剥掉(避免 deepMerge 原样带进运行时 settings 对象,污染
    // 导入导出归档 + TS 类型断言失败)。
    // ADR-025: a key pasted before keys moved to secrets.json. Kept for the caller to move
    // into SecretStore, then stripped like any other legacy field.
    const legacyKey = (result.value as { ai?: { nextPrompt?: { apiKey?: unknown } } })?.ai
      ?.nextPrompt?.apiKey;
    this.legacyNextPromptKey = typeof legacyKey === 'string' ? legacyKey.trim() : '';
    const migrated = stripUnknownLegacyFields(result.value);
    // 不论从哪加载,都要走一遍 deep merge 防止用户文件少字段
    const merged = deepMerge(this.defaults, migrated as DeepPartial<Settings>);
    // 版本不兼容直接拒绝 (CP-4 加迁移逻辑;CP-2 简单粗暴)
    if (merged.version !== 1) {
      throw new SettingsError(
        'IncompatibleVersion',
        `Settings version=${merged.version} 不被当前应用支持 (期望 1)。` +
          `如果是从未来版本回退,请手工删除 settings.json 后重启。`,
      );
    }
    this.settings = merged;
    return result.source;
  }

  /**
   * 获取当前设置的深拷贝。返回值修改不影响内部状态。
   */
  get(): Settings {
    return structuredClone(this.settings);
  }

  /**
   * 部分更新。deep-merge 然后整体校验,通过则 commit + 持久化 + emit。
   *
   * @throws SettingsError InvalidSettings 校验失败
   */
  update(partial: DeepPartial<Settings>): void {
    if (!partial || typeof partial !== 'object' || Array.isArray(partial)) {
      throw new SettingsError(
        'InvalidSettings',
        `partial 必须是对象,实际: ${typeof partial}${Array.isArray(partial) ? ' (Array)' : ''}`,
      );
    }
    const next = deepMerge(this.settings, partial);
    validateSettings(next);

    const changedKeys = diffKeys('', this.settings, next);
    if (changedKeys.length === 0) return; // 完全没变,不写不广播

    this.settings = next;
    this.store.set(structuredClone(next));
    this.emit('settingsChanged', { settings: structuredClone(next), changedKeys });
  }

  /**
   * 重置为默认 (危险操作,应通过 cmd:settings:reset 触发)。
   */
  reset(): void {
    const oldSettings = this.settings;
    this.settings = structuredClone(this.defaults);
    const changedKeys = diffKeys('', oldSettings, this.settings);
    this.store.set(structuredClone(this.settings));
    if (changedKeys.length > 0) {
      this.emit('settingsChanged', {
        settings: structuredClone(this.settings),
        changedKeys,
      });
    }
  }

  /**
   * CP-4 勘误 #12:整体替换 settings (设置导入用)。
   *
   * 走和 initialize 同样的 deep-merge 路径,这样导入的归档若缺新增字段
   * 会自动用 DEFAULT_SETTINGS 补齐;然后 validate + commit + emit,所有
   * 窗口通过 evt:settings:changed 立即同步,无需 app.relaunch。
   */
  replaceAll(newSettings: Partial<Settings>): void {
    const cleaned = stripUnknownLegacyFields(newSettings);
    const merged = deepMerge(this.defaults, cleaned as DeepPartial<Settings>);
    if (merged.version !== 1) {
      throw new SettingsError(
        'IncompatibleVersion',
        `Settings version=${merged.version} 不被当前应用支持 (期望 1)`,
      );
    }
    validateSettings(merged);
    const oldSettings = this.settings;
    this.settings = merged;
    this.store.set(structuredClone(merged));
    const changedKeys = diffKeys('', oldSettings, merged);
    if (changedKeys.length > 0) {
      this.emit('settingsChanged', {
        settings: structuredClone(merged),
        changedKeys,
      });
    }
  }

  /**
   * The next prompt key found in plain text in settings.json at startup, '' when none.
   * Returns it once, so the caller moves it to SecretStore exactly one time.
   */
  takeLegacyNextPromptKey(): string {
    const key = this.legacyNextPromptKey;
    this.legacyNextPromptKey = '';
    return key;
  }

  /**
   * Writes the current settings twice. JsonStore copies the old file to .bak before each
   * write, so the second write is what removes a plain text key from settings.json.bak.
   */
  async rewriteBothCopies(): Promise<void> {
    for (let i = 0; i < 2; i++) {
      this.store.set(structuredClone(this.settings));
      await this.store.flush();
    }
  }

  /**
   * 等所有待写入落盘 (退出前调)。
   */
  async flush(): Promise<void> {
    await this.store.flush();
  }
}

// ──────────────────────────────────────────────────────────────────
// 工具函数 (导出以便 settings-manager.test.ts 直接测)
// ──────────────────────────────────────────────────────────────────

/**
 * 浅复制基础类型,深合并对象 (不合并数组,数组整体替换)。
 *
 * 注:这里没用 structuredClone(target) 再 mutate,而是逐字段递归;为了
 * 保持函数纯净,target 不被修改。
 */
/**
 * 把已知应被剥除的"已迁移走"字段从读到的 settings 对象里清掉。
 *
 * v1.5+ 起 `systemIntegration.explorerContextMenu` 改为系统状态(查 HKCU/MSIX),
 * 不再驻留 settings.json。老用户文件里残留该字段需在加载/导入时静默丢弃,否则
 * deepMerge 会原样保留它(deepMerge 只看 partial 的键),污染运行时 Settings
 * 对象 + 导出归档。
 *
 * 实现上做一个浅克隆 + 显式 delete,避免动到调用方传入的对象。
 */
export function stripUnknownLegacyFields<T>(raw: T): T {
  if (!raw || typeof raw !== 'object') return raw;
  const obj = raw as Record<string, unknown>;
  let next: Record<string, unknown> | null = null;
  const ensureClone = (): Record<string, unknown> => {
    if (!next) next = { ...obj };
    return next;
  };

  // SSH 入口改为始终显示后,老文件里的 advanced.enableRemote 不再有意义。
  const advanced = obj['advanced'];
  if (advanced && typeof advanced === 'object' && 'enableRemote' in advanced) {
    const cleaned = { ...(advanced as Record<string, unknown>) };
    delete cleaned['enableRemote'];
    ensureClone()['advanced'] = cleaned;
  }

  if (
    obj['systemIntegration'] &&
    typeof obj['systemIntegration'] === 'object' &&
    !Array.isArray(obj['systemIntegration'])
  ) {
    const si = obj['systemIntegration'] as Record<string, unknown>;
    if ('explorerContextMenu' in si) {
      const cloned = ensureClone();
      const siClone = { ...si };
      delete siClone['explorerContextMenu'];
      cloned['systemIntegration'] = siClone;
    }
  }

  // 2026-05-16:'系统'独立分组已废除(桌面/主目录改为安装时默认收藏),
  // 老 settings.json 残留的 appearance.showSystemPaths / appearance.systemPaths
  // 在加载时静默剥掉 — 不剥的话 deepMerge 会把它们带进运行时 Settings 对象 +
  // 导出归档,污染未来读者。
  if (
    obj['appearance'] &&
    typeof obj['appearance'] === 'object' &&
    !Array.isArray(obj['appearance'])
  ) {
    const ap = obj['appearance'] as Record<string, unknown>;
    if ('showSystemPaths' in ap || 'systemPaths' in ap) {
      const cloned = ensureClone();
      const apClone = { ...ap };
      delete apClone['showSystemPaths'];
      delete apClone['systemPaths'];
      cloned['appearance'] = apClone;
    }
  }

  // CURSOR-1(2026-05-17):BETA-006 v2 输入源 'raw'(裸字节 scrollback 末尾)
  // 路径已删除,老 settings.json 残留 ai.statusRecheckSource='raw' 静默 coerce
  // 到 'headless'(唯一可用)。不 coerce 的话 validateSettings 会因枚举不匹
  // 配抛错。
  if (obj['ai'] && typeof obj['ai'] === 'object' && !Array.isArray(obj['ai'])) {
    const ai = obj['ai'] as Record<string, unknown>;
    if (ai['statusRecheckSource'] === 'raw') {
      const cloned = ensureClone();
      const aiClone = { ...ai, statusRecheckSource: 'headless' };
      cloned['ai'] = aiClone;
    }
    // ADR-025: the next prompt key moved to secrets.json. initialize() hands any old one
    // to SecretStore before this runs; an imported bundle never carried one.
    const np = ai['nextPrompt'];
    if (np && typeof np === 'object' && 'apiKey' in np) {
      const cloned = ensureClone();
      const npClone = { ...(np as Record<string, unknown>) };
      delete npClone['apiKey'];
      cloned['ai'] = { ...(cloned['ai'] as Record<string, unknown>), nextPrompt: npClone };
    }
  }

  return (next ?? raw) as T;
}

export function deepMerge<T>(target: T, partial: DeepPartial<T> | undefined): T {
  if (partial === undefined || partial === null) return target;
  if (typeof target !== 'object' || target === null) {
    return partial as unknown as T;
  }
  if (Array.isArray(target)) {
    // 数组整体替换 (除非 partial 也是 array,直接用 partial)
    return (Array.isArray(partial) ? partial : target) as T;
  }
  const result: Record<string, unknown> = { ...(target as Record<string, unknown>) };
  for (const key of Object.keys(partial as object)) {
    const partialValue = (partial as Record<string, unknown>)[key];
    if (partialValue === undefined) continue; // undefined 不覆盖
    const targetValue = (target as Record<string, unknown>)[key];
    if (
      typeof targetValue === 'object' &&
      targetValue !== null &&
      !Array.isArray(targetValue) &&
      typeof partialValue === 'object' &&
      partialValue !== null &&
      !Array.isArray(partialValue)
    ) {
      result[key] = deepMerge(targetValue, partialValue as DeepPartial<unknown>);
    } else {
      result[key] = partialValue;
    }
  }
  return result as T;
}

/**
 * 算两个对象的字段差异,返回 dotted-path 列表 ("appearance.theme")。
 */
export function diffKeys<T>(prefix: string, a: T, b: T): string[] {
  if (a === b) return [];
  if (
    typeof a !== 'object' ||
    a === null ||
    typeof b !== 'object' ||
    b === null ||
    Array.isArray(a) ||
    Array.isArray(b)
  ) {
    // 叶子节点或 array,直接比较
    return JSON.stringify(a) === JSON.stringify(b) ? [] : [prefix || '*'];
  }
  const keys = new Set([
    ...Object.keys(a as Record<string, unknown>),
    ...Object.keys(b as Record<string, unknown>),
  ]);
  const result: string[] = [];
  for (const key of keys) {
    const subPrefix = prefix ? `${prefix}.${key}` : key;
    const aVal = (a as Record<string, unknown>)[key];
    const bVal = (b as Record<string, unknown>)[key];
    result.push(...diffKeys(subPrefix, aVal, bVal));
  }
  return result;
}

/**
 * Settings 校验。CP-2 仅基础范围 + 枚举值,完整 schema 校验在 CP-4。
 *
 * @throws SettingsError InvalidSettings 任意字段越界 / 枚举错误
 */
/**
 * 校验 Ceteris Link 设置。
 *
 * 这里的校验比其它字段严格,理由是 link 配置直接决定"谁能连进这台机器":
 * 一个被写坏的端口或空 token 不该被静默接受然后在运行期以难懂的方式失败。
 *
 * @throws SettingsError InvalidSettings
 */
function validateLinkSettings(s: Settings): void {
  const link = s.link;
  if (!link || typeof link !== 'object') {
    throw new SettingsError('InvalidSettings', 'link 必须是对象');
  }
  checkRange('link.hostPort', link.hostPort, 1024, 65535);

  // 开着 Host 却没有 token = 谁都连不上(密钥派生会抛错),这是配置错误
  // 而非"更开放的模式"。必须在写入前拦下,否则用户会看到一个"已开启"的
  // 开关配上永远失败的连接。
  if (link.hostEnabled && !link.hostToken) {
    throw new SettingsError(
      'InvalidSettings',
      'link.hostEnabled 为 true 时 link.hostToken 不能为空。请先生成访问令牌。',
      { field: 'link.hostToken' },
    );
  }

  if (!Array.isArray(link.savedHosts)) {
    throw new SettingsError('InvalidSettings', 'link.savedHosts 必须是数组');
  }
  for (const [i, entry] of link.savedHosts.entries()) {
    if (!entry || typeof entry !== 'object') {
      throw new SettingsError('InvalidSettings', `link.savedHosts[${i}] 必须是对象`);
    }
    if (!entry.id || typeof entry.id !== 'string') {
      throw new SettingsError('InvalidSettings', `link.savedHosts[${i}].id 必须是非空字符串`);
    }
    if (!entry.host || typeof entry.host !== 'string') {
      throw new SettingsError(
        'InvalidSettings',
        `link.savedHosts[${i}].host 必须是非空字符串(建议填 Tailscale 的 100.x.y.z)`,
      );
    }
    checkRange(`link.savedHosts[${i}].port`, entry.port, 1024, 65535);
  }
}

export function validateSettings(s: Settings): void {
  // 用户主题文件只校验 id 格式:文件可能稍后才放进主题文件夹,或已被删除,此时
  // renderer 回退到默认配色,不拒绝整份设置。
  const theme = s.appearance.theme;
  if (!isCustomThemeId(theme) && !VALID_THEMES.includes(theme as BuiltinThemeId)) {
    throw new SettingsError(
      'InvalidSettings',
      `appearance.theme="${theme}" 不是合法主题,允许: ${VALID_THEMES.join(', ')} 或 custom:<slug>`,
      { field: 'appearance.theme', got: s.appearance.theme, allowed: VALID_THEMES },
    );
  }
  if (!['windows', 'macos'].includes(s.appearance.windowStyle)) {
    throw new SettingsError(
      'InvalidSettings',
      `appearance.windowStyle="${s.appearance.windowStyle}" 必须是 windows 或 macos`,
    );
  }
  if (!isHexColor(s.appearance.legadoSeedColor)) {
    throw new SettingsError(
      'InvalidSettings',
      `appearance.legadoSeedColor="${String(s.appearance.legadoSeedColor)}" 必须是 #rrggbb 形式的颜色`,
    );
  }
  if (!(LEGADO_PALETTE_STYLES as readonly string[]).includes(s.appearance.legadoPaletteStyle)) {
    throw new SettingsError(
      'InvalidSettings',
      `appearance.legadoPaletteStyle="${s.appearance.legadoPaletteStyle}" 必须是 ${LEGADO_PALETTE_STYLES.join(' / ')} 之一`,
    );
  }
  if (!Object.keys(LEGADO_CONTRAST_LEVELS).includes(s.appearance.legadoContrast)) {
    throw new SettingsError(
      'InvalidSettings',
      `appearance.legadoContrast="${s.appearance.legadoContrast}" 必须是 standard / medium / high`,
    );
  }
  checkRange('appearance.terminalFontSize', s.appearance.terminalFontSize, 8, 24);
  checkRange('appearance.terminalLineHeight', s.appearance.terminalLineHeight, 1.0, 2.0);
  checkRange('appearance.uiZoom', s.appearance.uiZoom, 0.75, 1.5);
  checkRange('advanced.activeIdleThresholdSeconds', s.advanced.activeIdleThresholdSeconds, 0.1, 60);
  if (!['INFO', 'DEBUG'].includes(s.advanced.logLevel)) {
    throw new SettingsError(
      'InvalidSettings',
      `advanced.logLevel="${s.advanced.logLevel}" 必须是 INFO 或 DEBUG`,
    );
  }
  if (!['auto', 'webgl', 'dom'].includes(s.advanced.terminalRenderer)) {
    throw new SettingsError(
      'InvalidSettings',
      `advanced.terminalRenderer="${s.advanced.terminalRenderer}" 必须是 auto / webgl / dom`,
    );
  }
  // ADR-029
  const titles = s.ai.tabTitles;
  if (typeof titles.enabled !== 'boolean' || typeof titles.guide !== 'string') {
    throw new SettingsError(
      'InvalidSettings',
      `ai.tabTitles 需要 enabled: boolean 和 guide: string,收到 ${JSON.stringify(titles)}`,
    );
  }
  if (titles.guide.length > AGENT_TITLE_MAX_GUIDE_CHARS) {
    throw new SettingsError(
      'InvalidSettings',
      `ai.tabTitles.guide 有 ${titles.guide.length} 字,最多 ${AGENT_TITLE_MAX_GUIDE_CHARS}`,
    );
  }
  if (!Number.isInteger(titles.maxChars)) {
    throw new SettingsError(
      'InvalidSettings',
      `ai.tabTitles.maxChars=${String(titles.maxChars)} 必须是整数`,
    );
  }
  checkRange(
    'ai.tabTitles.maxChars',
    titles.maxChars,
    AGENT_TITLE_MIN_MAX_CHARS,
    AGENT_TITLE_MAX_MAX_CHARS,
  );
  if (typeof s.extensions.tabControlGuideSeen !== 'boolean') {
    throw new SettingsError(
      'InvalidSettings',
      `extensions.tabControlGuideSeen=${String(s.extensions.tabControlGuideSeen)} 必须是 true 或 false`,
    );
  }
  if (typeof s.extensions.setupSeen !== 'boolean') {
    throw new SettingsError(
      'InvalidSettings',
      `extensions.setupSeen=${String(s.extensions.setupSeen)} 必须是 true 或 false`,
    );
  }
  if (typeof s.extensions.setupSeen !== 'boolean') {
    throw new SettingsError(
      'InvalidSettings',
      `extensions.setupSeen=${String(s.extensions.setupSeen)} 必须是 true 或 false`,
    );
  }
  if (typeof s.extensions.tabControl !== 'boolean') {
    throw new SettingsError(
      'InvalidSettings',
      `extensions.tabControl=${String(s.extensions.tabControl)} 必须是 true 或 false`,
    );
  }
  if (typeof s.extensions.claudeMathImages !== 'boolean') {
    throw new SettingsError(
      'InvalidSettings',
      `extensions.claudeMathImages=${String(s.extensions.claudeMathImages)} 必须是 true 或 false`,
    );
  }
  if (typeof s.extensions.terminalMath !== 'boolean') {
    throw new SettingsError(
      'InvalidSettings',
      `extensions.terminalMath=${String(s.extensions.terminalMath)} 必须是 true 或 false`,
    );
  }
  if (!['menu', 'paste'].includes(s.behavior.terminalRightClick)) {
    throw new SettingsError(
      'InvalidSettings',
      `behavior.terminalRightClick="${s.behavior.terminalRightClick}" 必须是 menu 或 paste`,
    );
  }
  validateLinkSettings(s);
  if (!['open-window', 'tray-only'].includes(s.behavior.startupBehavior)) {
    throw new SettingsError(
      'InvalidSettings',
      `behavior.startupBehavior="${s.behavior.startupBehavior}" 必须是 open-window 或 tray-only`,
    );
  }
  if (!isValidQuickLaunchItems(s.behavior.quickLaunch)) {
    throw new SettingsError(
      'InvalidSettings',
      `behavior.quickLaunch 无效:必须是最多 ${QUICK_LAUNCH_MAX_ITEMS} 项的不重复列表,` +
        `每项为 { kind: 'template' | 'shell', id }。`,
      { field: 'behavior.quickLaunch', got: s.behavior.quickLaunch },
    );
  }
  if (!['default', 'last-used'].includes(s.shell.newTerminalShellPolicy)) {
    throw new SettingsError(
      'InvalidSettings',
      `shell.newTerminalShellPolicy="${s.shell.newTerminalShellPolicy}" 必须是 default 或 last-used`,
    );
  }
  if (!['new-window', 'recent-window-tab'].includes(s.systemIntegration.explorerOpenIn)) {
    throw new SettingsError(
      'InvalidSettings',
      `systemIntegration.explorerOpenIn="${s.systemIntegration.explorerOpenIn}" 必须是 new-window 或 recent-window-tab`,
    );
  }
}

function checkRange(field: string, value: unknown, min: number, max: number): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new SettingsError('InvalidSettings', `${field} 必须是有限数,实际: ${value}`);
  }
  if (value < min || value > max) {
    throw new SettingsError('InvalidSettings', `${field}=${value} 越界,允许 [${min}, ${max}]`, {
      field,
      value,
      min,
      max,
    });
  }
}
