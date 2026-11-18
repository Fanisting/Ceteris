/**
 * @file src/renderer/components/PdfJsViewer.tsx
 * @purpose 用 pdf.js 在终端区域里渲染 PDF。文件更新后换文档时保持页码、位置和缩放。
 *   有两种看法:滚动(连续页面)和幻灯片(一次一页,整页放进窗格,底部缩略图条)。
 *
 * @关键设计:
 * - 为什么不用 Chromium 内置查看器:它是个黑盒 iframe,拿不到当前页码,文件一变只能
 *   从第一页重来,对改一行编译一次的写作流程不可用。pdf.js 的 PDFViewer 组件把位置
 *   (updateviewarea 事件)和缩放(scalechanging 事件)都交出来,setDocument 之后用
 *   scrollPageIntoView 回到原处。这正是 pdf.js 自己在缩放时保持位置的做法。
 * - 幻灯片用 pdf.js 自带的 ScrollMode.PAGE(只把当前页放进 DOM)加 'page-fit' 缩放,
 *   不另写一个单页渲染器:文本选择、链接、换文档保持页码都沿用同一套。
 *   setDocument 会把 scrollMode 重置成 VERTICAL,所以换文档后在 pagesinit 里重新设。
 *   进幻灯片前记下滚动时的缩放,回到滚动时还原,幻灯片的 page-fit 不会带回去。
 *   setDocument 到 pagesinit 之间 pdf.js 还没有页面对象,这时设 PAGE 会在
 *   #ensurePageViewVisible 里读 undefined.div 抛错,整个窗口跟着白屏。所以切换只在
 *   pagesReadyRef 为真时做,新文档也等到 pagesinit 才交给缩略图条。
 * - 幻灯片里翻页全用鼠标(13.2 鼠标优先,不加快捷键):点左半边上一页、右半边下一页,
 *   滚轮一格一页。点在链接上或刚选了文字时不翻页,双击的第二下也不翻(双击选词)。
 *   滚轮翻页后有冷却时间;触控板的小 delta 在冷却里每来一个就把冷却往后推,
 *   一次惯性甩动(约 1 秒的小 delta)只翻一页。鼠标滚轮一格是大 delta,不推冷却,
 *   连续拨几格照样一格一页。幻灯片里不缩放,Ctrl+滚轮也不缩,页面总是整页可见。
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
 * - 不要加翻页快捷键或全屏放映 (13.2 鼠标优先;查看器只占终端区域)
 *
 * @常见问题排查:
 * - 空白无报错 → DevTools 看 worker 是否被 CSP 挡住("Refused to create a worker")
 * - 文字选不中 → pdf_viewer.css 没加载,文本层没有定位
 * - 控制台 "container must be absolutely positioned" → .pdf-overlay-viewer 的 CSS 被改了
 * - 幻灯片换文档后变回连续页面 → pagesinit 里没有重新设 scrollMode
 */
import { useEffect, useRef, useState } from 'react';
import { AnnotationMode, getDocument, GlobalWorkerOptions } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
  EventBus,
  LinkTarget,
  PDFLinkService,
  PDFViewer,
  ScrollMode,
} from 'pdfjs-dist/legacy/web/pdf_viewer.mjs';
import PdfWorker from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?worker';
import 'pdfjs-dist/legacy/web/pdf_viewer.css';
import { ChevronRight } from './material-symbols';
import { PdfThumbStrip } from './PdfThumbStrip';

/** 新打开的文档按宽度铺满。 */
const DEFAULT_SCALE = 'page-width';
/** 幻灯片整页放进窗格。 */
const SLIDES_SCALE = 'page-fit';
/** 滚轮累计到这么多像素翻一页:鼠标一格约 100,触控板要滑一小段。 */
const WHEEL_PAGE_DELTA = 50;
/** 翻页后这段时间内的滚轮不再翻页,免得一次甩动翻过好几页。 */
const WHEEL_COOLDOWN_MS = 280;
/** 滚轮停下这么久后清掉没用完的累计量。 */
const WHEEL_IDLE_RESET_MS = 200;

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

