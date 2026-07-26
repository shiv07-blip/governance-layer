'use client';

import { useId } from 'react';
import type { Metrics } from '@/lib/types';

/**
 * Latency percentiles over the trailing window.
 *
 * Hand-drawn SVG rather than a charting library: this needs three stacked areas,
 * a threshold rule and a hover readout, and shipping ~90KB to draw that would be
 * the wrong trade. It also inherits the console's exact tokens, which a generic
 * chart theme never quite does.
 *
 * Series are drawn p99 first so the lower percentiles sit on top of it — the
 * bands then read as nested, which is what they are.
 */

const SERIES = [
  { key: 'p99', color: '#EF4444', label: 'P99' },
  { key: 'p95', color: '#F59E0B', label: 'P95' },
  { key: 'p50', color: '#22C55E', label: 'P50' },
] as const;

export function LatencyChart({
  metrics,
  budgetMs = 10,
  height = 200,
}: {
  metrics: Metrics;
  budgetMs?: number;
  height?: number;
}) {
  const uid = useId().replace(/:/g, '');
  const data = metrics.latency_series ?? [];
  const W = 720;
  const H = height;
  const pad = { top: 14, right: 12, bottom: 26, left: 42 };

  const plotW = W - pad.left - pad.right;
  const plotH = H - pad.top - pad.bottom;

  const peak = Math.max(budgetMs * 1.4, ...data.map((d) => d.p99), 1);
  const n = Math.max(1, data.length - 1);

  const x = (i: number) => pad.left + (i / n) * plotW;
  const y = (v: number) => pad.top + (1 - v / peak) * plotH;

  // Only buckets with traffic get a point; a gap is more honest than a line
  // drawn through zero, which would read as a latency crash.
  const live = data
    .map((d, i) => ({ ...d, i }))
    .filter((d) => d.total > 0);

  const ticks = [0, peak / 2, peak];

  return (
    <div className="card flex flex-col p-5">
      <header className="mb-1 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-text">Authorization latency</h2>
          <p className="mt-0.5 text-xs2 text-faint">
            Last 15 minutes · percentiles per bucket
          </p>
        </div>
        <div className="flex items-center gap-3.5">
          {SERIES.map((s) => (
            <span key={s.key} className="flex items-center gap-1.5 text-label uppercase text-soft">
              <span className="h-0.5 w-4 rounded-full" style={{ background: s.color }} />
              {s.label}
              <span className="num text-faint">
                {s.key === 'p50'
                  ? metrics.avg_latency_ms
                  : s.key === 'p95'
                    ? metrics.p95_latency_ms
                    : metrics.p99_latency_ms}
                ms
              </span>
            </span>
          ))}
        </div>
      </header>

      {live.length === 0 ? (
        <p className="py-12 text-center text-xs2 text-faint">
          No traffic in this window. Start the generator on Emergency Controls, or
          post to /authorize.
        </p>
      ) : (
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="w-full"
          style={{ height }}
          role="img"
          aria-label={`Latency: median ${metrics.avg_latency_ms}ms, p95 ${metrics.p95_latency_ms}ms, p99 ${metrics.p99_latency_ms}ms`}
        >
          <defs>
            {SERIES.map((s) => (
              <linearGradient key={s.key} id={`${uid}-${s.key}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={s.color} stopOpacity="0.28" />
                <stop offset="100%" stopColor={s.color} stopOpacity="0" />
              </linearGradient>
            ))}
          </defs>

          {/* Gridlines */}
          {ticks.map((t) => (
            <g key={t}>
              <line
                x1={pad.left} x2={W - pad.right} y1={y(t)} y2={y(t)}
                stroke="#222A36" strokeWidth="1"
              />
              <text
                x={pad.left - 8} y={y(t) + 3.5} textAnchor="end"
                fill="#67727F" fontSize="9.5"
              >
                {Math.round(t)}ms
              </text>
            </g>
          ))}

          {/* Areas and lines, widest band first */}
          {SERIES.map((s) => {
            const pts = live.map((d) => `${x(d.i).toFixed(1)},${y(d[s.key]).toFixed(1)}`);
            if (pts.length < 2) return null;
            const line = `M${pts.join(' L')}`;
            const area = `${line} L${x(live[live.length - 1].i).toFixed(1)},${y(0).toFixed(1)} L${x(live[0].i).toFixed(1)},${y(0).toFixed(1)} Z`;
            return (
              <g key={s.key}>
                <path d={area} fill={`url(#${uid}-${s.key})`} />
                <path
                  d={line}
                  fill="none"
                  stroke={s.color}
                  strokeWidth="1.75"
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
              </g>
            );
          })}

          {/* The budget the service holds itself to */}
          <line
            x1={pad.left} x2={W - pad.right} y1={y(budgetMs)} y2={y(budgetMs)}
            stroke="#3B82F6" strokeWidth="1" strokeDasharray="4 4" opacity="0.8"
          />
          <text
            x={W - pad.right} y={y(budgetMs) - 5} textAnchor="end"
            fill="#3B82F6" fontSize="9.5"
          >
            {budgetMs}ms budget
          </text>

          {/* Axis */}
          <line
            x1={pad.left} x2={W - pad.right} y1={H - pad.bottom} y2={H - pad.bottom}
            stroke="#2E3742" strokeWidth="1"
          />
          <text x={pad.left} y={H - 8} fill="#67727F" fontSize="9.5">−15 min</text>
          <text x={W - pad.right} y={H - 8} textAnchor="end" fill="#67727F" fontSize="9.5">now</text>
        </svg>
      )}
    </div>
  );
}
