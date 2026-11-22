/**
 * @file src/renderer/components/TemplateIcon.tsx
 * @purpose 模板图标统一渲染(P2-14)。
 *
 *   早期 MainPane 的 TemplateLaunchButton 走 builtin 模板 id → lucide 矢量图标
 *   的映射,自定义模板 fallback 到 emoji 字符串。但 SettingsView 的 TemplateList
 *   只渲染 `{t.icon}` (emoji),内置模板在列表里也只显示 emoji,与启动按钮不一致。
 *
 *   抽到这里:任何展示模板图标的位置都走同一逻辑,自动保持一致。
 */
import { Icon, type IconName } from './icons';
import type { Template } from '@shared/types';

/**
 * 已知 builtin 模板 id → lucide 图标名映射。未知 / 自定义 模板返回 null,
 * 由调用方 fallback 到 template.icon emoji 字符串。
 */
function builtinTemplateIcon(id: string): IconName | null {
  switch (id) {
    case 'shell':
      return 'templateShell';
    case 'claude-code':
      return 'templateClaudeCode';
    case 'codex':
      return 'templateCodex';
    case 'opencode':
      return 'templateOpenCode';
    case 'gemini-cli':
      return 'templateGemini';
    case 'github-copilot':
      return 'templateCopilot';
    case 'cursor':
      return 'templateCursor';
    case 'aider':
      return 'templateAider';
    case 'pi':
      return 'templatePi';
    case 'omp':
      return 'templateOmp';
    case 'qwen-code':
      return 'templateQwen';
    case 'amp':
      return 'templateAmp';
    case 'crush':
      return 'templateCrush';
    case 'kimi':
      return 'templateKimi';
    case 'goose':
      return 'templateGoose';
    case 'droid':
      return 'templateDroid';
    case 'kiro':
      return 'templateKiro';
    case 'cline':
      return 'templateCline';
    case 'auggie':
      return 'templateAuggie';
    case 'kilo':
      return 'templateKilo';
    case 'codebuddy':
      return 'templateCodeBuddy';
    case 'qoder':
      return 'templateQoder';
    case 'letta':
      return 'templateLetta';
    default:
      return null;
  }
}

interface Props {
  template: Pick<Template, 'id' | 'icon'>;
  /** 矢量图标尺寸。emoji fallback 不受此影响(继承父字号)。 */
  size?: number;
}

export function TemplateIcon({ template, size = 18 }: Props): JSX.Element {
  const iconName = builtinTemplateIcon(template.id);
  if (iconName) return <Icon name={iconName} size={size} />;
  return <>{template.icon}</>;
}
