/**
 * @file src/renderer/components/AgentWave.tsx
 * @purpose The wavy line under a running tab (ADR-021). Its shape says what kind of work the
 *   agent is doing and its speed how fast it generates:
 *   - generating:quick tight ripples, faster with more tokens per second
 *   - waiting:a long slow swell that breathes (hooks, the API starting up)
 *   - tool:a nearly flat line with a pulse travelling along it
 *   - unknown (plain shell, Codex):the steady wave of earlier versions
 *   When the tab stops running the wave flattens, then fades.
 *
 * @关键设计:
 * - Drawn as an SVG path from requestAnimationFrame, because the shapes morph into each other
 *   and the tool pulse moves along the line; a CSS mask can only slide one fixed shape.
 * - Shape values ease toward their targets every frame, so a change of work morphs instead
 *   of jumping.
 * - The loop runs only while the tab is running or settling. Idle tabs cost nothing.
 * - prefers-reduced-motion: a still wave while running, no loop.
 *
 * @不要在这里做的事:
 * - Do not decide the work kind or pace here; main reads them from the screen
 *   (src/shared/agent-phase.ts) and they arrive on SessionInfo.
 */
import { useEffect, useRef } from 'react';
import type { AgentWork } from '@shared/types';

interface AgentWaveProps {
  running: boolean;
  /** Selected tabs show their underline again at once when they stop, so no fade there. */
  selected: boolean;
  work: AgentWork | null;
  pace: number | null;
}

interface Shape {
  amp: number;
  lam: number;
  /** Cycles per second. */
  speed: number;
  /** Strength of the travelling pulse, 0 to 1. */
  pulse: number;
  breathe: boolean;
}

const TAU = Math.PI * 2;
const HEIGHT = 8;
const MID = HEIGHT / 2;
/** The tab's own padding on each side of the line. */
const INSET = 20;

function targetShape(running: boolean, work: AgentWork | null, pace: number | null): Shape {
  if (!running) return { amp: 0, lam: 16, speed: 0.3, pulse: 0, breathe: false };
  switch (work) {
    case 'generating': {
      const p = pace ?? 0.5;
      return { amp: 2 + 0.8 * p, lam: 11, speed: 0.8 + 2.4 * p, pulse: 0, breathe: false };
    }
    case 'waiting':
      return { amp: 1.8, lam: 30, speed: 0.45, pulse: 0, breathe: true };
    case 'tool':
      return { amp: 0.5, lam: 14, speed: 1, pulse: 1, breathe: false };
    default:
      return { amp: 2.6, lam: 16, speed: 1 / 0.65, pulse: 0, breathe: false };
  }
}

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function AgentWave({ running, selected, work, pace }: AgentWaveProps): JSX.Element {
  const svgRef = useRef<SVGSVGElement>(null);
  const pathRef = useRef<SVGPathElement>(null);
  // Live values the frame loop eases toward the target; kept across renders.
  const live = useRef({ amp: 0, lam: 16, speed: 1, pulse: 0, phase: 0, pulseAt: 0, t: 0 });
  const target = useRef<Shape>(targetShape(running, work, pace));
  const frame = useRef<number | null>(null);

  target.current = targetShape(running, work, pace);

  useEffect(() => {
    const svg = svgRef.current;
    const path = pathRef.current;
    if (!svg || !path) return;

    const draw = (dtSec: number, still: boolean): boolean => {
      const s = live.current;
      const g = target.current;
      const k = (rate: number): number => 1 - Math.exp(-dtSec * rate);
      s.t += dtSec;
      s.amp += (g.amp - s.amp) * k(running ? 6 : 5);
      s.lam += (g.lam - s.lam) * k(5);
      s.speed += (g.speed - s.speed) * k(5);
      s.pulse += (g.pulse - s.pulse) * k(6);
      if (!still) {
        s.phase += dtSec * TAU * s.speed;
        s.pulseAt = (s.pulseAt + dtSec * 0.85) % 1.4; // 0..1 across the tab, then a short gap
      }
      const width = Math.max(10, (svg.parentElement?.clientWidth ?? 0) - INSET);
      const breathe = g.breathe ? 0.8 + 0.2 * Math.sin(s.t * 2.2) : 1;
      let d = '';
      for (let x = 0; x <= width; x += 1) {
        const z = (x / width - (s.pulseAt - 0.2)) / 0.09;
        const env = s.pulse * 2.6 * Math.exp(-z * z);
        const y = (s.amp * breathe + env) * Math.sin((TAU * x) / s.lam - s.phase);
        d += `${x ? 'L' : 'M'}${x} ${(MID - y).toFixed(2)}`;
      }
      svg.setAttribute('width', String(width));
      path.setAttribute('d', d);
      const visible = s.amp > 0.15 || s.pulse > 0.15;
      svg.classList.toggle('visible', visible && !(selected && !running));
      // Keep going while running, or until the flattened line has faded.
      return running || visible;
    };

    if (prefersReducedMotion()) {
      // Jump straight to the target shape and stay still.
      const s = live.current;
      const g = target.current;
      Object.assign(s, { amp: g.amp, lam: g.lam, speed: g.speed, pulse: 0 });
      draw(0, true);
      return;
    }

    let last = performance.now();
    const tick = (now: number): void => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      frame.current = draw(dt, false) ? requestAnimationFrame(tick) : null;
    };
    if (frame.current === null) frame.current = requestAnimationFrame(tick);
    return () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
    };
  }, [running, selected, work, pace]);

  return (
    <svg ref={svgRef} className={`tab-wave${selected && !running ? ' instant' : ''}`} height={HEIGHT} aria-hidden="true">
      <path ref={pathRef} />
    </svg>
  );
}
