/**
 * @file src/renderer/components/QuickLaunchSettings.tsx
 * @purpose 设置 → 行为 里的快捷启动编辑器。勾选右键 + 号时要显示的选项,
 *   候选项与新建页相同:启动模板和检测到的 shell。
 *
 * @关键设计:
 * - 即改即生效,没有保存按钮 (软件定义书 13.2)。
 * - 已删除的模板或已卸载的 shell 仍占名额,所以要显示出来让用户能取消勾选。
 *   不自动清理:列 shell 失败时会误删有效选项。
 */
import { useEffect, useState } from 'react';
import { COMMAND_CHANNELS, type ListShellsResponse } from '@shared/protocol';
import {
  DEFAULT_QUICK_LAUNCH_ITEMS,
  QUICK_LAUNCH_MAX_ITEMS,
  quickLaunchItemKey,
  toggleQuickLaunchItem,
  type QuickLaunchItem,
} from '@shared/quick-launch';
import { useAppState } from '../store';
import { useTranslation } from './LanguageProvider';
import type { DetectedShell } from './launch-options';

interface Props {
  onChange: (items: QuickLaunchItem[]) => void;
}

export function QuickLaunchSettings({ onChange }: Props): JSX.Element {
  const { tx } = useTranslation();
  const state = useAppState();
  const [shells, setShells] = useState<DetectedShell[]>([]);
  const selected = state.settings.behavior?.quickLaunch ?? [...DEFAULT_QUICK_LAUNCH_ITEMS];
  const selectedKeys = new Set(selected.map(quickLaunchItemKey));

  useEffect(() => {
    let cancelled = false;
    window.api
      .invoke<unknown, ListShellsResponse>(COMMAND_CHANNELS.SETTINGS_LIST_SHELLS, {})
      .then((res) => {
        if (!cancelled) setShells(res.shells);
      })
      .catch((err) => {
        console.warn('[QuickLaunchSettings] list-shells failed', err);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const candidates: Array<{ item: QuickLaunchItem; label: string }> = [
    ...state.templates.map((t) => ({
      item: { kind: 'template', id: t.id } as const,
      label: t.name,
    })),
    ...shells.map((s) => ({
      item: { kind: 'shell', id: s.id } as const,
      label: s.displayName,
    })),
  ];
  const known = new Set(candidates.map(({ item }) => quickLaunchItemKey(item)));
  const unavailable = selected
    .filter((item) => !known.has(quickLaunchItemKey(item)))
    .map((item) => ({ item, label: `${item.id} ${tx('(不可用)', '(unavailable)')}` }));

  return (
    <div className="quick-launch-settings">
      {[...candidates, ...unavailable].map(({ item, label }) => {
        const key = quickLaunchItemKey(item);
        const checked = selectedKeys.has(key);
        return (
          <label key={key} className="settings-checkbox">
            <input
              type="checkbox"
              checked={checked}
              disabled={!checked && selected.length >= QUICK_LAUNCH_MAX_ITEMS}
              onChange={() => onChange(toggleQuickLaunchItem(selected, item))}
            />
            {label}
          </label>
        );
      })}
      {selected.length >= QUICK_LAUNCH_MAX_ITEMS && (
        <p className="quick-launch-settings-hint">
          {tx(`最多 ${QUICK_LAUNCH_MAX_ITEMS} 项`, `Up to ${QUICK_LAUNCH_MAX_ITEMS} items`)}
        </p>
      )}
    </div>
  );
}
