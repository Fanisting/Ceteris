/**
 * @file src/renderer/components/QuickLaunchOverlay.tsx
 * @purpose 右键 + 号时,在它右侧展开一个扇形的小圆,点一下就在当前路径启动对应的
 *   agent 或 shell。可选项在 设置 → 行为 里编辑。
 *
 * @关键设计:
 * - 选项解析和启动在 useQuickLaunch.tsx,与标签栏末尾的幽灵标签共用,规则与新建页相同。
 * - 打开时把焦点移到第一个圆,否则焦点还在 xterm 上,Esc 会被发给 PTY。
 * - 走 overlay 栈,Esc 只关最上层,和 ContextMenu / Modal 一致。
 *
 * @对应文档章节: 软件定义书.md 2 (鼠标优先)
 *
 * @不要在这里做的事:
 * - 不要加键盘快捷键打开它 (13.2 永远不做应用内功能键)
 */
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { radialPositions, type Point } from '@shared/quick-launch';
import { focusTerminalDom } from '../focus';
import { useOverlayRegistration } from '../ui-overlay-stack';
import { useTranslation } from './LanguageProvider';
import { useQuickLaunch, type ResolvedQuickLaunchItem } from './useQuickLaunch';

interface Props {
  pathId: string;
  /** + 号中心,视口坐标 */
  anchor: Point;
  onClose: () => void;
}

export function QuickLaunchOverlay({ pathId, anchor, onClose }: Props): JSX.Element | null {
  const { tx } = useTranslation();
  const { isTop } = useOverlayRegistration(true);
  const { ready, items, launch: launchItem } = useQuickLaunch(pathId, 20);
  const firstItemRef = useRef<HTMLButtonElement | null>(null);

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

  useEffect(() => {
    if (ready) firstItemRef.current?.focus();
  }, [ready]);

  const launch = async (item: ResolvedQuickLaunchItem): Promise<void> => {
    onClose();
    await launchItem(item);
  };

  if (!ready) return null;

  const positions = radialPositions(items.length, anchor, {
    width: window.innerWidth,
    height: window.innerHeight,
  });

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
