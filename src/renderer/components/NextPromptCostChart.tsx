/**
 * @file NextPromptCostChart.tsx
 * @purpose Stacked bar chart of what next prompt suggestions cost each day over the last
 *   14 days, one segment per model, shown under the running total in Settings → AI.
 *
 * @关键设计:
 * - A model keeps its colour slot from the day it first appears, so switching models
 *   mid-window never repaints the bars already drawn (dailyCostChart owns the order)
 * - Four colour slots, then a gray "other"; the colours are a CVD checked set with light
 *   and dark steps, picked by CSS light-dark() from the theme's color-scheme
 * - Segments are split by a 2px gap; only the top of a bar is rounded
 * - The legend names every model, and hovering a day lists its parts with cost and
 *   calls, so colour is never the only way to tell models apart
 *
 * @对应文档章节:docs/软件定义书.md ADR-025
 *
 * @不要在这里做的事:
 * - 不要在这里算花费,数据来自 main 的 NextPromptUsageTracker(next-prompt-usage.json)
 */
import { useState } from 'react';
import {
  OTHER_MODELS,
  UNKNOWN_MODEL,
  dailyCostChart,
  type NextPromptUsage,
} from '@shared/next-prompt';
import { useTranslation } from './LanguageProvider';

const WIDTH = 280;
const HEIGHT = 72;
const BAR_GAP = 2;
const SEGMENT_GAP = 2;
const RADIUS = 4;
const SLOTS = 4;

/** Six decimals below a cent, since one suggestion costs millionths of a dollar. */
export function formatUsd(usd: number): string {
  return `$${usd.toFixed(usd < 0.01 ? 6 : 4)}`;
}

/** A segment; the top one of a bar gets rounded corners, the rest stay square. */
function segmentPath(x: number, y: number, w: number, h: number, rounded: boolean): string {
  const r = rounded ? Math.min(RADIUS, w / 2, h) : 0;
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

function seriesColor(key: string, index: number): string {
  return key === OTHER_MODELS ? 'var(--np-series-other)' : `var(--np-series-${(index % SLOTS) + 1})`;
}

export function NextPromptCostChart({ usage }: { usage: NextPromptUsage }): JSX.Element {
  const { tx } = useTranslation();
  const [hover, setHover] = useState<number | null>(null);
  const { series, days } = dailyCostChart(usage, new Date(), 14, SLOTS);
  const max = Math.max(...days.map((d) => d.costUsd));
  const slot = WIDTH / days.length;
  const short = (day: string): string => {
    const [, m, d] = day.split('-');
    return `${Number(m)}/${Number(d)}`;
  };
  const name = (key: string): string =>
    key === OTHER_MODELS
      ? tx('其他模型', 'Other models')
      : key === UNKNOWN_MODEL
        ? tx('未记录模型', 'Model not recorded')
        : (key.split('/').pop() ?? key);
  const shown = hover === null ? null : days[hover];

  return (
    <div className="next-prompt-chart">
      <div className="next-prompt-chart-head">
        {tx(`近 14 天,单日最高 ${formatUsd(max)}`, `Last 14 days, highest day ${formatUsd(max)}`)}
      </div>
      <div className="next-prompt-chart-plot">
        <svg
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          width={WIDTH}
          height={HEIGHT}
          role="img"
          aria-label={days.map((d) => `${d.day} ${formatUsd(d.costUsd)}`).join(', ')}
          onMouseLeave={() => setHover(null)}
        >
          {days.map((d, i) => {
            const x = i * slot + BAR_GAP / 2;
            const w = slot - BAR_GAP;
            const top = d.parts.reduce((last, p, k) => (p.costUsd > 0 ? k : last), -1);
            let base = HEIGHT - 1;
            return (
              <g
                key={d.day}
                onMouseEnter={() => setHover(i)}
                className={hover !== null && hover !== i ? 'is-dim' : undefined}
              >
                <rect x={i * slot} y={0} width={slot} height={HEIGHT} fill="transparent" />
                {d.parts.map((p, k) => {
                  if (p.costUsd <= 0 || max <= 0) return null;
                  const h = (p.costUsd / max) * (HEIGHT - 1);
                  base -= h;
                  // The gap comes out of the lower segment so the bar keeps its true height.
                  const drawn = k === top ? h : Math.max(h - SEGMENT_GAP, 0.5);
                  return (
                    <path
                      key={p.key}
                      d={segmentPath(x, base + (h - drawn), w, drawn, k === top)}
                      fill={seriesColor(p.key, k)}
                    />
                  );
                })}
              </g>
            );
          })}
          <line x1={0} x2={WIDTH} y1={HEIGHT - 0.5} y2={HEIGHT - 0.5} className="next-prompt-chart-axis" />
        </svg>
        {shown && (
          // Beside the plot, not over it, so the tip never hides the neighbouring bars.
          <div className="next-prompt-chart-tip" style={{ left: WIDTH + 12 }}>
            <div className="next-prompt-chart-tip-title">
              {short(shown.day)} · {formatUsd(shown.costUsd)} · {shown.calls} {tx('次', 'calls')}
            </div>
            {shown.parts
              .map((p, k) => ({ ...p, k }))
              .filter((p) => p.calls > 0)
              .reverse()
              .map((p) => (
                <div key={p.key} className="next-prompt-chart-tip-row">
                  <i style={{ background: seriesColor(p.key, p.k) }} />
                  <span>{name(p.key)}</span>
                  <span>
                    {formatUsd(p.costUsd)} · {p.calls} {tx('次', 'calls')}
                  </span>
                </div>
              ))}
          </div>
        )}
      </div>
      <div className="next-prompt-chart-foot">
        <span>{short(days[0]!.day)}</span>
        <span>{tx('今天', 'Today')}</span>
      </div>
      {series.length > 1 && (
        <div className="next-prompt-chart-legend">
          {series.map((key, k) => (
            <span key={key}>
              <i style={{ background: seriesColor(key, k) }} />
              {name(key)}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
