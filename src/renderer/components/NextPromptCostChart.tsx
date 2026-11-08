/**
 * @file NextPromptCostChart.tsx
 * @purpose Bar chart of what next prompt suggestions cost each day over the last 14 days,
 *   shown under the running total in Settings → AI.
 *
 * @关键设计:
 * - One series, so one hue (the theme's primary) and no legend; the row label names it
 * - Days without calls are left as gaps on the baseline, so a quiet day reads as zero
 * - Hovering a day shows its date, cost and calls; the whole column is the hit target
 *
 * @对应文档章节:docs/软件定义书.md ADR-025
 *
 * @不要在这里做的事:
 * - 不要在这里算花费,数据来自 main 的 NextPromptUsageTracker(next-prompt-usage.json)
 */
import { useState } from 'react';
import { dailyCosts, type NextPromptUsage } from '@shared/next-prompt';
import { useTranslation } from './LanguageProvider';

const WIDTH = 280;
const HEIGHT = 72;
const BAR_GAP = 2;
const RADIUS = 4;

/** Six decimals below a cent, since one suggestion costs millionths of a dollar. */
export function formatUsd(usd: number): string {
  return `$${usd.toFixed(usd < 0.01 ? 6 : 4)}`;
}

/** A bar with a rounded top and a square foot on the baseline. */
function barPath(x: number, y: number, w: number, h: number): string {
  const r = Math.min(RADIUS, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

export function NextPromptCostChart({ usage }: { usage: NextPromptUsage }): JSX.Element {
  const { tx } = useTranslation();
  const [hover, setHover] = useState<number | null>(null);
  const days = dailyCosts(usage, new Date());
  const max = Math.max(...days.map((d) => d.costUsd));
  const slot = WIDTH / days.length;
  const short = (day: string): string => {
    const [, m, d] = day.split('-');
    return `${Number(m)}/${Number(d)}`;
  };
  const shown = hover === null ? null : days[hover];

  return (
    <div className="next-prompt-chart">
      <div className="next-prompt-chart-head">
        {shown ? (
          <span>
            {short(shown.day)} · {formatUsd(shown.costUsd)} · {shown.calls} {tx('次', 'calls')}
          </span>
        ) : (
          <span>{tx(`近 14 天,单日最高 ${formatUsd(max)}`, `Last 14 days, highest day ${formatUsd(max)}`)}</span>
        )}
      </div>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        width={WIDTH}
        height={HEIGHT}
        role="img"
        aria-label={days.map((d) => `${d.day} ${formatUsd(d.costUsd)}`).join(', ')}
        onMouseLeave={() => setHover(null)}
      >
        {days.map((d, i) => {
          const h = max > 0 ? (d.costUsd / max) * (HEIGHT - 1) : 0;
          const x = i * slot + BAR_GAP / 2;
          return (
            <g key={d.day} onMouseEnter={() => setHover(i)}>
              <rect x={i * slot} y={0} width={slot} height={HEIGHT} fill="transparent" />
              {h > 0 && (
                <path
                  d={barPath(x, HEIGHT - 1 - h, slot - BAR_GAP, h)}
                  className={hover === i ? 'next-prompt-chart-bar is-hover' : 'next-prompt-chart-bar'}
                />
              )}
            </g>
          );
        })}
        <line x1={0} x2={WIDTH} y1={HEIGHT - 0.5} y2={HEIGHT - 0.5} className="next-prompt-chart-axis" />
      </svg>
      <div className="next-prompt-chart-foot">
        <span>{short(days[0]!.day)}</span>
        <span>{tx('今天', 'Today')}</span>
      </div>
    </div>
  );
}
