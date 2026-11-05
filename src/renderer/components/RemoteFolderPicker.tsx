/**
 * @file src/renderer/components/RemoteFolderPicker.tsx
 * @purpose 通过 SFTP 浏览远端目录并选择文件夹,对应本地的系统文件夹选择框。
 *
 * @关键设计:
 * - 只点击不输入:路径只能点击 (13.2),键入路径只作为连接失败时的退路。
 * - 从 ~ 开始。main 返回展开后的绝对路径,之后都用绝对路径导航,上一级才算得出来。
 * - 只列文件夹,这里选的是文件夹。
 * - 用 portal 挂到 body:放在侧栏里时,主区会盖住对话框。
 *
 * @对应文档章节: 软件定义书.md 14.6
 *
 * @不要在这里做的事:
 * - 不要自己拼 ~,展开由 main 完成,它知道远端的 home
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { COMMAND_CHANNELS } from '@shared/protocol';
import type { DirFailure, FileTreeEntry, ListDirPayload, ListDirResponse } from '@shared/file-tree';
import { remoteDirname } from '@shared/remote-path';
import type { SshProfile } from '@shared/types';
import { useTranslation } from './LanguageProvider';
import { ChevronRight, Folder } from './material-symbols';

interface RemoteFolderPickerProps {
  profiles: readonly SshProfile[];
  onPick: (profile: SshProfile, path: string) => void;
  /** 连接不上时改用键入路径 */
  onManual: (profile: SshProfile) => void;
  onCancel: () => void;
}

type Listing =
  | { status: 'loading' }
  | { status: 'ready'; path: string; folders: FileTreeEntry[] }
  | { status: 'error'; reason: DirFailure };

export function RemoteFolderPicker({
  profiles,
  onPick,
  onManual,
  onCancel,
}: RemoteFolderPickerProps): JSX.Element {
  const { t, tx } = useTranslation();
  const [profileId, setProfileId] = useState(profiles[0]?.id ?? '');
  const [listing, setListing] = useState<Listing>({ status: 'loading' });
  const panelRef = useRef<HTMLDivElement | null>(null);
  const requestRef = useRef(0);
  const profile = profiles.find((p) => p.id === profileId) ?? profiles[0];

  const open = useCallback((sshProfileId: string, path: string, fresh = false): void => {
    requestRef.current += 1;
    const request = requestRef.current;
    setListing({ status: 'loading' });
    void window.api
      .invoke<ListDirPayload, ListDirResponse>(COMMAND_CHANNELS.FS_LIST_DIR, {
        path,
        sshProfileId,
        fresh,
      })
      .catch((): ListDirResponse => ({ ok: false, reason: 'unknown' }))
      .then((res) => {
        if (request !== requestRef.current) return;
        // 点击的那一行卸载后焦点落到 body,Esc 就失效了
        panelRef.current?.focus();
        setListing(
          res.ok
            ? {
                status: 'ready',
                path: res.path ?? path,
                folders: res.entries.filter((e) => e.isDirectory),
              }
            : { status: 'error', reason: res.reason },
        );
      });
  }, []);

  useEffect(() => {
    panelRef.current?.focus();
    // 打开选择框是用户主动操作,比如刚在终端接受完主机密钥,这时要立刻重试
    if (profileId) open(profileId, '~', true);
  }, [profileId, open]);

  const ready = listing.status === 'ready' ? listing : null;

  return createPortal(
    <div className="app-modal-backdrop" role="presentation">
      <div
        ref={panelRef}
        className="app-modal-panel remote-picker"
        role="dialog"
        aria-modal="true"
        aria-label={tx('选择远程文件夹', 'Choose a remote folder')}
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            onCancel();
          }
        }}
      >
        <div className="app-modal-title">{tx('选择远程文件夹', 'Choose a remote folder')}</div>
        {profiles.length > 1 && (
          <select
            className="remote-picker-server"
            aria-label={tx('服务器', 'Server')}
            value={profileId}
            onChange={(e) => setProfileId(e.target.value)}
          >
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.username}@{p.host})
              </option>
            ))}
          </select>
        )}
        <div className="remote-picker-path">
          <button
            type="button"
            className="remote-picker-up"
            title={tx('上一级', 'Up one level')}
            aria-label={tx('上一级', 'Up one level')}
            disabled={!ready || ready.path === '/'}
            onClick={() => ready && open(profileId, remoteDirname(ready.path))}
          >
            <ChevronRight size={16} className="remote-picker-up-icon" />
          </button>
          <code title={ready?.path}>{ready?.path ?? (profile?.host || '')}</code>
        </div>
        <div className="remote-picker-list">
          {listing.status === 'loading' && (
            <p className="file-tree-hint">{tx('正在连接…', 'Connecting…')}</p>
          )}
          {listing.status === 'error' && (
            <p className="file-tree-hint">{t(`fileTree.error.${listing.reason}`)}</p>
          )}
          {ready?.folders.length === 0 && (
            <p className="file-tree-hint">{tx('没有子文件夹', 'No subfolders')}</p>
          )}
          {ready?.folders.map((folder) => (
            <button
              key={folder.path}
              type="button"
              className="remote-picker-row"
              title={folder.path}
              onClick={() => open(profileId, folder.path)}
            >
              <Folder size={14} />
              <span>{folder.name}</span>
              <ChevronRight size={16} />
            </button>
          ))}
        </div>
        <div className="app-modal-actions">
          {listing.status === 'error' && profile && (
            <button type="button" className="app-modal-button" onClick={() => onManual(profile)}>
              {tx('手动输入路径', 'Type a path')}
            </button>
          )}
          <button type="button" className="app-modal-button" onClick={onCancel}>
            {tx('取消', 'Cancel')}
          </button>
          <button
            type="button"
            className="app-modal-button app-modal-button-primary"
            disabled={!ready || !profile}
            onClick={() => ready && profile && onPick(profile, ready.path)}
          >
            {tx('选择此文件夹', 'Choose this folder')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
