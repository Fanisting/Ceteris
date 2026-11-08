/**
 * @file src/renderer/components/sessionContextMenu.ts
 * @purpose 单一来源 — Tab 右键 / Sidebar session 右键共用的菜单项构造器。
 *   两边的菜单"内容"必须一致(用户明确要求),只有"重命名"的触发 UX 不同
 *   (Tab 走 Modal.prompt,Sidebar 走行内编辑),通过传入 onRename 回调解耦。
 */
import { tx } from '@shared/i18n';
import { COMMAND_CHANNELS } from '@shared/protocol';
import type { PathTree, SessionInfo } from '@shared/types';
import { findPathNode } from '../store';
import type { ContextMenuItem } from './ContextMenu';

export type SessionVariant = 'mine' | 'orphan' | 'other';

export interface SessionMenuDeps {
  variant: SessionVariant;
  pathTree: PathTree;
  copyToClipboard: (text: string, label: string) => void;
  /** 触发重命名 UX。Tab 端走 Modal.prompt;Sidebar 端走行内编辑。 */
  onRename: () => void;
  /** 失败 toast 推送器。给一个统一签名,内部包装 toast.push。 */
  toastError: (msg: string) => void;
}

export function buildSessionContextMenu(
  session: SessionInfo,
  deps: SessionMenuDeps,
): ContextMenuItem[] {
  const { variant, pathTree, copyToClipboard, onRename, toastError } = deps;
  const isOther = variant === 'other';
  // "在 Explorer 中显示" 用 path-tree 节点的真实文件系统路径;节点不存在
  // (临时被 evict / 历史路径被清等)时回退到 session.originalCwd。
  const explorerPath =
    findPathNode(pathTree, session.pathId)?.path || session.originalCwd;

  const invoke = window.api.invoke.bind(window.api);

  return [
    {
      label: '重命名…',
      disabled: isOther,
      ...(isOther ? { hint: '其他窗口持有,无法重命名' } : {}),
      onSelect: onRename,
    },
    {
      // ADR-023:勾选后标签移到标签栏上方的 coordinator 行。任何窗口都能改,
      // 它只决定标签放在哪一行,不动所有权。
      label: tx('协调者', 'Coordinator'),
      hint: tx(
        '标签放到上方单独一行,在任何文件夹都看得到',
        'Puts the tab in a row above, seen from every folder',
      ),
      checked: session.coordinator === true,
      onSelect: () => {
        invoke(COMMAND_CHANNELS.SESSION_SET_COORDINATOR, {
          sessionId: session.id,
          coordinator: session.coordinator !== true,
        }).catch((err: unknown) =>
          toastError(`设置协调者失败:${err instanceof Error ? err.message : String(err)}`),
        );
      },
    },
    {
      label: '复制初始路径',
      onSelect: () => copyToClipboard(session.originalCwd, '初始路径'),
    },
    {
      label: '复制 cwd',
      onSelect: () => copyToClipboard(session.currentCwd, 'cwd'),
    },
    {
      label: `复制 PID${session.pid > 0 ? ` (${session.pid})` : ''}`,
      disabled: session.pid <= 0,
      onSelect: () => copyToClipboard(String(session.pid), 'PID'),
    },
    {
      label: '在 Explorer 中显示',
      onSelect: () => {
        invoke(COMMAND_CHANNELS.SYSTEM_SHOW_IN_EXPLORER, {
          path: explorerPath,
        }).catch((err: unknown) =>
          toastError(
            `打开 Explorer 失败:${err instanceof Error ? err.message : String(err)}`,
          ),
        );
      },
    },
    {
      label: '在新窗口中打开',
      disabled: isOther,
      ...(isOther ? { hint: '其他窗口持有,无法移动' } : {}),
      onSelect: () => {
        invoke(COMMAND_CHANNELS.SESSION_OPEN_IN_NEW_WINDOW, {
          sessionId: session.id,
        }).catch((err: unknown) =>
          toastError(
            `打开新窗口失败:${err instanceof Error ? err.message : String(err)}`,
          ),
        );
      },
    },
    {
      label: '在专注模式窗口中打开',
      disabled: isOther,
      ...(isOther ? { hint: '其他窗口持有,无法移动' } : {}),
      onSelect: () => {
        invoke(COMMAND_CHANNELS.SESSION_OPEN_IN_NEW_WINDOW, {
          sessionId: session.id,
          simpleMode: true,
        }).catch((err: unknown) =>
          toastError(
            `打开专注模式窗口失败:${err instanceof Error ? err.message : String(err)}`,
          ),
        );
      },
    },
    { divider: true, label: '' },
    {
      label: '关闭',
      danger: true,
      disabled: isOther,
      onSelect: () => {
        invoke(COMMAND_CHANNELS.SESSION_CLOSE, {
          sessionId: session.id,
        }).catch((err: unknown) =>
          toastError(
            `关闭失败:${err instanceof Error ? err.message : String(err)}`,
          ),
        );
      },
    },
  ];
}
