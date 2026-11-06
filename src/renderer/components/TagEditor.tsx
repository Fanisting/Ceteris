/**
 * @file src/renderer/components/TagEditor.tsx
 * @purpose The tag dialogs and the coloured dot. TagEditor sets a folder's tags;
 *   TagSettings recolours, renames or deletes one tag everywhere.
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
import { TAG_COLORS, countTags, normalizeTags, tagColorHex } from '@shared/path-tags';
import { findPathNode, useAppState } from '../store';
import { useTranslation } from './LanguageProvider';
import { useModal } from './Modal';
import { useToast } from './Toast';

/** A tag's coloured dot. */
export function TagDot({ tag }: { tag: string }): JSX.Element {
  const { tagColors } = useAppState().pathTree;
  return <span className="tag-dot" style={{ backgroundColor: tagColorHex(tag, tagColors) }} />;
}

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
                <TagDot tag={tag} />
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

/**
 * Manages one tag across all folders. Colour applies at once. The name applies on Enter or
 * 完成, because a half typed name would otherwise rename the tag on every folder.
 */
export function TagSettings({ tag, onClose }: { tag: string; onClose: () => void }): JSX.Element {
  const state = useAppState();
  const { tx } = useTranslation();
  const toast = useToast();
  const modal = useModal();
  const [name, setName] = useState(tag);
  const current = tagColorHex(tag, state.pathTree.tagColors);

  const send = (channel: string, payload: unknown): Promise<unknown> =>
    window.api.invoke(channel, payload).catch((err: unknown) => {
      toast.push({
        kind: 'error',
        message: tx('修改标签失败:', 'Could not change the tag: ') + String(err),
      });
    });

  const finish = (): void => {
    const [typed] = normalizeTags([name]);
    if (typed && typed !== tag) {
      void send(COMMAND_CHANNELS.BOOKMARK_RENAME_TAG, { tag, newName: typed });
    }
    onClose();
  };

  const remove = async (): Promise<void> => {
    const ok = await modal.confirm({
      title: tx(`删除标签 ${tag}`, `Delete tag ${tag}`),
      message: tx(
        '这个标签会从所有文件夹上移除。文件夹本身不受影响。',
        'This removes the tag from every folder. The folders themselves stay.',
      ),
      danger: true,
    });
    if (!ok) return;
    void send(COMMAND_CHANNELS.BOOKMARK_DELETE_TAG, { tag });
    onClose();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') finish();
    if (e.key === 'Escape') onClose();
  };

  return createPortal(
    <div className="app-modal-backdrop" role="presentation">
      <div className="app-modal-panel tag-editor tag-settings" role="dialog" aria-label={tag}>
        <div className="app-modal-title">{tx(`标签 ${tag}`, `Tag ${tag}`)}</div>
        <div className="tag-palette" role="group" aria-label={tx('颜色', 'Colour')}>
          {TAG_COLORS.map((color) => (
            <button
              key={color.id}
              type="button"
              className={`tag-swatch${color.hex === current ? ' active' : ''}`}
              style={{ backgroundColor: color.hex }}
              aria-label={color.id}
              aria-pressed={color.hex === current}
              onClick={() =>
                void send(COMMAND_CHANNELS.BOOKMARK_SET_TAG_COLOR, { tag, color: color.id })
              }
            />
          ))}
        </div>
        <input
          className="app-modal-input"
          value={name}
          aria-label={tx('标签名', 'Tag name')}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="app-modal-actions">
          <button type="button" className="app-modal-button tag-delete" onClick={() => void remove()}>
            {tx('删除标签', 'Delete tag')}
          </button>
          <button
            type="button"
            className="app-modal-button app-modal-button-primary"
            onClick={finish}
          >
            {tx('完成', 'Done')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
