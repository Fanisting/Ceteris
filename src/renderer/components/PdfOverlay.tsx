/**
 * @file src/renderer/components/PdfOverlay.tsx
 * @purpose Shows a PDF, picture, Markdown or text file for a session. With one terminal on
 *   screen the file sits to its left. In a full pane grid it covers its own pane until closed.
 *   A folder with no terminal shows it over the new tab page in the same way.
 *
 * @关键设计:
 * - TerminalView 始终挂载:卸载它会重建 xterm,PTY 输出和滚动位置都受影响。分屏只靠
 *   CSS (.session-stage-beside),终端宽度变化走它自己的 fit。
 * - 用 iframe 加载 blob URL,由 Chromium 内置的 PDF 查看器渲染,不增加依赖。
 *   需要 webPreferences.plugins (window-manager.ts) 和 CSP 的 frame-src blob:
 *   与查看器页面豁免 (index.ts),缺任何一项都是空白页。
 * - markdown-it runs with html off, so a file's raw HTML shows as text and cannot run in the
 *   app. Links open in the browser: following one inside the window would replace the app.
 * - 焦点由 focusTerminalDom 统一处理:有 PDF 时它把焦点给关闭按钮,而不是下面的终端。
 *
 * @对应文档章节: 软件定义书.md 14.6
 *
 * @不要在这里做的事:
 * - 不要给 PDF、图片、markdown 加编辑或批注。文本编辑只限 txt 和 json,见 TextFileView
 */
import { useEffect, useMemo, type MouseEvent } from 'react';
import MarkdownIt from 'markdown-it';
import { fileViewKind } from '@shared/file-tree';
import { COMMAND_CHANNELS } from '@shared/protocol';
import { focusTerminalDom } from '../focus';
import { closePdf, markPdfShown, usePdfView } from '../pdf-view-store';
import { Icon } from './icons';
import { useTranslation } from './LanguageProvider';
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

export function PdfOverlay({ viewKey }: { viewKey: string }): JSX.Element | null {
  const { t, tx } = useTranslation();
  const view = usePdfView(viewKey);
  const generation = view?.generation;

  useEffect(() => {
    if (generation === undefined) return;
    markPdfShown(viewKey);
    focusTerminalDom();
  }, [generation, viewKey]);

  if (!view) return null;
  const label = tx('关闭', 'Close');

  return (
    <section className="pdf-overlay" aria-label={view.source.name}>
      <header className="pdf-overlay-header" title={view.source.path}>
        <span className="pdf-overlay-name">{view.source.name}</span>
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
      {view.status === 'ready' ? (
        fileViewKind(view.source.name) === 'text' ? (
          <TextFileView key={view.generation} source={view.source} />
        ) : view.text !== null ? (
          <MarkdownView text={view.text} />
        ) : fileViewKind(view.source.name) === 'image' ? (
          <div className="file-view-image">
            <img src={view.url ?? ''} alt={view.source.name} />
          </div>
        ) : (
          <iframe className="pdf-overlay-frame" src={view.url ?? ''} title={view.source.name} />
        )
      ) : (
        <p className="pdf-overlay-status">
          {view.status === 'loading'
            ? tx('正在打开…', 'Opening…')
            : t(`fileTree.error.${view.reason}`)}
        </p>
      )}
    </section>
  );
}
