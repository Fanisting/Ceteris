/**
 * @file src/renderer/components/ShapeLoader.tsx
 * @purpose The waiting animation (ADR-054): one filled shape that morphs through seven
 *   Material shapes while it turns, optionally inside a filled circle. A port of Material 3
 *   Expressive's LoadingIndicator / ContainedLoadingIndicator, the loader legado-with-MD3 uses.
 *
 * @关键设计:
 * - Timing is copied from androidx compose material3 LoadingIndicator.kt: a new morph every
 *   650 ms driven by a spring (damping 0.6, stiffness 200), +90° per morph, plus a full turn
 *   every 4666 ms. Shape 38 px inside a 48 px circle.
 * - Shapes are polar radius functions r(θ) sampled at a fixed number of angles, so any two
 *   morph by mixing radii point by point. They approximate Material's rounded polygons
 *   (SoftBurst, Cookie9Sided, Pentagon, Pill, Sunny, Cookie4Sided, Oval); no graphics-shapes
 *   library exists for the web and a new npm package needs approval (AGENTS.md 边界 2).
 * - Drawn as an SVG path whose `d` is set from requestAnimationFrame. Colours come from CSS
 *   (shape-loader.css), so theme changes need no code here.
 * - One shared clock and one rAF loop for every loader on screen: they move in step and an
 *   extra loader costs one path update per frame. The loop stops when the last one unmounts.
 * - `delayMs` (default 300): nothing renders until the wait is that long, so fast loads never
 *   flash a loader. The label waits with it.
 * - prefers-reduced-motion: one still shape, no loop.
 *
 * @对应文档章节:软件定义书.md ADR-054;features/shape-loader.md
 *
 * @不要在这里做的事:
 * - Do not decide when something is loading; callers render this only while they wait.
 * - Do not use it for tiny badges under 16 px: the shapes stop reading as shapes.
 */
import { useEffect, useRef, useState } from 'react';
import { prefersReducedMotion } from '../motion';
import { useTranslation } from './LanguageProvider';

const POINTS = 120;
const TAU = Math.PI * 2;
const MORPH_INTERVAL_MS = 650;
const TURN_MS = 4666;
const STIFFNESS = 200;
const DAMPING = 2 * 0.6 * Math.sqrt(STIFFNESS);
/** Shape size inside the circle: 38 of 48 px, and 0.86 leaves room for the spring overshoot. */
const CONTAINED_SCALE = (38 / 48) * 0.86;
const BARE_SCALE = 0.92;

type RadiusFn = (theta: number) => number;

const lobes =
  (count: number, depth: number): RadiusFn =>
  (t) =>
    1 - depth + depth * Math.cos(count * t);

const roundedPolygon =
  (sides: number, rounding: number): RadiusFn =>
  (t) => {
    const step = TAU / sides;
    const a = (((t % step) + step) % step) - step / 2;
    return (Math.cos(Math.PI / sides) / Math.cos(a)) * (1 - rounding) + rounding * 0.9;
  };

const superellipse =
  (a: number, b: number, power: number, turn: number): RadiusFn =>
  (t) => {
    const u = t - turn;
    return (
      (Math.abs(Math.cos(u) / a) ** power + Math.abs(Math.sin(u) / b) ** power) ** (-1 / power)
    );
  };

const sunny: RadiusFn = (t) => 0.8 + 0.2 * ((Math.cos(8 * t) + 1) / 2) ** 1.6;

/** Material order: SoftBurst, Cookie9Sided, Pentagon, Pill, Sunny, Cookie4Sided, Oval. */
const SHAPES: number[][] = [
  lobes(10, 0.1),
  lobes(9, 0.08),
  roundedPolygon(5, 0.35),
  superellipse(1, 0.56, 3.2, Math.PI / 4),
  sunny,
  lobes(4, 0.14),
  superellipse(1, 0.68, 2, -Math.PI / 4),
].map((fn) => {
  const radii = Array.from({ length: POINTS }, (_, i) => fn((i / POINTS) * TAU));
  const max = Math.max(...radii);
  return radii.map((r) => r / max);
});

/** Shared animation state: every loader on screen draws the same frame. */
const clock = {
  index: 0,
  /** Spring position from 0 to 1, may overshoot. */
  x: 0,
  v: 0,
  /** Rotation reached by finished morphs, degrees. */
  turned: 90,
  morphStart: 0,
  born: 0,
  last: 0,
};
const painters = new Set<() => void>();
let frameId = 0;

