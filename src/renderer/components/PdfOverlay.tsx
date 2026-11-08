/**
 * @file src/renderer/components/PdfOverlay.tsx
 * @purpose Shows a PDF, picture, Markdown or text file for a session. With one terminal on
 *   screen the file sits to its left. In a full pane grid it covers its own pane until closed.
 *   A folder with no terminal shows it over the new tab page in the same way.
 *
 * @关键设计:
 * - TerminalView 始终挂载:卸载它会重建 xterm,PTY 输出和滚动位置都受影响。分屏只靠
 *   CSS (.session-stage-beside),终端宽度变化走它自己的 fit。
 * - PDF 由 PdfJsViewer(pdf.js)渲染,文件更新后换文档保持页码。图片用 <img>,
 *   markdown 用 markdown-it,html 关闭,原始 HTML 只当文本显示,不会在应用里执行。
 *   链接都交给系统浏览器:在窗口里跟着链接走会把应用页面换掉。
 * - 显示期间 watchPdf 轮询文件,变了自动重读(见 pdf-view-store.ts)。标题栏显示
 *   刷新状态:更新中 / 无法刷新(可点重试)。
 * - 焦点由 focusTerminalDom 统一处理:有 PDF 时它把焦点给关闭按钮,而不是下面的终端。
 *
 * @对应文档章节: 软件定义书.md 14.6
 *
 * @不要在这里做的事:
 * - 不要给 PDF、图片、markdown 加编辑或批注。文本编辑只限 txt 和 json,见 TextFileView
 * - 不要加键盘快捷键,缩放只有按钮和 Ctrl+滚轮 (13.2 鼠标优先)
 */
import { useEffect, useMemo, useRef, type MouseEvent } from 'react';
import MarkdownIt from 'markdown-it';
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
import { Icon } from './icons';
import { useTranslation } from './LanguageProvider';
import { FitWidth, Sync, ZoomIn, ZoomOut } from './material-symbols';
import { PdfJsViewer, type PdfJsViewerHandle } from './PdfJsViewer';
import { TextFileView } from './TextFileView';

const markdown = new MarkdownIt({ html: false, linkify: true });

function MarkdownView({ text }: { text: string }): JSX.Element {
  const html = useMemo(() => markdown.render(text), [text]);

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

  useEffect(() => {
    if (generation === undefined) return undefined;
    markPdfShown(viewKey);
    focusTerminalDom();
    return watchPdf(viewKey);
  }, [generation, viewKey]);

  if (!view) return null;
  const label = tx('关闭', 'Close');
  const kind = fileViewKind(view.source.name);
  const ready = view.status === 'ready' ? view : null;

  return (
    <section className="pdf-overlay" aria-label={view.source.name}>
      <header className="pdf-overlay-header" title={view.source.path}>
        <span className="pdf-overlay-name">{view.source.name}</span>
        {ready && <RefreshBadge viewKey={viewKey} view={ready} />}
        {ready && kind === 'pdf' && (
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
        kind === 'text' ? (
          <TextFileView key={view.generation} source={view.source} />
        ) : ready.text !== null ? (
          <MarkdownView text={ready.text} />
        ) : kind === 'image' ? (
          <div className="file-view-image">
            <img src={ready.url ?? ''} alt={view.source.name} />
          </div>
        ) : ready.blob ? (
          <div className="pdf-overlay-body">
            <PdfJsViewer
              blob={ready.blob}
              revision={ready.revision}
              name={view.source.name}
              onReady={(handle) => {
                viewerRef.current = handle;
              }}
            />
          </div>
        ) : null
      ) : (
        <p className="pdf-overlay-status">
          {view.status === 'error'
            ? t(`fileTree.error.${view.reason}`)
            : tx('正在打开…', 'Opening…')}
        </p>
      )}
    </section>
  );
}
