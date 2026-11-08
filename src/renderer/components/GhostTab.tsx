/**
 * @file src/renderer/components/GhostTab.tsx
 * @purpose 标签栏末尾的"幽灵标签":虚线框里放快捷启动的 agent 图标,点一下就在当前路径
 *   新开那个 agent 的标签;框的最后是原来的 + 按钮(左键新建页,右键扇形)。
 *
 * @关键设计:
 * - 选项和启动走 useQuickLaunch,与右键扇形共用,在 设置 → 行为 的快捷启动里编辑。
 * - 没有可启动的选项时(没选中路径、列表为空、shell 列表还没取回)不画虚线框,
 *   只留 + 按钮,和以前一样。
 * - 整个框不参与标签的等比压缩,标签多时先压缩真正的标签。
 *
 * @对应文档章节: 软件定义书.md 2 (鼠标优先)
 *
 * @不要在这里做的事:
 * - 不要加键盘快捷键 (13.2 永远不做应用内功能键)
 */
import type { ReactNode } from 'react';
import { useTranslation } from './LanguageProvider';
import { useQuickLaunch } from './useQuickLaunch';

export function GhostTab({
  pathId,
  children,
}: {
  /** 新标签打开的路径,即当前选中的路径 */
  pathId: string | null;
  /** 原来的 + 按钮 */
  children: ReactNode;
}): JSX.Element {
  const { tx } = useTranslation();
  const { items, launch } = useQuickLaunch(pathId, 16);

  if (items.length === 0) return <>{children}</>;

  return (
    <div className="tab-ghost" role="group" aria-label={tx('新建标签', 'New tab')}>
      {items.map((item) => {
        const label = tx(`新建 ${item.label} 标签`, `New ${item.label} tab`);
        return (
          <button
            key={item.key}
            type="button"
            className="tab-ghost-item"
            title={label}
            aria-label={label}
            onClick={() => void launch(item)}
          >
            {item.icon}
          </button>
        );
      })}
      {children}
    </div>
  );
}