function step(now: number): void {
  const dt = Math.min((now - clock.last) / 1000, 0.05);
  clock.last = now;
  // Small fixed slices keep the spring stable when a frame comes late.
  const slices = Math.max(1, Math.ceil(dt / 0.004));
  for (let i = 0; i < slices; i++) {
    const h = dt / slices;
    clock.v += (-STIFFNESS * (clock.x - 1) - DAMPING * clock.v) * h;
    clock.x += clock.v * h;
  }
  if (now - clock.morphStart >= MORPH_INTERVAL_MS) {
    clock.index = (clock.index + 1) % SHAPES.length;
    clock.turned = (clock.turned + 90) % 360;
    clock.x = 0;
    clock.v = 0;
    clock.morphStart = now;
  }
  for (const paint of painters) paint();
  frameId = painters.size > 0 ? requestAnimationFrame(step) : 0;
}

function subscribe(paint: () => void): () => void {
  painters.add(paint);
  if (frameId === 0) {
    const now = performance.now();
    if (painters.size === 1) {
      clock.born = now;
      clock.morphStart = now;
    }
    clock.last = now;
    frameId = requestAnimationFrame(step);
  }
  return () => {
    painters.delete(paint);
    if (painters.size === 0 && frameId !== 0) {
      cancelAnimationFrame(frameId);
      frameId = 0;
    }
  };
}

/**
 * Path data for the current frame in a 100 × 100 box.
 *
 * @param scale shape radius as a share of half the box
 * @param still true draws the first shape unturned (reduced motion)
 */
function framePath(scale: number, still: boolean): string {
  const from = shapeAt(still ? 1 : clock.index);
  const to = shapeAt(still ? 1 : clock.index + 1);
  // The morph itself does not bounce; the overshoot shows as a little extra turn and size.
  const p = still ? 0 : Math.min(Math.max(clock.x, 0), 1);
  const spin = still
    ? 0
    : ((clock.x * 90 +
        clock.turned +
        (((performance.now() - clock.born) % TURN_MS) / TURN_MS) * 360) *
        Math.PI) /
      180;
  const r0 = 50 * scale * (still ? 1 : 1 + (clock.x - p) * 0.25);
  let d = '';
  from.forEach((a, i) => {
    const b = to[i] ?? a; // same length by construction
    const t = (i / POINTS) * TAU + spin;
    const r = r0 * (a + (b - a) * p);
    d += `${i === 0 ? 'M' : 'L'}${(50 + r * Math.cos(t)).toFixed(2)} ${(50 + r * Math.sin(t)).toFixed(2)}`;
  });
  return `${d}Z`;
}

function shapeAt(index: number): readonly number[] {
  const shape = SHAPES[index % SHAPES.length];
  if (!shape) throw new Error(`ShapeLoader: no shape at index ${index}; SHAPES is empty`);
  return shape;
}

interface ShapeLoaderProps {
  /** Width and height in px. 48 for the contained form, 16 to 20 next to text. */
  size: number;
  /** Draw the filled circle behind the shape (ContainedLoadingIndicator). */
  contained?: boolean;
  /** Text shown with the loader: under it when contained, beside it otherwise. */
  label?: string;
  /** Wait this long before showing anything. */
  delayMs?: number;
  className?: string;
}

/**
 * The waiting animation. Render it only while waiting; unmount when done.
 *
 * @returns null during the first `delayMs`, then the loader and its label
 * @副作用:joins the shared rAF loop while shown (not under reduced motion)
 */
export function ShapeLoader({
  size,
  contained = false,
  label,
  delayMs = 300,
  className,
}: ShapeLoaderProps): JSX.Element | null {
  const { tx } = useTranslation();
  const [shown, setShown] = useState(delayMs <= 0);
  const pathRef = useRef<SVGPathElement>(null);
  const scale = contained ? CONTAINED_SCALE : BARE_SCALE;

  useEffect(() => {
    if (shown) return;
    const timer = window.setTimeout(() => setShown(true), delayMs);
    return () => window.clearTimeout(timer);
  }, [shown, delayMs]);

  useEffect(() => {
    if (!shown) return;
    const path = pathRef.current;
    if (!path) return;
    if (prefersReducedMotion()) {
      path.setAttribute('d', framePath(scale, true));
      return;
    }
    const paint = (): void => path.setAttribute('d', framePath(scale, false));
    paint();
    return subscribe(paint);
  }, [shown, scale]);

  if (!shown) return null;
  return (
    <span
      className={`shape-loader${contained ? ' contained' : ''}${label ? ' labelled' : ''}${className ? ` ${className}` : ''}`}
      role="status"
      aria-label={label ? undefined : tx('加载中', 'Loading')}
    >
      <svg
        className="shape-loader-mark"
        width={size}
        height={size}
        viewBox="0 0 100 100"
        aria-hidden="true"
      >
        {contained && <circle className="shape-loader-container" cx="50" cy="50" r="50" />}
        <path ref={pathRef} className="shape-loader-shape" />
      </svg>
      {label && <span className="shape-loader-label">{label}</span>}
    </span>
  );
}
