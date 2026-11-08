/**
 * @file src/renderer/components/TextFileView.tsx
 * @purpose Shows a .txt, .json or .tex file in the file viewer, and a Markdown file once the user
 *   switches it to editing. Small files can be edited and saved. Very large files open as
 *   read-only pages.
 *
 * @关键设计:
 * - The size decides: up to TEXT_EDIT_MAX_BYTES the file loads whole into a textarea. A larger
 *   file would freeze a textarea, so only one page of it is ever in memory. This is what lets
 *   a file of several gigabytes open at once, over Link too.
 * - The first read always takes a single page, so the size is known before anything large moves.
 * - Saving is a button only: an in-app Ctrl+S is on the 13.2 list.
 * - Unsaved text lives in text-drafts.ts, so this component can unmount at any time.
 * - SSH tabs are read-only, because the SFTP tree is. A Link window edits: the host does the save.
 *
 * @对应文档章节: 软件定义书.md 14.6, ADR-016, ADR-028
 *
 * @不要在这里做的事:
 * - 不要把格式、高亮这类功能加进来:这里只为顺手改一下文本,不是 IDE
 * - 不要改写用户没动过的内容:换行和 BOM 的还原见 text-file.ts
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  COMMAND_CHANNELS,
  type LinkConnectionStatePayload,
} from '@shared/protocol';
import type {
  ReadPdfFailure,
  WriteTextFailure,
  WriteTextPayload,
  WriteTextResponse,
} from '@shared/file-tree';
import {
  decodeTextFile,
  decodeTextPage,
  detectTextEncoding,
  encodeBase64,
  encodeTextFile,
  jsonProblem,
  normalizeNewlines,
  pageOffset,
  TEXT_EDIT_MAX_BYTES,
  TEXT_PAGE_BYTES,
  TEXT_WRITE_MAX_BYTES,
  type DecodedText,
  type TextEncodingName,
} from '@shared/text-file';
import { readTextRange, type PdfSource } from '../pdf-view-store';
import {
  clearTextDraft,
  getTextDraft,
  setTextDraft,
  type TextStamp,
} from '../text-drafts';
import { useTranslation } from './LanguageProvider';

type TxFn = ReturnType<typeof useTranslation>['tx'];

/** The tree's error strings talk about folders, which would mislead after a failed save. */
function saveFailureText(reason: WriteTextFailure, tx: TxFn): string {
  switch (reason) {
    case 'denied':
      return tx('无法保存:文件被占用或只读', 'Could not save: the file is in use or read-only');
    case 'not-found':
      return tx('无法保存:文件已不存在', 'Could not save: the file no longer exists');
    case 'too-large':
      return tx('无法保存:超过 4 MB', 'Could not save: this is over 4 MB');
    default:
      return tx('保存失败,详情见日志', 'Save failed. See the log for details');
  }
}

/** Reads of a small file. Bigger than a page, as a slow Link pays per round trip. */
const LOAD_CHUNK_BYTES = 1024 * 1024;
const PAGE_DEBOUNCE_MS = 120;
const JSON_CHECK_DELAY_MS = 300;

type Loaded =
  | { mode: 'loading' }
  | { mode: 'error'; reason: ReadPdfFailure }
  | { mode: 'edit'; decoded: DecodedText; stamp: TextStamp | null; draftKey: string }
  | {
      mode: 'pages';
      size: number;
      encoding: TextEncodingName;
      firstPage: Uint8Array;
    };

/** Where each open large file was left, so switching tabs and back keeps the place. */
const pagePositions = new Map<string, number>();

/** Key of a file's unsaved draft. PdfOverlay uses it to preview Markdown edits before saving. */
export async function draftKeyOf(source: PdfSource): Promise<string> {
  const link = await window.api
    .invoke<undefined, LinkConnectionStatePayload | null>(
      COMMAND_CHANNELS.LINK_GET_WINDOW_STATE,
      undefined,
    )
    .catch(() => null);
  return `${link?.address ?? 'local'}|${source.path}`;
}

