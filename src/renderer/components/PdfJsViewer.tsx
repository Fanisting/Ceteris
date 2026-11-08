/**
 * @file src/renderer/components/PdfJsViewer.tsx
 * @purpose 用 pdf.js 在终端区域里渲染 PDF。文件更新后换文档时保持页码、位置和缩放。
 *
 * @关键设计:
 * - 为什么不用 Chromium 内置查看器:它是个黑盒 iframe,拿不到当前页码,文件一变只能
 *   从第一页重来,对改一行编译一次的写作流程不可用。pdf.js 的 PDFViewer 组件把位置
 *   (updateviewarea 事件)和缩放(scalechanging 事件)都交出来,setDocument 之后用
 *   scrollPageIntoView 回到原处。这正是 pdf.js 自己在缩放时保持位置的做法。
 * - 用 pdfjs-dist 的 legacy 构建:现代构建只保证最新几版浏览器,Electron 31 是 Chromium 126。
 * - 解析在 Web Worker 里。Vite 的 ?worker 把 worker 打成独立文件,CSP 的 worker-src 放行
 *   (main/index.ts)。worker 起不来时 pdf.js 自动退回主线程,只是慢一些。
 * - 字节交给 getDocument 前复制一份:pdf.js 会把 ArrayBuffer 转移给 worker,
 *   原 Blob 还要留着下次比较或重新渲染。
 * - 链接 target=_blank → window.open → main 的 setWindowOpenHandler 只放 http(s) 去系统
 *   浏览器,其它一律拒绝。窗口里永远只有应用页面。
 * - 缩放只有按钮和 Ctrl+滚轮,不加快捷键(13.2 鼠标优先)。
 * - 没有配置 standardFontDataUrl / cMapUrl:页面从 file:// 加载时 Chromium 不让它再去取
 *   file:// 资源。没内嵌字体的 PDF 用 pdf.js 的替代字体显示。
 *
 * @对应文档章节: 软件定义书.md 14.6
 *
 * @不要在这里做的事:
 * - 不要读文件或轮询,那是 pdf-view-store.ts 的事。这里只拿到 Blob 就画
 * - 不要提供编辑或批注 (13.2 永远不做)
 *
 * @常见问题排查:
 * - 空白无报错 → DevTools 看 worker 是否被 CSP 挡住("Refused to create a worker")
 * - 文字选不中 → pdf_viewer.css 没加载,文本层没有定位
 * - 控制台 "container must be absolutely positioned" → .pdf-overlay-viewer 的 CSS 被改了
 */
import { useEffect, useRef } from 'react';
import { AnnotationMode, getDocument, GlobalWorkerOptions } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
  EventBus,
  LinkTarget,
  PDFLinkService,
  PDFViewer,
} from 'pdfjs-dist/legacy/web/pdf_viewer.mjs';
import PdfWorker from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?worker';
import 'pdfjs-dist/legacy/web/pdf_viewer.css';

/** 新打开的文档按宽度铺满。 */
const DEFAULT_SCALE = 'page-width';

/** pdf.js 会在缩放事件里给出当前的预设名(page-width 等)或数值。 */
interface ViewLocation {
  pageNumber: number;
  left: number;
  top: number;
}

interface ScaleChangingEvent {
  scale: number;
  presetValue?: string;
}

interface UpdateViewAreaEvent {
  location: (ViewLocation & { scale: number | string }) | null;
}

let workerStarted = false;

/** 整个窗口共用一个 worker,打开第二份 PDF 不再起线程。 */
function ensureWorker(): void {
  if (workerStarted) return;
  workerStarted = true;
  try {
    GlobalWorkerOptions.workerPort = new PdfWorker();
  } catch (err) {
    // 退回 pdf.js 的主线程解析,功能不变
    console.warn('[PdfJsViewer] worker unavailable, parsing on the main thread', err);
  }
}

export interface PdfJsViewerHandle {
  zoomIn: () => void;
  zoomOut: () => void;
  fitWidth: () => void;
}

interface PdfJsViewerProps {
  blob: Blob;
  /** 变了就换文档;同一份内容不重新渲染 */
  revision: number;
  name: string;
  /** 把缩放操作交给工具栏 */
  onReady?: (handle: PdfJsViewerHandle) => void;
}