interface PageChangingEvent {
  pageNumber: number;
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
  nextPage: () => void;
  previousPage: () => void;
}

interface PdfJsViewerProps {
  blob: Blob;
  /** 变了就换文档;同一份内容不重新渲染 */
  revision: number;
  name: string;
  /** true 时一次一页、整页放进窗格,底部显示缩略图条 */
  slides: boolean;
  /** 把缩放和翻页操作交给工具栏 */
  onReady?: (handle: PdfJsViewerHandle) => void;
  /** 当前页或总页数变了 */
  onPage?: (page: number, total: number) => void;
}

export function PdfJsViewer({
  blob,
  revision,
  name,
  slides,
  onReady,
  onPage,
}: PdfJsViewerProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<PDFViewer | null>(null);
  const eventBusRef = useRef<EventBus | null>(null);
  const linkServiceRef = useRef<PDFLinkService | null>(null);
  // pdf.js 6 通过 loading task 释放文档和 worker 侧的资源,文档对象本身没有 destroy
  const taskRef = useRef<PDFDocumentLoadingTask | null>(null);
  const locationRef = useRef<ViewLocation | null>(null);
  const scaleRef = useRef<string>(DEFAULT_SCALE);
  // 进幻灯片前的缩放,回到滚动时还原
  const scrollScaleRef = useRef<string>(DEFAULT_SCALE);
  // setDocument 后为 false,pagesinit 后为 true:只有这段时间外才能切换 scrollMode
  const pagesReadyRef = useRef(false);
  const slidesRef = useRef(slides);
  slidesRef.current = slides;
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const onPageRef = useRef(onPage);
  onPageRef.current = onPage;
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [page, setPage] = useState(1);

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
    eventBus.on('pagechanging', (e: PageChangingEvent) => {
      setPage(e.pageNumber);
      onPageRef.current?.(e.pageNumber, viewer.pagesCount);
    });
    viewerRef.current = viewer;
    eventBusRef.current = eventBus;
    linkServiceRef.current = linkService;

    let wheelSum = 0;
    let wheelLastEvent = 0;
    let wheelLastFlip = 0;
    const onWheel = (e: WheelEvent): void => {
      if (slidesRef.current) {
        e.preventDefault();
        e.stopPropagation();
        if (e.ctrlKey || e.metaKey || !viewer.pdfDocument) return;
        const now = performance.now();
        if (now - wheelLastEvent > WHEEL_IDLE_RESET_MS) wheelSum = 0;
        wheelLastEvent = now;
        const delta = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
        if (now - wheelLastFlip < WHEEL_COOLDOWN_MS) {
          // 触控板惯性的小 delta 延长冷却,直到手停下来
          if (Math.abs(delta) < WHEEL_PAGE_DELTA) wheelLastFlip = now;
          return;
        }
        wheelSum += delta;
        if (Math.abs(wheelSum) < WHEEL_PAGE_DELTA) return;
        if (wheelSum > 0) viewer.nextPage();
        else viewer.previousPage();
        wheelSum = 0;
        wheelLastFlip = now;
        return;
      }
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

    // 幻灯片:点左半边上一页,右半边下一页。链接和刚拖出的文字选择留给 pdf.js
    const onClick = (e: MouseEvent): void => {
      if (!slidesRef.current || !viewer.pdfDocument || e.detail > 1) return;
      const target = e.target as Element | null;
      if (target?.closest('a, button, input, select, textarea')) return;
      if ((window.getSelection()?.toString() ?? '') !== '') return;
      const rect = container.getBoundingClientRect();
      if (e.clientX - rect.left < rect.width / 2) viewer.previousPage();
      else viewer.nextPage();
    };
    container.addEventListener('click', onClick);

    // 窗格变宽变窄时,按宽度或整页铺满的文档要跟着重排;数值缩放保持不动
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
      nextPage: () => {
        viewer.nextPage();
      },
      previousPage: () => {
        viewer.previousPage();
      },
    });

    return () => {
      resize.disconnect();
      container.removeEventListener('wheel', onWheel);
      container.removeEventListener('click', onClick);
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
      let next: PDFDocumentProxy;
      try {
        next = await loading.promise;
      } catch (err) {
        console.warn(`[PdfJsViewer] cannot parse "${name}"`, err);
        void loading.destroy();
        return;
      }
      if (cancelled) {
        void loading.destroy();
        return;
      }
      // 先记下现在的位置:setDocument 会把它重置到第一页、连续滚动
      const restoreTo = locationRef.current;
      const restoreScale = scaleRef.current;
      const previous = taskRef.current;
      taskRef.current = loading;
      eventBus.on(
        'pagesinit',
        () => {
          const pageNumber = Math.min(restoreTo?.pageNumber ?? 1, next.numPages);
          if (slidesRef.current) {
            viewer.scrollMode = ScrollMode.PAGE;
            viewer.currentScaleValue = SLIDES_SCALE;
            viewer.currentPageNumber = pageNumber;
          } else {
            // 幻灯片里换文档、页面建好前又切回滚动时,restoreScale 是 page-fit,用滚动时的缩放
            viewer.currentScaleValue =
              restoreScale === SLIDES_SCALE ? scrollScaleRef.current : restoreScale;
            if (restoreTo) {
              viewer.scrollPageIntoView({
                pageNumber,
                destArray: [null, { name: 'XYZ' }, restoreTo.left, restoreTo.top, null],
                allowNegativeOffset: true,
              });
            }
          }
          pagesReadyRef.current = true;
          setDoc(next);
          // 旧文档等缩略图条换到新文档后再释放,免得条在这段时间里读已销毁的文档
          void previous?.destroy();
          setPage(viewer.currentPageNumber);
          onPageRef.current?.(viewer.currentPageNumber, next.numPages);
        },
        { once: true },
      );
      pagesReadyRef.current = false;
      viewer.setDocument(next);
      linkService.setDocument(next);
    })();
    void task;
    return () => {
      cancelled = true;
    };
  }, [blob, revision, name]);

  // 切换滚动 / 幻灯片。页面还没建好时 pagesinit 会按 slidesRef 设好
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer?.pdfDocument || !pagesReadyRef.current) return;
    const inSlides = viewer.scrollMode === ScrollMode.PAGE;
    if (slides === inSlides) return;
    const pageNumber = viewer.currentPageNumber;
    if (slides) {
      scrollScaleRef.current = scaleRef.current;
      viewer.scrollMode = ScrollMode.PAGE;
      viewer.currentScaleValue = SLIDES_SCALE;
    } else {
      viewer.scrollMode = ScrollMode.VERTICAL;
      viewer.currentScaleValue = scrollScaleRef.current;
      viewer.scrollPageIntoView({ pageNumber });
    }
  }, [slides]);

  return (
    <div className={`pdf-js-root${slides ? ' pdf-js-slides' : ''}`}>
      <div className="pdf-js-stage">
        <div ref={containerRef} className="pdf-overlay-viewer">
          <div className="pdfViewer" />
        </div>
        {slides && (
          <>
            <span className="pdf-slide-edge pdf-slide-edge-prev" aria-hidden>
              <ChevronRight size={22} />
            </span>
            <span className="pdf-slide-edge pdf-slide-edge-next" aria-hidden>
              <ChevronRight size={22} />
            </span>
          </>
        )}
      </div>
      {slides && doc && (
        <PdfThumbStrip
          doc={doc}
          page={page}
          onPick={(n) => {
            if (viewerRef.current) viewerRef.current.currentPageNumber = n;
          }}
        />
      )}
    </div>
  );
}
