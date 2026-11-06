/**
 * @file src/renderer/components/TagEditor.tsx
 * @purpose Dialog for a folder's tags: click a tag to toggle it, or type a new one.
 *
 * @关键设计:
 * - Every change saves at once, so there is no save button (设置即改即生效 applies here too).
 * - The tags shown come from the live tree, so another window's edit appears straight away.
 * - Rendered in a portal: PathItem sits inside a draggable, clickable sidebar row.
 * - A typed tag reuses an existing spelling, so "paper" joins "Paper" rather than splitting it.
 *
 * @对应文档章节: 软件定义书.md ADR-015
 */
import { useMemo, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { COMMAND_CHANNELS, type SetBookmarkTagsPayload } from '@shared/protocol';
import { countTags, normalizeTags } from '@shared/path-tags';
import { findPathNode, useAppState } from '../store';
import { useTranslation } from './LanguageProvider';
import { useToast } from './Toast';

export function TagEditor({
  pathId,
  title,
  onClose,
}: {
  pathId: string;
  title: string;
  onClose: () => void;
}): JSX.Element {
  const state = useAppState();
  const { tx } = useTranslation();
  const toast = useToast();
  const [draft, setDraft] = useState('');
  const tags = findPathNode(state.pathTree, pathId)?.tags ?? [];
  const known = useMemo(
    () => countTags([...state.pathTree.bookmarks]).map((c) => c.name),
    [state.pathTree.bookmarks],
  );
  const shown = [...new Set([...known, ...tags])].sort((a, b) => a.localeCompare(b));

  const save = (next: string[]): void => {
    const payload: SetBookmarkTagsPayload = { pathId, tags: normalizeTags(next) };
    window.api.invoke(COMMAND_CHANNELS.BOOKMARK_SET_TAGS, payload).catch((err: unknown) => {
      toast.push({
        kind: 'error',
        message: tx('保存标签失败:', 'Could not save tags: ') + String(err),
      });
    });
  };

  const toggle = (tag: string): void => {
    save(tags.includes(tag) ? tags.filter((x) => x !== tag) : [...tags, tag]);
  };

  const addDraft = (): void => {
    const [typed] = normalizeTags([draft]);
    setDraft('');
    if (!typed) return;
    const existing = shown.find((tag) => tag.toLowerCase() === typed.toLowerCase());
    save([...tags, existing ?? typed]);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') addDraft();
    if (e.key === 'Escape') onClose();
  };

  return createPortal(
    <div className="app-modal-backdrop" role="presentation">
      <div className="app-modal-panel tag-editor" role="dialog" aria-label={title}>
        <div className="app-modal-title">{title}</div>
        {shown.length > 0 && (
          <div className="tag-editor-list">
            {shown.map((tag) => (
              <button
                key={tag}
                type="button"
                className={`tag-chip${tags.includes(tag) ? ' active' : ''}`}
                aria-pressed={tags.includes(tag)}
                onClick={() => toggle(tag)}
              >
                {tag}
              </button>
            ))}
          </div>
        )}
        <input
          className="app-modal-input"
          autoFocus
          value={draft}
          placeholder={tx('输入新标签,按回车添加', 'Type a new tag and press Enter')}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="app-modal-actions">
          <button
            type="button"
            className="app-modal-button app-modal-button-primary"
            onClick={() => {
              addDraft();
              onClose();
            }}
          >
            {tx('完成', 'Done')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
