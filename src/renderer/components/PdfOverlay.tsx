/**
 * @file src/renderer/components/PdfOverlay.tsx
 * @purpose Shows a PDF, picture, Markdown or text file for a session. With one terminal on
 *   screen the file sits to its left. In a full pane grid it covers its own pane until closed.
 *   A folder with no terminal shows it over the new tab page in the same way.
 *
 * @关键设计:
 * - TerminalView 始终挂载:卸载它会重建 xterm,PTY 输出和滚动位置都受影响。分屏只靠
 *   CSS (.session-stage-beside),终端宽度变化走它自己的 fit。
 * - PDF 由 PdfJsViewer(pdf.js)渲染,文件更新后换文档保持页码。图片由 ImageView 显示,
 *   打开时适应窗格,标题栏按钮和 Ctrl+滚轮缩放,放大后拖动平移。
 *   markdown 用 markdown-it,html 关闭,原始 HTML 只当文本显示,不会在应用里执行。
 *   链接都交给系统浏览器:在窗口里跟着链接走会把应用页面换掉。
 * - 显示期间 watchPdf 轮询文件,变了自动重读(见 pdf-view-store.ts)。标题栏显示
 *   刷新状态:更新中 / 无法刷新(可点重试)。
 * - 焦点由 focusTerminalDom 统一处理:有 PDF 时它把焦点给关闭按钮,而不是下面的终端。
 * - YAML front matter at the top of a Markdown file renders as a code block (frontMatterAsCode),
 *   so a SKILL.md opened from the skills panel (ADR-053) does not start with a giant heading.
 * - Markdown opens rendered. The header's Edit button swaps in TextFileView on the same file
 *   (ADR-028); Preview swaps back and renders the unsaved draft if there is one, so the user
 *   sees the edit without saving first. A file with an unsaved draft reopens in the editor.
 * - PDF has a Scroll | Slides switch in the same words style. Slides shows one page fitted to
 *   the pane with a thumbnail strip; the header shows the page number with previous and next
 *   buttons, and the zoom buttons hide because the page always fits. The choice is kept per
 *   view key and path in slidesChoices for the life of the window, so switching sessions and
 *   coming back keeps it, while another file starts in Scroll.
 * - A click on the file name copies the name. Text and Markdown files get a copy button right
 *   after the name that copies the contents: the unsaved draft if there is one, otherwise the
 *   file (readTextForCopy). Files too large to edit are not copied. A short note after the
 *   button says what happened; it goes through clipboard.ts, never navigator.clipboard.
 *
 * @对应文档章节: 软件定义书.md 14.6, ADR-028
 *
 * @不要在这里做的事:
 * - 不要给 PDF 和图片加编辑或批注。文本编辑见 TextFileView
 * - 不要加键盘快捷键,缩放只有按钮和 Ctrl+滚轮,编辑和预览只有按钮 (13.2 鼠标优先)
 */
import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import MarkdownIt from 'markdown-it';
import { frontMatterAsCode } from '@shared/agent-skills';
import { fileViewKind } from '@shared/file-tree';
import { COMMAND_CHANNELS } from '@shared/protocol';
import { focusTerminalDom } from '../focus';
import {
  closePdf,
  markPdfShown,
  refreshPdf,
  usePdfView,
  watchPdf,
  type ReadyPdfView,
} from '../pdf-view-store';
import { writeClipboardText } from '../clipboard';
import { getTextDraft } from '../text-drafts';
import { Icon } from './icons';
import { ImageView, type ImageViewHandle } from './ImageView';
import { useTranslation } from './LanguageProvider';
import {
  Check,
  ChevronRight,
  ContentCopy,
  FitWidth,
  Sync,
  ZoomIn,
  ZoomOut,
} from './material-symbols';
import { PdfJsViewer, type PdfJsViewerHandle } from './PdfJsViewer';
import { ShapeLoader } from './ShapeLoader';
import { draftKeyOf, readTextForCopy, TextFileView, type TextForCopy } from './TextFileView';

/** What the last header copy did; shown as a short note after the copy button. */
type CopyNotice = 'name' | 'content' | 'too-large' | 'failed';
const COPY_NOTICE_MS = 1500;

/**
 * How a Markdown file is shown. Tied to a path, so opening another file starts in preview.
 * draft is the unsaved text the preview renders instead of the file on disk.
 */
interface MarkdownMode {
  path: string;
  editing: boolean;
  draft: string | null;
}

