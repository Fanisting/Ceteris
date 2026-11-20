/**
 * @file src/renderer/components/PdfThumbStrip.tsx
 * @purpose 幻灯片模式底部的缩略图条:每页一个小图,点一下跳到那页,当前页描边并保持在可见范围内。
 *
 * @关键设计:
 * - 缩略图只在滚进条的可见范围(左右各多留 400px)时才渲染,画过的不再画。
 *   两百页的讲稿打开时只画前面能看到的十来张,worker 不会被缩略图占满。
 * - 直接用 page.render 画到小 canvas,不用 pdf.js 应用里的 PDFThumbnailViewer:
 *   pdf_viewer.mjs 没有导出它,它还依赖 viewer.html 那套应用对象。
 * - canvas 按设备像素比放大,在高 DPI 屏上不糊。
 * - 文档换了(LaTeX 重新编译)整条用新文档重建:key 是 doc 对象,旧的渲染任务在卸载时取消。
 * - 竖向滚轮在条上转成横向滚动,鼠标没有横向滚轮也能翻到后面。
 *
 * @对应文档章节: 软件定义书.md 14.6
 *
 * @不要在这里做的事:
 * - 不要在这里翻页或记页码,页码由 PdfJsViewer 的 pagechanging 事件给出
 */
import { useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { useTranslation } from './LanguageProvider';

/** 缩略图的显示高度(CSS 像素),和 .pdf-thumb 的高度一致。 */
const THUMB_HEIGHT = 44;
/** 页面尺寸未知时先按 16:9 占位,画出来再改成真实比例。 */
const PLACEHOLDER_WIDTH = Math.round((THUMB_HEIGHT * 16) / 9);
/** 提前这么远开始渲染,滚动时不会看到空白。 */
const PRELOAD_MARGIN = '0px 400px';

interface PdfThumbStripProps {
  doc: PDFDocumentProxy;
  /** 当前页,从 1 开始 */
  page: number;
  onPick: (page: number) => void;
}

export function PdfThumbStrip({ doc, page, onPick }: PdfThumbStripProps): JSX.Element {
  const { tx } = useTranslation();
  const stripRef = useRef<HTMLDivElement | null>(null);
  const [observer, setObserver] = useState<IntersectionObserver | null>(null);

  // 一个 observer 给整条用,每张缩略图在 data-page 上标页码
  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) return undefined;
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          entry.target.dispatchEvent(new Event('pdf-thumb-visible'));
          io.unobserve(entry.target);
        }
      },
      { root: strip, rootMargin: PRELOAD_MARGIN },
    );
    setObserver(io);
    return () => io.disconnect();
  }, [doc]);

  // 当前页滚出条的可见范围时,滚到刚好露出它
  useEffect(() => {
    const strip = stripRef.current;
    const el = strip?.children[page - 1] as HTMLElement | undefined;
    if (!strip || !el) return;
    const pad = 8;
    if (el.offsetLeft < strip.scrollLeft) {
      strip.scrollLeft = el.offsetLeft - pad;
    } else if (el.offsetLeft + el.offsetWidth > strip.scrollLeft + strip.clientWidth) {
      strip.scrollLeft = el.offsetLeft + el.offsetWidth - strip.clientWidth + pad;
    }
    // observer 在依赖里:条刚挂上时缩略图要等 observer 建好才渲染出来
  }, [page, doc, observer]);

  const pages = Array.from({ length: doc.numPages }, (_, i) => i + 1);
  return (
    <div
      ref={stripRef}
      className="pdf-thumb-strip"
      role="toolbar"
      aria-label={tx('页面', 'Pages')}
      onWheel={(e) => {
        if (e.deltaY !== 0 && stripRef.current) stripRef.current.scrollLeft += e.deltaY;
      }}
    >
      {observer &&
        pages.map((n) => (
          <PdfThumb
            key={n}
            doc={doc}
            pageNumber={n}
            current={n === page}
            observer={observer}
            label={tx(`第 ${n} 页`, `Page ${n}`)}
            onPick={onPick}
          />
        ))}
    </div>
  );
}

interface PdfThumbProps {
  doc: PDFDocumentProxy;
  pageNumber: number;
  current: boolean;
  observer: IntersectionObserver;
  label: string;
  onPick: (page: number) => void;
}

function PdfThumb({
  doc,
  pageNumber,
  current,
  observer,
  label,
  onPick,
}: PdfThumbProps): JSX.Element {
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [width, setWidth] = useState(PLACEHOLDER_WIDTH);

  useEffect(() => {
    const button = buttonRef.current;
    if (!button) return undefined;
    let cancelled = false;
    let renderTask: RenderTask | null = null;
    const draw = async (): Promise<void> => {
      const pdfPage = await doc.getPage(pageNumber);
      if (cancelled) return;
      const base = pdfPage.getViewport({ scale: 1 });
      const cssWidth = Math.max(1, Math.round((base.width * THUMB_HEIGHT) / base.height));
      setWidth(cssWidth);
      const dpr = window.devicePixelRatio || 1;
      const viewport = pdfPage.getViewport({ scale: (THUMB_HEIGHT * dpr) / base.height });
      const canvas = canvasRef.current;
      if (!canvas) return;
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      renderTask = pdfPage.render({ canvas, viewport });
      await renderTask.promise;
    };
    const onVisible = (): void => {
      draw().catch((err: unknown) => {
        // 取消(换文档、关闭查看器)也走这里,不算错误
        if (!cancelled) console.warn(`[PdfThumbStrip] page ${pageNumber} thumbnail failed`, err);
      });
    };
    button.addEventListener('pdf-thumb-visible', onVisible, { once: true });
    observer.observe(button);
    return () => {
      cancelled = true;
      renderTask?.cancel();
      button.removeEventListener('pdf-thumb-visible', onVisible);
      observer.unobserve(button);
    };
  }, [doc, pageNumber, observer]);

  return (
    <button
      ref={buttonRef}
      type="button"
      className={`pdf-thumb${current ? ' current' : ''}`}
      style={{ width }}
      title={label}
      aria-label={label}
      aria-current={current ? 'page' : undefined}
      onClick={() => onPick(pageNumber)}
    >
      <canvas ref={canvasRef} />
    </button>
  );
}
