/**
 * @file src/renderer/components/QuickLaunchOverlay.tsx
 * @purpose 右键 + 号时,在它右下方展开一个扇形的小圆,点一下就在当前路径启动对应的
 *   agent 或 shell。可选项在 设置 → 行为 里编辑。
 *
 * @关键设计:
 * - 启动参数与新建页完全一致:SSH 路径不传 shell,WSL 路径用该发行版的 shell,
 *   所以这里过滤选项的规则也要和 MainPane 的 EmptyPathState 保持相同。
 * - 打开时把焦点移到第一个圆,否则焦点还在 xterm 上,Esc 会被发给 PTY。
 * - 走 overlay 栈,Esc 只关最上层,和 ContextMenu / Modal 一致。
 *
 * @对应文档章节: 软件定义书.md 2 (鼠标优先)
 *
 * @不要在这里做的事:
 * - 不要加键盘快捷键打开它 (13.2 永远不做应用内功能键)
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  COMMAND_CHANNELS,
  type CreateSessionResponse,
  type ListShellsResponse,
} from '@shared/protocol';
import {
  DEFAULT_QUICK_LAUNCH_ITEMS,
  quickLaunchItemKey,
  radialPositions,
  type Point,
  type QuickLaunchItem,
} from '@shared/quick-launch';
import { focusTerminalDom } from '../focus';
import { findPathNode, useAppDispatch, useAppState } from '../store';
import { useOverlayRegistration } from '../ui-overlay-stack';
import { Icon } from './icons';
import { useTranslation } from './LanguageProvider';
import { filterShellsForWslPath, getWslDistroName, shellIcon, type DetectedShell } from './launch-options';
import { TemplateIcon } from './TemplateIcon';
import { useToast } from './Toast';

interface ResolvedItem {
  key: string;
  label: string;
  icon: ReactNode;
  templateId: string;
  shellId: string | undefined;
}

interface Props {
  pathId: string;
  /** + 号中心,视口坐标 */
  anchor: Point;
  onClose: () => void;
}

export function QuickLaunchOverlay({ pathId, anchor, onClose }: Props): JSX.Element | null {
  const { tx } = useTranslation();
  const state = useAppState();
  const dispatch = useAppDispatch();
  const toast = useToast();
  const { isTop } = useOverlayRegistration(true);
  const [shells, setShells] = useState<DetectedShell[] | null>(null);
  const firstItemRef = useRef<HTMLButtonElement | null>(null);

  const node = findPathNode(state.pathTree, pathId);
  const isSshPath = node?.kind === 'ssh';
  const wslDistroName = node ? getWslDistroName(node.path) : null;

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

  const close = (): void => {
    onClose();
    focusTerminalDom();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || !isTop()) return;
      e.preventDefault();
      close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // close 只依赖稳定的 onClose,这里不随渲染重新订阅
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isTop]);

  const visibleShells = shells ? filterShellsForWslPath(shells, wslDistroName) : null;
  const wslShellId = wslDistroName ? visibleShells?.[0]?.id : undefined;

  const resolve = (item: QuickLaunchItem): ResolvedItem | null => {
    const key = quickLaunchItemKey(item);
    if (item.kind === 'template') {
      // 新建页在 WSL 路径没有可用 shell 时隐藏全部模板,这里保持一致
      if (wslDistroName && !wslShellId) return null;
      const template = state.templates.find((t) => t.id === item.id);
      if (!template) return null;
      return {
        key,
        label: template.name,
        icon: <TemplateIcon template={template} size={20} />,
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
      icon: <Icon name={shellIcon(shell.id)} size={20} />,
      templateId: 'shell',
      shellId: shell.id,
    };
  };

  const items = (state.settings.behavior?.quickLaunch ?? DEFAULT_QUICK_LAUNCH_ITEMS)
    .map(resolve)
    .filter((item): item is ResolvedItem => item !== null);
  const ready = shells !== null;

  useEffect(() => {
    if (ready) firstItemRef.current?.focus();
  }, [ready]);

  const launch = async (item: ResolvedItem): Promise<void> => {
    onClose();
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
      console.error('[QuickLaunch] create-session failed', err);
      // 覆盖层关闭时带走了焦点,启动失败也要还给终端
      focusTerminalDom();
      const reason = err instanceof Error ? err.message : String(err);
      toast.push({
        kind: 'error',
        message: tx(`新建终端失败:${reason}`, `Failed to create terminal: ${reason}`),
      });
    }
  };

  if (!ready) return null;

  const positions = radialPositions(items.length, anchor, window.innerWidth);

  return createPortal(
    <div
      className="quick-launch-backdrop"
      onClick={close}
      onContextMenu={(e) => {
        e.preventDefault();
        close();
      }}
    >
      {items.length === 0 && (
        <p className="quick-launch-empty" style={{ left: anchor.x, top: anchor.y + 28 }}>
          {tx('没有可用的快捷选项,可在 设置 → 行为 中添加', 'No quick options here. Add some in Settings, Behavior')}
        </p>
      )}
      {items.map((item, i) => {
        const position = positions[i]!;
        return (
          <button
            key={item.key}
            ref={i === 0 ? firstItemRef : undefined}
            type="button"
            className="quick-launch-item"
            style={{
              left: position.x,
              top: position.y,
              // 动画从 + 号飞出到各自位置
              ['--from-x' as string]: `${anchor.x - position.x}px`,
              ['--from-y' as string]: `${anchor.y - position.y}px`,
            }}
            title={item.label}
            onClick={(e) => {
              e.stopPropagation();
              void launch(item);
            }}
          >
            <span className="quick-launch-icon">{item.icon}</span>
            <span className="quick-launch-label">{item.label}</span>
          </button>
        );
      })}
    </div>,
    document.body,
  );
}