/**
 * PDFs the user switched to Slides in this window, as `${viewKey}
${path}`. Module level so
 * the choice survives PdfOverlay unmounting when the user switches sessions.
 */
const slidesChoices = new Set<string>();

const markdown = new MarkdownIt({ html: false, linkify: true });

function MarkdownView({ text }: { text: string }): JSX.Element {
  // Front matter (SKILL.md and many notes) shows as a yaml block, not as one huge heading.
  const html = useMemo(() => markdown.render(frontMatterAsCode(text)), [text]);

  const openLink = (e: MouseEvent<HTMLElement>): void => {
    const link = (e.target as Element).closest('a');
    if (!link) return;
    e.preventDefault();
    if (!/^https?:/i.test(link.href)) return;
    window.api
      .invoke(COMMAND_CHANNELS.SYSTEM_OPEN_EXTERNAL, { url: link.href })
      .catch((err) => console.error('[PdfOverlay] open link failed', err));
  };

  return (
    <div
      className="file-view-markdown"
      onClick={openLink}
      // Safe because raw HTML is off and markdown-it refuses javascript: links.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

/** 标题栏里的刷新状态:更新中,或者失败了可以点重试。没事时什么都不显示。 */
function RefreshBadge({
  viewKey,
  view,
}: {
  viewKey: string;
  view: ReadyPdfView;
}): JSX.Element | null {
  const { t } = useTranslation();
  if (view.refreshing) {
    return (
      <span className="pdf-overlay-badge" aria-live="polite">
        <Sync size={12} className="pdf-overlay-badge-spin" />
        {t('pdf.refreshing')}
      </span>
    );
  }
  if (view.refreshError) {
    return (
      <button
        type="button"
        className="pdf-overlay-badge pdf-overlay-badge-error"
        title={t(`fileTree.error.${view.refreshError}`)}
        onClick={() => void refreshPdf(viewKey, { fresh: true })}
      >
        {t('pdf.refreshFailed')} · {t('pdf.retry')}
      </button>
    );
  }
  return null;
}

export function PdfOverlay({ viewKey }: { viewKey: string }): JSX.Element | null {
  const { t, tx } = useTranslation();
  const view = usePdfView(viewKey);
  const generation = view?.generation;
  const viewerRef = useRef<PdfJsViewerHandle | null>(null);
  const imageRef = useRef<ImageViewHandle | null>(null);
  const [markdownMode, setMarkdownMode] = useState<MarkdownMode | null>(null);
  const [, setSlidesTick] = useState(0);
  const [pageInfo, setPageInfo] = useState<{ page: number; total: number } | null>(null);
  // seq makes a second click restart the timer even when the notice text is the same.
  const [copyNotice, setCopyNotice] = useState<{ notice: CopyNotice; seq: number } | null>(null);
  const source = view?.source;

  useEffect(() => {
    if (!copyNotice) return undefined;
    const timer = window.setTimeout(() => setCopyNotice(null), COPY_NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [copyNotice]);

  // A new file or a reload from scratch must not show the previous file's page numbers.
  useEffect(() => {
    setPageInfo(null);
  }, [generation, viewKey]);

  useEffect(() => {
    if (generation === undefined) return undefined;
    markPdfShown(viewKey);
    focusTerminalDom();
    return watchPdf(viewKey);
  }, [generation, viewKey]);

  // Unsaved Markdown edits must not hide behind the preview: reopen such a file in the editor.
  useEffect(() => {
    if (!source || fileViewKind(source.name) !== 'markdown') return undefined;
    let cancelled = false;
    void draftKeyOf(source).then((key) => {
      if (!cancelled && getTextDraft(key)) {
        setMarkdownMode({ path: source.path, editing: true, draft: null });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [source]);

  if (!view) return null;
  const label = tx('关闭', 'Close');
  const kind = fileViewKind(view.source.name);
  const ready = view.status === 'ready' ? view : null;
  const mode = markdownMode?.path === view.source.path ? markdownMode : null;
  const editingMarkdown = kind === 'markdown' && Boolean(mode?.editing);
  // SSH tabs show the source read-only, so "Edit" would promise too much there.
  const editLabel = view.source.sshProfileId ? tx('源文本', 'Source') : tx('编辑', 'Edit');
  const slidesKey = `${viewKey}
${view.source.path}`;
  const slides = kind === 'pdf' && slidesChoices.has(slidesKey);
  const setSlides = (on: boolean): void => {
    if (on) slidesChoices.add(slidesKey);
    else slidesChoices.delete(slidesKey);
    setSlidesTick((n) => n + 1);
  };

  const showMarkdownPreview = async (): Promise<void> => {
    const viewSource = view.source;
    const draft = getTextDraft(await draftKeyOf(viewSource))?.value ?? null;
    setMarkdownMode({ path: viewSource.path, editing: false, draft });
    // A save in the editor reaches the preview at the next poll; ask now instead of waiting.
    if (draft === null) void refreshPdf(viewKey, { fresh: false });
  };

  const notify = (notice: CopyNotice): void =>
    setCopyNotice((prev) => ({ notice, seq: (prev?.seq ?? 0) + 1 }));

  const copyName = async (): Promise<void> => {
    notify((await writeClipboardText(view.source.name)) ? 'name' : 'failed');
  };

  // Only text kinds have contents worth copying; PDFs and pictures get no button.
  const canCopyContent = ready !== null && (kind === 'text' || kind === 'markdown');
  const copyContent = async (): Promise<void> => {
    const viewSource = view.source;
    // Markdown is already in memory for the preview. An unsaved draft still wins, so the
    // user copies what the editor shows.
    const markdownText = ready?.text ?? null;
    const result: TextForCopy =
      markdownText !== null && !getTextDraft(await draftKeyOf(viewSource))
        ? { ok: true, text: markdownText }
        : await readTextForCopy(viewSource);
    if (!result.ok) {
      notify(result.reason === 'too-large' ? 'too-large' : 'failed');
      return;
    }
    notify((await writeClipboardText(result.text)) ? 'content' : 'failed');
  };

  const noticeText: Record<CopyNotice, string> = {
    name: tx('已复制文件名', 'Name copied'),
    content: tx('已复制内容', 'Contents copied'),
    'too-large': tx('文件太大,无法复制', 'Too large to copy'),
    failed: tx('复制失败', 'Copy failed'),
  };
  const copyLabel = tx('复制内容', 'Copy contents');

  return (
    <section className="pdf-overlay" aria-label={view.source.name}>
      <header className="pdf-overlay-header" title={view.source.path}>
        <button
          type="button"
          className="pdf-overlay-name"
          title={tx(
            `点击复制文件名\n${view.source.path}`,
            `Click to copy the name\n${view.source.path}`,
          )}
          onClick={() => void copyName()}
        >
          {view.source.name}
        </button>
        {canCopyContent && (
          <button
            type="button"
            className="pdf-overlay-tool"
            title={copyLabel}
            aria-label={copyLabel}
            onClick={() => void copyContent()}
          >
            {copyNotice?.notice === 'content' ? <Check size={16} /> : <ContentCopy size={16} />}
          </button>
        )}
        {copyNotice && (
          <span
            className={`pdf-overlay-badge${
              copyNotice.notice === 'too-large' || copyNotice.notice === 'failed'
                ? ' pdf-overlay-badge-warn'
                : ''
            }`}
            aria-live="polite"
          >
            {noticeText[copyNotice.notice]}
          </span>
        )}
        {ready && <RefreshBadge viewKey={viewKey} view={ready} />}
        <span className="pdf-overlay-spacer" />
        {ready && kind === 'pdf' && slides && (
          <span className="pdf-overlay-tools">
            <button
              type="button"
              className="pdf-overlay-tool"
              title={tx('上一页', 'Previous page')}
              aria-label={tx('上一页', 'Previous page')}
              disabled={!pageInfo || pageInfo.page <= 1}
              onClick={() => viewerRef.current?.previousPage()}
            >
              <ChevronRight size={18} className="pdf-overlay-flip" />
            </button>
            <span className="pdf-overlay-page" aria-live="polite">
              {pageInfo ? `${pageInfo.page} / ${pageInfo.total}` : ''}
            </span>
            <button
              type="button"
              className="pdf-overlay-tool"
              title={tx('下一页', 'Next page')}
              aria-label={tx('下一页', 'Next page')}
              disabled={!pageInfo || pageInfo.page >= pageInfo.total}
              onClick={() => viewerRef.current?.nextPage()}
            >
              <ChevronRight size={18} />
            </button>
          </span>
        )}
        {ready && kind === 'pdf' && !slides && (
          <span className="pdf-overlay-tools">
            <button
              type="button"
              className="pdf-overlay-tool"
              title={t('pdf.zoomOut')}
              aria-label={t('pdf.zoomOut')}
              onClick={() => viewerRef.current?.zoomOut()}
            >
              <ZoomOut size={16} />
            </button>
            <button
              type="button"
              className="pdf-overlay-tool"
              title={t('pdf.zoomIn')}
              aria-label={t('pdf.zoomIn')}
              onClick={() => viewerRef.current?.zoomIn()}
            >
              <ZoomIn size={16} />
            </button>
            <button
              type="button"
              className="pdf-overlay-tool"
              title={t('pdf.fitWidth')}
              aria-label={t('pdf.fitWidth')}
              onClick={() => viewerRef.current?.fitWidth()}
            >
              <FitWidth size={16} />
            </button>
          </span>
        )}
        {ready && kind === 'image' && (
          <span className="pdf-overlay-tools">
            <button
              type="button"
              className="pdf-overlay-tool"
              title={t('pdf.zoomOut')}
              aria-label={t('pdf.zoomOut')}
              onClick={() => imageRef.current?.zoomOut()}
            >
              <ZoomOut size={16} />
            </button>
            <button
              type="button"
              className="pdf-overlay-tool"
              title={t('pdf.zoomIn')}
              aria-label={t('pdf.zoomIn')}
              onClick={() => imageRef.current?.zoomIn()}
            >
              <ZoomIn size={16} />
            </button>
            <button
              type="button"
              className="pdf-overlay-tool"
              title={tx('适应窗格', 'Fit to pane')}
              aria-label={tx('适应窗格', 'Fit to pane')}
              onClick={() => imageRef.current?.fit()}
            >
              <FitWidth size={16} />
            </button>
          </span>
        )}
        {ready && kind === 'pdf' && (
          <span className="pdf-overlay-tools" role="group" aria-label={tx('显示方式', 'Show as')}>
            <button
              type="button"
              className={`pdf-overlay-tool pdf-overlay-tool-text${slides ? '' : ' active'}`}
              aria-pressed={!slides}
              onClick={() => setSlides(false)}
            >
              {tx('滚动', 'Scroll')}
            </button>
            <button
              type="button"
              className={`pdf-overlay-tool pdf-overlay-tool-text${slides ? ' active' : ''}`}
              aria-pressed={slides}
              onClick={() => setSlides(true)}
            >
              {tx('幻灯片', 'Slides')}
            </button>
          </span>
        )}
        {ready && kind === 'markdown' && (
          <span className="pdf-overlay-tools" role="group" aria-label={tx('显示方式', 'Show as')}>
            <button
              type="button"
              className={`pdf-overlay-tool pdf-overlay-tool-text${editingMarkdown ? '' : ' active'}`}
              aria-pressed={!editingMarkdown}
              onClick={() => void showMarkdownPreview()}
            >
              {tx('预览', 'Preview')}
            </button>
            <button
              type="button"
              className={`pdf-overlay-tool pdf-overlay-tool-text${editingMarkdown ? ' active' : ''}`}
              aria-pressed={editingMarkdown}
              onClick={() =>
                setMarkdownMode({ path: view.source.path, editing: true, draft: null })
              }
            >
              {editLabel}
            </button>
          </span>
        )}
        <button
          type="button"
          className="pdf-overlay-close"
          title={label}
          aria-label={label}
          onClick={() => {
            closePdf(viewKey);
            focusTerminalDom();
          }}
        >
          <Icon name="close" size={14} />
        </button>
      </header>
      {ready ? (
        kind === 'text' || editingMarkdown ? (
          <TextFileView key={view.generation} source={view.source} />
        ) : ready.text !== null ? (
          <>
            {mode?.draft != null && (
              <div className="text-view-bar">
                <span className="text-view-status">
                  {tx('预览的是未保存的修改', 'Previewing unsaved changes')}
                </span>
              </div>
            )}
            <MarkdownView text={mode?.draft ?? ready.text} />
          </>
        ) : kind === 'image' ? (
          <ImageView
            ref={imageRef}
            key={view.source.path}
            url={ready.url ?? ''}
            name={view.source.name}
          />
        ) : ready.blob ? (
          <div className="pdf-overlay-body">
            <PdfJsViewer
              blob={ready.blob}
              revision={ready.revision}
              name={view.source.name}
              slides={slides}
              onReady={(handle) => {
                viewerRef.current = handle;
              }}
              onPage={(page, total) => setPageInfo({ page, total })}
            />
          </div>
        ) : null
      ) : view.status === 'error' ? (
        <p className="pdf-overlay-status">{t(`fileTree.error.${view.reason}`)}</p>
      ) : (
        <ShapeLoader
          size={48}
          contained
          label={tx('正在打开…', 'Opening…')}
          className="file-view-loading"
        />
      )}
    </section>
  );
}