/** Reads the file, or just its first page when it is too large to load. */
async function loadFile(source: PdfSource): Promise<Loaded> {
  const first = await readTextRange(source, 0, TEXT_PAGE_BYTES);
  if (!first.ok) return { mode: 'error', reason: first.reason };
  if (first.size > TEXT_EDIT_MAX_BYTES) {
    return {
      mode: 'pages',
      size: first.size,
      encoding: detectTextEncoding(first.bytes),
      firstPage: first.bytes,
    };
  }
  const parts = [first.bytes];
  let offset = first.bytes.length;
  while (offset < first.size) {
    const next = await readTextRange(source, offset, LOAD_CHUNK_BYTES);
    if (!next.ok) return { mode: 'error', reason: next.reason };
    // A file changing under the read would give a mix of two versions, which a save
    // would then write back as if it were the user's text.
    if (next.size !== first.size || next.mtimeMs !== first.mtimeMs || next.bytes.length === 0) {
      return { mode: 'error', reason: 'unknown' };
    }
    parts.push(next.bytes);
    offset += next.bytes.length;
  }
  const bytes = new Uint8Array(offset);
  let at = 0;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.length;
  }
  return {
    mode: 'edit',
    decoded: decodeTextFile(bytes),
    stamp: first.mtimeMs === null ? null : { mtimeMs: first.mtimeMs, size: first.size },
    draftKey: await draftKeyOf(source),
  };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function TextFileView({ source }: { source: PdfSource }): JSX.Element {
  const { t, tx } = useTranslation();
  const [loaded, setLoaded] = useState<Loaded>({ mode: 'loading' });
  const [loadCount, setLoadCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoaded({ mode: 'loading' });
    loadFile(source)
      .catch((): Loaded => ({ mode: 'error', reason: 'unknown' }))
      .then((result) => {
        if (!cancelled) setLoaded(result);
      });
    return () => {
      cancelled = true;
    };
  }, [source, loadCount]);

  const reload = useCallback(() => setLoadCount((n) => n + 1), []);

  if (loaded.mode === 'loading') {
    return <p className="pdf-overlay-status">{tx('正在打开…', 'Opening…')}</p>;
  }
  if (loaded.mode === 'error') {
    return <p className="pdf-overlay-status">{t(`fileTree.error.${loaded.reason}`)}</p>;
  }
  if (loaded.mode === 'pages') {
    return (
      <TextPages
        key={loadCount}
        source={source}
        size={loaded.size}
        encoding={loaded.encoding}
        firstPage={loaded.firstPage}
        onReload={reload}
      />
    );
  }
  return (
    <TextEditor
      key={loadCount}
      source={source}
      decoded={loaded.decoded}
      stamp={loaded.stamp}
      draftKey={loaded.draftKey}
      onReload={reload}
    />
  );
}

interface TextEditorProps {
  source: PdfSource;
  decoded: DecodedText;
  /** Null when the file came over SFTP, which is read-only. */
  stamp: TextStamp | null;
  draftKey: string;
  onReload: () => void;
}

type SaveState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved' }
  | { kind: 'conflict' }
  | { kind: 'error'; message: string };

