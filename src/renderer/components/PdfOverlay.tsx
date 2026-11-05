/**
 * @file src/renderer/components/PdfOverlay.tsx
 * @purpose 盖在 session 的终端区域上显示 PDF,关闭后露出原来的终端。
 *
 * @关键设计:
 * - 盖在上面而不是替换 TerminalView:卸载 TerminalView 会重建 xterm,PTY 输出和
 *   滚动位置都受影响。终端在下面继续运行,尺寸也不变。
 * - 用 iframe 加载 blob URL,由 Chromium 内置的 PDF 查看器渲染,不增加依赖。
 *   需要 webPreferences.plugins (window-manager.ts) 和 CSP 的 frame-src blob:
 *   与查看器页面豁免 (index.ts),缺任何一项都是空白页。
 * - 焦点由 focusTerminalDom 统一处理:有 PDF 时它把焦点给关闭按钮,而不是下面的终端。
 *
 * @对应文档章节: 软件定义书.md 14.6
 *
 * @不要在这里做的事:
 * - 不要提供编辑或批注 (内置文件编辑器在 13.2 永远不做列表里)
 */
import { useEffect } from 'react';
import { focusTerminalDom } from '../focus';
import { closePdf, markPdfShown, usePdfView } from '../pdf-view-store';
import { Icon } from './icons';
import { useTranslation } from './LanguageProvider';

export function PdfOverlay({ sessionId }: { sessionId: string }): JSX.Element | null {
  const { t, tx } = useTranslation();
  const view = usePdfView(sessionId);
  const generation = view?.generation;

  useEffect(() => {
    if (generation === undefined) return;
    markPdfShown(sessionId);
    focusTerminalDom();
  }, [generation, sessionId]);

  if (!view) return null;
  const label = tx('关闭 PDF', 'Close PDF');

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
            closePdf(sessionId);
            focusTerminalDom();
          }}
        >
          <Icon name="close" size={14} />
        </button>
      </header>
      {view.status === 'ready' ? (
        <iframe className="pdf-overlay-frame" src={view.url} title={view.source.name} />
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
