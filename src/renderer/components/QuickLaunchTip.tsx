/**
 * @file src/renderer/components/QuickLaunchTip.tsx
 * @purpose 首次使用引导:在标签栏的 + 号下方弹一个小气泡,告诉用户右键 + 号能
 *   一步启动 agent。用户点"知道了"或真的右键过一次 + 号后,永久不再出现。
 *
 * @关键设计:
 * - "看过"存在 settings.behavior.quickLaunchTipSeen,所以所有窗口同时消失,
 *   重启后也不会再弹。不用 localStorage:那是每个窗口 / 每个 dev 数据目录各一份。
 * - 位置跟着 + 号走:+ 号随标签数量左右移动,所以每次渲染和窗口缩放时重新量。
 * - 气泡不挡操作:只有气泡本身吃点击,其余区域照常可点。
 *
 * @对应文档章节: 软件定义书.md 2 (鼠标优先)
 *
 * @不要在这里做的事:
 * - 不要弹成模态框或要求确认 (窗口零成本开关,首启不该被拦住)
 * - 不要加键盘快捷键说明 (13.2 永远不做应用内功能键)
 */
import { useLayoutEffect, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { COMMAND_CHANNELS } from '@shared/protocol';
import { useTranslation } from './LanguageProvider';

interface Props {
  /** 标签栏里的 + 号按钮;气泡对准它的下边缘中点 */
  anchorRef: RefObject<HTMLElement>;
  /** 用来在标签增减后重新量 + 号位置 */
  layoutKey: string;
}

/**
 * 把引导标记为已看过。失败只记日志:最坏情况是下次启动再弹一次,不值得打扰用户。
 */
export function markQuickLaunchTipSeen(): void {
  window.api
    .invoke(COMMAND_CHANNELS.SETTINGS_UPDATE, { partial: { behavior: { quickLaunchTipSeen: true } } })
    .catch((err: unknown) => {
      console.warn('[QuickLaunchTip] failed to save quickLaunchTipSeen', err);
    });
}

export function QuickLaunchTip({ anchorRef, layoutKey }: Props): JSX.Element | null {
  const { tx } = useTranslation();
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  useLayoutEffect(() => {
    const measure = (): void => {
      const el = anchorRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      setPos({ x: rect.left + rect.width / 2, y: rect.bottom });
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [anchorRef, layoutKey]);

  if (!pos) return null;

  // 气泡左边缘不越过窗口:+ 号靠左时箭头仍对准 +,气泡本体往右挪。
  const bubbleLeft = Math.max(8, pos.x - 28);

  return createPortal(
    <div
      className="quick-launch-tip"
      role="note"
      style={{ left: bubbleLeft, top: pos.y + 10, ['--arrow-x' as string]: `${pos.x - bubbleLeft}px` }}
    >
      <p className="quick-launch-tip-title">{tx('右键 + 号,一步启动 agent', 'Right click + to start an agent')}</p>
      <p className="quick-launch-tip-body">
        {tx(
          '会在 + 号右边展开一个扇形的小圆,点一下就在当前文件夹打开 Claude Code、Codex 等。圆里放哪些,在 设置 → 行为 里改。',
          'A fan of circles opens to the right of the +. Click one to open Claude Code, Codex and others in this folder. Pick which ones appear in Settings → Behavior.',
        )}
      </p>
      <button type="button" className="quick-launch-tip-ok" onClick={markQuickLaunchTipSeen}>
        {tx('知道了', 'Got it')}
      </button>
    </div>,
    document.body,
  );
}
