/**
 * @file src/renderer/components/icons.tsx
 * @purpose 集中导出本应用 UI 里用到的图标 + 一个统一的 <Icon /> 包装。CP-4 勘误 #11
 *   引入,用矢量图标替代各字体下渲染不一致的 Emoji。图标源是 vendored 的 Material
 *   Symbols (Rounded),见 material-symbols.tsx。
 *
 * @关键设计:
 * - 仅在 UI shell (设置页 nav / 侧栏分类 / 终端右键 / 状态条 等) 替换 Emoji
 * - 用户数据里的 emoji (Template.icon) 保持原样 — 那是用户自己输入的
 * - 所有图标统一 size=14,继承 currentColor,与主题文字色同步
 * - 组件只认这里的语义名,后续整体换图标集的代价较小
 *
 * @对应文档章节: 软件定义书.md 5.1.9 (主题); CP-4 勘误 #11
 */
import type { ReactElement } from 'react';
import {
  Add,
  Atr,
  AutoAwesome,
  Bookmark,
  Build,
  ChevronRight,
  Close,
  Code,
  ContentCopy,
  ContentPaste,
  Database,
  DeployedCode,
  Dns,
  ForkRight,
  History,
  Info,
  InkEraser,
  LinkIcon,
  OpenInNew,
  Palette,
  Psychology,
  RadioChecked,
  Schedule,
  Search,
  Refresh,
  Settings,
  Terminal,
  Tune,
  Warning,
  Window,
} from './material-symbols';

/**
 * 默认图标尺寸 (px)。UI 文字 13px,匹配相同视觉重量取 14。
 * 状态点等极小图标用 12;tab 关闭按钮等中等用 16。
 */
export const ICON_SIZE_DEFAULT = 14;
export const ICON_SIZE_SMALL = 12;
export const ICON_SIZE_MEDIUM = 16;

/**
 * 命名映射:把 UI 里的"语义"(分类) 与实际图标组件挂上钩。
 * 用别处只 import 这一份名字表,后续整体换图标集的代价较小。
 */
export const Icons = {
  // 设置页分类
  appearance: Palette,
  shell: Terminal,
  behavior: Tune,
  data: Database,
  systemIntegration: LinkIcon,
  ai: Psychology, // BETA-031 AI 助手
  extensions: DeployedCode, // ADR-019 可选扩展
  advanced: Build,
  about: Info,

  // 侧栏分类
  bookmark: Bookmark,
  clock: Schedule,
  history: History,
  server: Dns,

  // 终端右键 / 搜索栏
  copy: ContentCopy,
  paste: ContentPaste,
  clear: InkEraser,
  search: Search,
  refresh: Refresh,

  // 通用
  settings: Settings,
  alertTriangle: Warning,
  externalLink: OpenInNew,
  chevronRight: ChevronRight,
  circleDot: RadioChecked,
  close: Close,
  plus: Add,

  // 勘误第二轮 #4:内置模板 / shell 的图标。没有真品牌 SVG,用语义贴近的
  // 矢量图标替原 emoji,至少视觉上一致、矢量化、随主题色变。
  templateShell: Terminal,
  templateClaudeCode: AutoAwesome, // 与 Claude 品牌星形相近
  templateCodex: Atr, // OpenAI 圆轨道意象
  templateOpenCode: DeployedCode, // 与 OpenCode 立方体 logo 相近
  templateGemini: Psychology,
  templateCopilot: ForkRight,
  templateCursor: Code,
  templateAider: Build,

  // shell 图标:不同 shell 用不同符号区分
  shellPwsh: Terminal, // PowerShell 7
  shellPowershell: Window, // Windows PowerShell 5.1
  shellCmd: Code,
  shellGitBash: ForkRight,
} as const;

export type IconName = keyof typeof Icons;

/**
 * 通用 Icon 组件。color 默认走 currentColor,大小默认 14;通过 className 挂
 * 主题样式 (例如 .session-icon-warn { color: var(--color-warning) })。
 */
export function Icon({
  name,
  size = ICON_SIZE_DEFAULT,
  className,
  ...rest
}: {
  name: IconName;
  size?: number;
  className?: string;
  'aria-label'?: string;
}): ReactElement {
  const Comp = Icons[name];
  return <Comp size={size} className={className} {...rest} />;
}