export function PdfJsViewer({ blob, revision, name, onReady }: PdfJsViewerProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<PDFViewer | null>(null);
  const eventBusRef = useRef<EventBus | null>(null);
  const linkServiceRef = useRef<PDFLinkService | null>(null);
  // pdf.js 6 通过 loading task 释放文档和 worker 侧的资源,文档对象本身没有 destroy
  const taskRef = useRef<PDFDocumentLoadingTask | null>(null);
  const locationRef = useRef<ViewLocation | null>(null);
  const scaleRef = useRef<string>(DEFAULT_SCALE);
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;

  // 建查看器,只做一次
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;
    ensureWorker();
    const eventBus = new EventBus();
    const linkService = new PDFLinkService({ eventBus, externalLinkTarget: LinkTarget.BLANK });
    const viewer = new PDFViewer({
      container,
      eventBus,
      linkService,
      textLayerMode: 1,
      annotationMode: AnnotationMode.ENABLE,
    });
    linkService.setViewer(viewer);
    eventBus.on('updateviewarea', (e: UpdateViewAreaEvent) => {
      if (!e.location) return;
      const { pageNumber, left, top } = e.location;
      locationRef.current = { pageNumber, left, top };
    });
    eventBus.on('scalechanging', (e: ScaleChangingEvent) => {
      scaleRef.current = e.presetValue ?? String(e.scale);
    });
    viewerRef.current = viewer;
    eventBusRef.current = eventBus;
    linkServiceRef.current = linkService;

    const onWheel = (e: WheelEvent): void => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      e.stopPropagation();
      viewer.updateScale({
        steps: e.deltaY < 0 ? 1 : -1,
        drawingDelay: 150,
        origin: [e.clientX, e.clientY],
      });
    };
    container.addEventListener('wheel', onWheel, { passive: false });

    // 窗格变宽变窄时,按宽度铺满的文档要跟着重排;数值缩放保持不动
    const resize = new ResizeObserver(() => {
      if (!viewerRef.current?.pdfDocument) return;
      if (!/^\d/.test(scaleRef.current)) viewerRef.current.currentScaleValue = scaleRef.current;
    });
    resize.observe(container);

    onReadyRef.current?.({
      zoomIn: () => viewer.increaseScale({ drawingDelay: 100 }),
      zoomOut: () => viewer.decreaseScale({ drawingDelay: 100 }),
      fitWidth: () => {
        viewer.currentScaleValue = DEFAULT_SCALE;
      },
    });

    return () => {
      resize.disconnect();
      container.removeEventListener('wheel', onWheel);
      viewer.setDocument(null);
      linkService.setDocument(null);
      void taskRef.current?.destroy();
      taskRef.current = null;
      viewerRef.current = null;
      eventBusRef.current = null;
      linkServiceRef.current = null;
    };
  }, []);

  // 加载或替换文档
  useEffect(() => {
    const viewer = viewerRef.current;
    const eventBus = eventBusRef.current;
    const linkService = linkServiceRef.current;
    if (!viewer || !eventBus || !linkService) return undefined;
    let cancelled = false;
    const task = (async (): Promise<void> => {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      if (cancelled) return;
      const loading = getDocument({ data: bytes });
      let doc: PDFDocumentProxy;
      try {
        doc = await loading.promise;
      } catch (err) {
        console.warn(`[PdfJsViewer] cannot parse "${name}"`, err);
        void loading.destroy();
        return;
      }
      if (cancelled) {
        void loading.destroy();
        return;
      }
      // 先记下现在的位置:setDocument 会把它重置到第一页
      const restoreTo = locationRef.current;
      const restoreScale = scaleRef.current;
      const previous = taskRef.current;
      taskRef.current = loading;
      eventBus.on(
        'pagesinit',
        () => {
          viewer.currentScaleValue = restoreScale;
          if (restoreTo) {
            viewer.scrollPageIntoView({
              pageNumber: Math.min(restoreTo.pageNumber, doc.numPages),
              destArray: [null, { name: 'XYZ' }, restoreTo.left, restoreTo.top, null],
              allowNegativeOffset: true,
            });
          }
        },
        { once: true },
      );
      viewer.setDocument(doc);
      linkService.setDocument(doc);
      void previous?.destroy();
    })();
    void task;
    return () => {
      cancelled = true;
    };
  }, [blob, revision, name]);

  return (
    <div ref={containerRef} className="pdf-overlay-viewer">
      <div className="pdfViewer" />
    </div>
  );
}
