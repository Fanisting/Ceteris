/**
 * @file src/renderer/components/ImageView.tsx
 * @purpose Shows a picture in the file viewer and lets the user zoom it in and out.
 *
 * @关键设计:
 * - It opens fitted to the pane (scale null), the same look as before zoom existed. The first
 *   zoom step starts from the fitted size the user is looking at, not from 100 %, so the
 *   picture never jumps.
 * - Zoom comes from the header buttons (via the ImageViewHandle ref) and from Ctrl+wheel,
 *   which also covers a touchpad pinch because Chromium reports a pinch as Ctrl+wheel.
 *   Ctrl+wheel keeps the point under the cursor in place; the buttons keep the pane centre.
 *   The scroll correction runs in a layout effect after the new size is laid out, so there
 *   is no frame where the picture sits at the wrong place.
 * - A zoomed picture larger than the pane scrolls, and dragging it with the left button
 *   pans it. Centring uses margin: auto rather than justify-content: center, because centred
 *   flex content that overflows gets cut off on the left and top and cannot be scrolled to.
 * - The parent keys this component by path, so another file starts fitted again, while a
 *   refresh of the same file (new url) keeps the zoom.
 *
 * @对应文档章节: 软件定义书.md 14.6
 *
 * @不要在这里做的事:
 * - 不要加键盘快捷键,缩放只有按钮、Ctrl+滚轮和触控板捏合 (13.2 鼠标优先)
 * - 不要加编辑、裁剪或批注,查看器对图片只读
 */
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent,
} from 'react';

export interface ImageViewHandle {
  zoomIn: () => void;
  zoomOut: () => void;
  /** Back to the whole picture fitted inside the pane. */
  fit: () => void;
}

const BUTTON_STEP = 1.25;
const MIN_SCALE = 0.05;
const MAX_SCALE = 16;
/**
 * Ctrl+wheel zoom per pixel of deltaY. A mouse notch (about 100 px) gives about 1.22, close
 * to one button step; a pinch sends many small deltas and so zooms smoothly.
 */
const WHEEL_ZOOM_PER_PX = 0.002;
const LINE_HEIGHT_PX = 16;

/**
 * The image point (as a fraction of its size) that must end up at (x, y) in the pane, or at
 * the centre of the visible area when centre is true. The centre is measured again after the
 * zoom because scrollbars that appear or vanish move it.
 */
