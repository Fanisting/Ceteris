/**
 * @file src/renderer/components/useQuickLaunch.tsx
 * @purpose 快捷启动选项的解析和启动,供标签栏末尾的幽灵标签(GhostTab)使用。
 *
 * @关键设计:
 * - 选项来自 设置 → 行为 的 quickLaunch 列表,存的是模板或 shell 的 id;这里按当前路径
 *   解析成可启动的条目。规则与新建页 EmptyPathState 相同:SSH 路径不传 shell、跳过本地 shell;
 *   WSL 路径用该发行版的 shell,没有可用 shell 时连模板也隐藏。
 * - 启动参数与新建页完全一致,启动后选中新 session 并把焦点交给终端。
 *
 * @对应文档章节: 软件定义书.md 2 (鼠标优先)
 *
 * @不要在这里做的事:
 * - 不要加键盘快捷键 (13.2 永远不做应用内功能键)
 */
import { useEffect, useState, type ReactNode } from 'react';
import {
  COMMAND_CHANNELS,
  type CreateSessionResponse,
  type ListShellsResponse,
} from '@shared/protocol';
import {
  DEFAULT_QUICK_LAUNCH_ITEMS,
  quickLaunchItemKey,
  type QuickLaunchItem,
} from '@shared/quick-launch';
import { focusTerminalDom } from '../focus';
import { findPathNode, useAppDispatch, useAppState } from '../store';
import { Icon } from './icons';
import { useTranslation } from './LanguageProvider';
import {
  filterShellsForWslPath,
  getWslDistroName,
  shellIcon,
  type DetectedShell,
} from './launch-options';
import { TemplateIcon } from './TemplateIcon';
import { useToast } from './Toast';

export interface ResolvedQuickLaunchItem {
  key: string;
  label: string;
  icon: ReactNode;
  templateId: string;
  shellId: string | undefined;
}

export interface QuickLaunch {
  /** shell 列表还没取回时为 false,此时 items 为空 */
  ready: boolean;
  items: ResolvedQuickLaunchItem[];
  launch: (item: ResolvedQuickLaunchItem) => Promise<void>;
}

/**
 * 把快捷启动选项解析成当前路径可启动的条目。
 *
 * @param pathId 启动所在的路径;null 时没有条目(没有选中路径就无处启动)
 * @param iconSize 条目图标的像素尺寸
 *
 * @副作用:挂载时向 main 请求一次已检测到的 shell 列表
 */
export function useQuickLaunch(pathId: string | null, iconSize: number): QuickLaunch {
  const { tx } = useTranslation();
  const state = useAppState();
  const dispatch = useAppDispatch();
  const toast = useToast();
  const [shells, setShells] = useState<DetectedShell[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    window.api
      .invoke<unknown, ListShellsResponse>(COMMAND_CHANNELS.SETTINGS_LIST_SHELLS, {})
      .then((res) => {
        if (!cancelled) setShells(res.shells);
      })
      .catch((err) => {
        console.warn('[QuickLaunch] list-shells failed', err);
        if (!cancelled) setShells([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const node = pathId ? findPathNode(state.pathTree, pathId) : null;
  const isSshPath = node?.kind === 'ssh';
  const wslDistroName = node ? getWslDistroName(node.path) : null;
  const visibleShells = shells ? filterShellsForWslPath(shells, wslDistroName) : null;
  const wslShellId = wslDistroName ? visibleShells?.[0]?.id : undefined;

  const resolve = (item: QuickLaunchItem): ResolvedQuickLaunchItem | null => {
    const key = quickLaunchItemKey(item);
    if (item.kind === 'template') {
      // 新建页在 WSL 路径没有可用 shell 时隐藏全部模板,这里保持一致
      if (wslDistroName && !wslShellId) return null;
      const template = state.templates.find((t) => t.id === item.id);
      if (!template) return null;
      return {
        key,
        label: template.name,
        icon: <TemplateIcon template={template} size={iconSize} />,
        templateId: template.id,
        shellId: isSshPath ? undefined : wslShellId,
      };
    }
    if (isSshPath) return null;
    const shell = visibleShells?.find((s) => s.id === item.id);
    if (!shell) return null;
    return {
      key,
      label: shell.displayName,
      icon: <Icon name={shellIcon(shell.id)} size={iconSize} />,
      templateId: 'shell',
      shellId: shell.id,
    };
  };

  const ready = shells !== null;
  const items =
    ready && pathId
      ? (state.settings.behavior?.quickLaunch ?? DEFAULT_QUICK_LAUNCH_ITEMS)
          .map(resolve)
          .filter((item): item is ResolvedQuickLaunchItem => item !== null)
      : [];

  const launch = async (item: ResolvedQuickLaunchItem): Promise<void> => {
    if (!pathId) return;
    try {
      const dims = state.lastTerminalDims;
      const res = await window.api.invoke<unknown, CreateSessionResponse>(
        COMMAND_CHANNELS.SESSION_CREATE,
        {
          pathId,
          templateId: item.templateId,
          ...(item.shellId ? { shellId: item.shellId } : {}),
          ...(isSshPath ? { sshTmuxMode: 'disabled' } : {}),
          cols: dims.cols,
          rows: dims.rows,
        },
      );
      dispatch({ type: 'view/select-session', sessionId: res.session.id });
      if (res.warning) toast.push({ kind: 'warn', message: tx(res.warning, res.warning) });
      focusTerminalDom();
    } catch (err) {
      console.error(
        `[QuickLaunch] create-session failed: pathId=${pathId} template=${item.templateId} shell=${item.shellId ?? '-'}`,
        err,
      );
      // 启动失败也把焦点还给终端,否则焦点停在被点的按钮上
      focusTerminalDom();
      const reason = err instanceof Error ? err.message : String(err);
      toast.push({
        kind: 'error',
        message: tx(`新建终端失败:${reason}`, `Failed to create terminal: ${reason}`),
      });
    }
  };

  return { ready, items, launch };
}