function TextEditor({ source, decoded, stamp, draftKey, onReload }: TextEditorProps): JSX.Element {
  const { tx } = useTranslation();
  const onDisk = useMemo(() => normalizeNewlines(decoded.text), [decoded.text]);
  const editable = decoded.editable && stamp !== null;
  // A draft keeps the state it was edited from. If the file moved on since, the first save
  // reports the conflict, rather than quietly replacing a version the user never saw.
  const [draft] = useState(() => (editable ? getTextDraft(draftKey) : null));
  const [value, setValue] = useState(draft?.value ?? onDisk);
  const [saved, setSaved] = useState(onDisk);
  const [base, setBase] = useState<TextStamp | null>(draft?.base ?? stamp);
  const [save, setSave] = useState<SaveState>({ kind: 'idle' });
  const [problem, setProblem] = useState<string | null>(null);
  const dirty = value !== saved;
  const isJson = /\.json$/i.test(source.name);

  useEffect(() => {
    if (!editable || !base) return;
    if (dirty) setTextDraft(draftKey, { value, base });
    else clearTextDraft(draftKey);
  }, [editable, dirty, value, base, draftKey]);

  useEffect(() => {
    if (!isJson) return;
    const timer = window.setTimeout(() => setProblem(jsonProblem(value)), JSON_CHECK_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [isJson, value]);

  const write = async (expected: TextStamp | null): Promise<void> => {
    const bytes = encodeTextFile(value, decoded);
    if (bytes.length > TEXT_WRITE_MAX_BYTES) {
      setSave({ kind: 'error', message: saveFailureText('too-large', tx) });
      return;
    }
    setSave({ kind: 'saving' });
    const res = await window.api
      .invoke<WriteTextPayload, WriteTextResponse>(COMMAND_CHANNELS.FS_WRITE_TEXT, {
        path: source.path,
        base64: encodeBase64(bytes),
        expected,
      })
      .catch((): WriteTextResponse => ({ ok: false, reason: 'unknown' }));
    if (res.ok) {
      setBase({ mtimeMs: res.mtimeMs, size: res.size });
      setSaved(value);
      setSave({ kind: 'saved' });
    } else if (res.reason === 'changed') {
      setSave({ kind: 'conflict' });
    } else {
      setSave({ kind: 'error', message: saveFailureText(res.reason, tx) });
    }
  };

  const discard = (): void => {
    clearTextDraft(draftKey);
    onReload();
  };

  const status = !editable
    ? stamp === null
      ? tx('SSH 文件只读', 'SSH files are read-only')
      : tx(
          `只读:编码是 ${decoded.encoding},保存会改变文件`,
          `Read-only: this file is ${decoded.encoding}, and saving would change that`,
        )
    : save.kind === 'conflict'
      ? tx('文件已被其他程序改动', 'Another program changed this file')
      : save.kind === 'error'
        ? save.message
        : save.kind === 'saving'
          ? tx('正在保存…', 'Saving…')
          : dirty
            ? tx('未保存', 'Unsaved')
            : save.kind === 'saved'
              ? tx('已保存', 'Saved')
              : '';

  return (
    <div className="text-view">
      <div className="text-view-bar">
        <span
          className={`text-view-status${save.kind === 'conflict' || save.kind === 'error' ? ' alert' : ''}`}
          title={status}
        >
          {status}
        </span>
        {problem !== null && (
          <span className="text-view-status alert" title={problem}>
            {tx('JSON 有语法错误', 'Invalid JSON')}
          </span>
        )}
        {save.kind === 'conflict' ? (
          <>
            <button type="button" className="text-view-btn" onClick={discard}>
              {tx('放弃我的修改', 'Discard mine')}
            </button>
            <button type="button" className="text-view-btn primary" onClick={() => void write(null)}>
              {tx('覆盖保存', 'Overwrite')}
            </button>
          </>
        ) : dirty ? (
          <>
            <button type="button" className="text-view-btn" onClick={discard}>
              {tx('放弃修改', 'Discard')}
            </button>
            <button
              type="button"
              className="text-view-btn primary"
              disabled={save.kind === 'saving'}
              onClick={() => void write(base)}
            >
              {tx('保存', 'Save')}
            </button>
          </>
        ) : (
          <button type="button" className="text-view-btn" onClick={onReload}>
            {tx('重新载入', 'Reload')}
          </button>
        )}
      </div>
      <textarea
        className="text-view-editor"
        value={value}
        readOnly={!editable}
        spellCheck={false}
        aria-label={source.name}
        onChange={(e) => {
          setValue(e.target.value);
          if (save.kind !== 'saving') setSave({ kind: 'idle' });
        }}
      />
    </div>
  );
}

interface TextPagesProps {
  source: PdfSource;
  size: number;
  encoding: TextEncodingName;
  firstPage: Uint8Array;
  onReload: () => void;
}

function TextPages({ source, size, encoding, firstPage, onReload }: TextPagesProps): JSX.Element {
  const { t, tx } = useTranslation();
  const [offset, setOffset] = useState(() =>
    pageOffset(pagePositions.get(source.path) ?? 0, size),
  );
  const [text, setText] = useState(() => decodeTextPage(firstPage, 0, size, encoding));
  const [failure, setFailure] = useState<ReadPdfFailure | null>(null);
  const [loading, setLoading] = useState(false);
  const pageRef = useRef<HTMLPreElement>(null);
  const shownOffset = useRef(0);
  const last = pageOffset(size - 1, size);

  useEffect(() => {
    pagePositions.set(source.path, offset);
    if (offset === shownOffset.current) return;
    let cancelled = false;
    setLoading(true);
    // Dragging the slider passes many pages. Only the one it stops on is worth reading.
    const timer = window.setTimeout(() => {
      readTextRange(source, offset, TEXT_PAGE_BYTES)
        .then((res) => {
          if (cancelled) return;
          setLoading(false);
          if (!res.ok) {
            setFailure(res.reason);
            return;
          }
          setFailure(null);
          shownOffset.current = offset;
          setText(decodeTextPage(res.bytes, offset, res.size, encoding));
          pageRef.current?.scrollTo(0, 0);
        })
        .catch(() => {
          if (!cancelled) setFailure('unknown');
        });
    }, PAGE_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [offset, size, encoding, source]);

  const end = Math.min(offset + TEXT_PAGE_BYTES, size);
  const previous = tx('上一段', 'Previous');
  const next = tx('下一段', 'Next');

  return (
    <div className="text-view">
      <div className="text-view-bar">
        <span className="text-view-status">
          {failure
            ? t(`fileTree.error.${failure}`)
            : tx('大文件,分段只读', 'Large file, read-only pages')}
        </span>
        <span className="text-view-position">
          {`${formatBytes(offset)} – ${formatBytes(end)} / ${formatBytes(size)}`}
        </span>
        <button type="button" className="text-view-btn" onClick={onReload}>
          {tx('重新载入', 'Reload')}
        </button>
      </div>
      <div className="text-view-pager">
        <button
          type="button"
          className="text-view-btn"
          disabled={offset === 0}
          onClick={() => setOffset(Math.max(0, offset - TEXT_PAGE_BYTES))}
        >
          {previous}
        </button>
        <input
          type="range"
          className="text-view-slider"
          min={0}
          max={last}
          step={TEXT_PAGE_BYTES}
          value={offset}
          aria-label={tx('文件位置', 'Position in file')}
          onChange={(e) => setOffset(pageOffset(Number(e.target.value), size))}
        />
        <button
          type="button"
          className="text-view-btn"
          disabled={offset >= last}
          onClick={() => setOffset(Math.min(last, offset + TEXT_PAGE_BYTES))}
        >
          {next}
        </button>
      </div>
      <pre ref={pageRef} className={`text-view-page${loading ? ' loading' : ''}`}>
        {text}
      </pre>
    </div>
  );
}