interface Anchor {
  centre: boolean;
  x: number;
  y: number;
  fx: number;
  fy: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export const ImageView = forwardRef<ImageViewHandle, { url: string; name: string }>(
  function ImageView({ url, name }, ref): JSX.Element {
    const boxRef = useRef<HTMLDivElement>(null);
    const imgRef = useRef<HTMLImageElement>(null);
    // null = fitted to the pane; a number = shown pixels per image pixel.
    const [scale, setScale] = useState<number | null>(null);
    const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
    const scaleRef = useRef(scale);
    scaleRef.current = scale;
    const anchorRef = useRef<Anchor | null>(null);
    const dragRef = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
    const [dragging, setDragging] = useState(false);
    // Whether the picture is larger than the pane, so dragging can pan it (grab cursor).
    const [pannable, setPannable] = useState(false);

    const canPan = (): boolean => {
      const box = boxRef.current;
      return Boolean(
        box && (box.scrollWidth > box.clientWidth || box.scrollHeight > box.clientHeight),
      );
    };

    /**
     * Multiplies the shown size by factor around the client point (clientX, clientY), or the
     * pane centre when none is given. Does nothing before the image has loaded, because the
     * fitted scale is unknown until then.
     */
    const zoomBy = (factor: number, clientX?: number, clientY?: number): void => {
      const box = boxRef.current;
      const img = imgRef.current;
      if (!box || !img || !img.naturalWidth) return;
      const imgRect = img.getBoundingClientRect();
      const now = scaleRef.current ?? imgRect.width / img.naturalWidth;
      const next = clamp(now * factor, MIN_SCALE, MAX_SCALE);
      if (next === now) return;
      const boxRect = box.getBoundingClientRect();
      const centre = clientX === undefined || clientY === undefined;
      const x = centre ? boxRect.left + box.clientLeft + box.clientWidth / 2 : clientX;
      const y = centre ? boxRect.top + box.clientTop + box.clientHeight / 2 : clientY;
      anchorRef.current = {
        centre,
        x: x - boxRect.left,
        y: y - boxRect.top,
        fx: clamp((x - imgRect.left) / imgRect.width, 0, 1),
        fy: clamp((y - imgRect.top) / imgRect.height, 0, 1),
      };
      scaleRef.current = next;
      setScale(next);
    };

    useImperativeHandle(ref, () => ({
      zoomIn: () => zoomBy(BUTTON_STEP),
      zoomOut: () => zoomBy(1 / BUTTON_STEP),
      fit: () => {
        anchorRef.current = null;
        scaleRef.current = null;
        setScale(null);
      },
    }));

    // Scroll so the anchored image point lands back under the cursor (or the pane centre).
    useLayoutEffect(() => {
      const anchor = anchorRef.current;
      anchorRef.current = null;
      const box = boxRef.current;
      const img = imgRef.current;
      if (!anchor || !box || !img) return;
      const boxRect = box.getBoundingClientRect();
      const imgRect = img.getBoundingClientRect();
      const x = anchor.centre ? box.clientLeft + box.clientWidth / 2 : anchor.x;
      const y = anchor.centre ? box.clientTop + box.clientHeight / 2 : anchor.y;
      box.scrollLeft += imgRect.left - boxRect.left + anchor.fx * imgRect.width - x;
      box.scrollTop += imgRect.top - boxRect.top + anchor.fy * imgRect.height - y;
    }, [scale]);

    useLayoutEffect(() => {
      setPannable(scale !== null && canPan());
    }, [scale, natural]);

    // React's onWheel is passive, so preventDefault (which stops the window zooming) needs
    // a native listener.
    useEffect(() => {
      const box = boxRef.current;
      if (!box) return undefined;
      const onWheel = (e: WheelEvent): void => {
        if (!e.ctrlKey) return;
        e.preventDefault();
        const px = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? e.deltaY * LINE_HEIGHT_PX : e.deltaY;
        zoomBy(Math.exp(-px * WHEEL_ZOOM_PER_PX), e.clientX, e.clientY);
      };
      box.addEventListener('wheel', onWheel, { passive: false });
      return () => box.removeEventListener('wheel', onWheel);
      // zoomBy reads only refs, so binding it once is enough.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const onPointerDown = (e: PointerEvent<HTMLDivElement>): void => {
      const box = boxRef.current;
      if (e.button !== 0 || !box || !canPan()) return;
      e.preventDefault();
      box.setPointerCapture(e.pointerId);
      dragRef.current = { x: e.clientX, y: e.clientY, left: box.scrollLeft, top: box.scrollTop };
      setDragging(true);
    };

    const onPointerMove = (e: PointerEvent<HTMLDivElement>): void => {
      const drag = dragRef.current;
      const box = boxRef.current;
      if (!drag || !box) return;
      box.scrollLeft = drag.left - (e.clientX - drag.x);
      box.scrollTop = drag.top - (e.clientY - drag.y);
    };

    const endDrag = (): void => {
      dragRef.current = null;
      setDragging(false);
    };

    const zoomed = scale !== null && natural !== null;

    return (
      <div
        ref={boxRef}
        className={`file-view-image${zoomed ? ' zoomed' : ''}${pannable ? ' pannable' : ''}${
          dragging ? ' dragging' : ''
        }`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <img
          ref={imgRef}
          src={url}
          alt={name}
          draggable={false}
          onLoad={(e) =>
            setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })
          }
          style={zoomed ? { width: natural.w * scale, height: natural.h * scale } : undefined}
        />
      </div>
    );
  },
);
