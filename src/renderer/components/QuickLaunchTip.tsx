/**
 * @file src/renderer/components/QuickLaunchTip.tsx
 * @purpose 首次使用引导:在标签栏末尾的虚线标签 (GhostTab) 下方弹一个小气泡,告诉用户
 *   点里面的图标能一步启动 agent。用户点"知道了"或真的用它启动过一次后,永久不再出现。
 *
 * @关键设计:
 * - "看过"存在 settings.behavior.quickLaunchTipSeen,所以所有窗口同时消失,
 *   重启后也不会再弹。不用 localStorage:那是每个窗口 / 每个 dev 数据目录各一份。
 * - 位置跟着虚线标签走 (data-guide="ghost-tab";快捷启动列表为空时没有它,就对准
 *   data-guide="new-tab" 的 + 号):它随标签数量左右移动,所以每次渲染和窗口缩放时重新量。
 * - 气泡不挡操作:只有气泡本身吃点击,其余区域照常可点。
 *
 * @对应文档章节: 软件定义书.md 2 (鼠标优先)
 *
 * @不要在这里做的事:
 * - 不要弹成模态框或要求确认 (窗口零成本开关,首启不该被拦住)
 * - 不要加键盘快捷键说明 (13.2 永远不做应用内功能键)
 */
import { useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { COMMAND_CHANNELS } from '@shared/protocol';
import { useTranslation } from './LanguageProvider';

interface Props {
  /** 用来在标签增减后重新量虚线标签的位置 */
  layoutKey: string;
}

/** 气泡对准的元素:虚线标签,没有时退回 + 号 */
function tipAnchor(): Element | null {
  return (
    document.querySelector('[data-guide="ghost-tab"]') ??
    document.querySelector('[data-guide="new-tab"]')
  );
}

/**
 * 把引导标记为已看过。失败只记日志:最坏情况是下次启动再弹一次,不值得打扰用户。
 */
export function markQuickLaunchTipSeen(): void {
  window.api
    .invoke(COMMAND_CHANNELS.SETTINGS_UPDATE, {
      partial: { behavior: { quickLaunchTipSeen: true } },
    })
    .catch((err: unknown) => {
      console.warn('[QuickLaunchTip] failed to save quickLaunchTipSeen', err);
    });
}

export function QuickLaunchTip({ layoutKey }: Props): JSX.Element | null {
  const { tx } = useTranslation();
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  useLayoutEffect(() => {
    const measure = (): void => {
      const el = tipAnchor();
      if (!el) return;
      const rect = el.getBoundingClientRect();
      setPos({ x: rect.left + rect.width / 2, y: rect.bottom });
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [layoutKey]);

  if (!pos) return null;

  // 气泡左边缘不越过窗口:目标靠左时箭头仍对准它,气泡本体往右挪。
  const bubbleLeft = Math.max(8, pos.x - 28);

  return createPortal(
    <div
      className="quick-launch-tip"
      role="note"
      style={{
        left: bubbleLeft,
        top: pos.y + 10,
        ['--arrow-x' as string]: `${pos.x - bubbleLeft}px`,
      }}
    >
      <p className="quick-launch-tip-title">
        {tx(
          '点虚线标签里的图标,一步启动 agent',
          'Click an icon in the dashed tab to start an agent',
        )}
      </p>
      <p className="quick-launch-tip-body">
        {tx(
          '点一下就在当前文件夹打开 Claude Code、Codex 等;最后的 + 照旧打开新建页。放哪些图标,在 设置 → 行为 → 快捷启动 里改。',
          'One click opens Claude Code, Codex and others in this folder; the + at the end still opens the new tab page. Pick the icons in Settings → Behavior → Quick launch.',
        )}
      </p>
      <button type="button" className="quick-launch-tip-ok" onClick={markQuickLaunchTipSeen}>
        {tx('知道了', 'Got it')}
      </button>
    </div>,
    document.body,
  );
}
