'use client';

import type { LucideIcon } from 'lucide-react';
import { ChevronsUpDown } from 'lucide-react';
import {
  BAND_FG, band, displayStatus, pct, STATUS_STYLE, titleCase, typeStyle,
} from '@/lib/format';
import type { Agent, Decision } from '@/lib/types';

/* -------------------------------------------------------------- KPI card */

const KPI_TONE = {
  neutral: 'text-text',
  ok: 'text-ok',
  warn: 'text-warn',
  bad: 'text-bad',
  info: 'text-info',
} as const;

export function KpiCard({
  label, value, unit, note, icon: Icon, tone = 'neutral', bar,
}: {
  label: string;
  value: string;
  unit?: string;
  note?: string;
  icon: LucideIcon;
  tone?: keyof typeof KPI_TONE;
  /** Optional progress footer, 0–1. */
  bar?: { ratio: number; className: string };
}) {
  return (
    <div className="card animate-rise flex flex-col gap-3 p-5">
      <div className="flex items-start justify-between gap-3">
        <p className="label">{label}</p>
        <Icon className={`h-4 w-4 shrink-0 ${KPI_TONE[tone]}`} strokeWidth={2} />
      </div>

      <p className={`text-kpi num font-semibold ${KPI_TONE[tone]}`}>
        {value}
        {unit ? <span className="ml-1 text-base font-medium text-faint">{unit}</span> : null}
      </p>

      {note ? <p className="text-xs2 num text-faint">{note}</p> : null}

      {bar ? (
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-inset">
          <div
            className={`h-full rounded-full transition-[width] duration-700 ease-out ${bar.className}`}
            style={{ width: `${Math.min(100, Math.max(0, bar.ratio * 100))}%` }}
          />
        </div>
      ) : null}
    </div>
  );
}

/* ---------------------------------------------------------------- section */

export function Section({
  title, action, children, className = '',
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`card ${className}`}>
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-3.5">
        <h2 className="text-sm font-semibold text-text">{title}</h2>
        {action}
      </header>
      {children}
    </section>
  );
}

/* ------------------------------------------------------------------ pills */

export function StatusPill({ agent }: { agent: Agent }) {
  const s = STATUS_STYLE[displayStatus(agent)];
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs2 font-medium ${s.text}`}>
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${s.dot}`} />
      {s.label}
    </span>
  );
}

export function TypeTag({ type }: { type: string }) {
  const s = typeStyle(type);
  return <span className={`tag ${s.bg} ${s.text}`}>{titleCase(type)}</span>;
}

export function DecisionPill({ decision }: { decision: Decision }) {
  const ok = decision === 'APPROVED';
  return (
    <span
      className={`pill ${ok ? 'bg-okDim text-ok' : 'bg-badDim text-bad'}`}
    >
      {ok ? '✓' : '✕'} {ok ? 'Approved' : 'Denied'}
    </span>
  );
}

/* -------------------------------------------------------- utilisation bar */

export function UtilBar({
  used, cap, showPct = true, width = 'w-24',
}: {
  used: number;
  cap: number;
  showPct?: boolean;
  width?: string;
}) {
  const ratio = cap > 0 ? Math.min(1, used / cap) : 0;
  const b = band(used, cap);
  const fill = { calm: 'bg-ok', warm: 'bg-warn', hot: 'bg-bad' }[b];

  return (
    <div className="flex items-center gap-2.5">
      <div
        className={`h-1.5 ${width} overflow-hidden rounded-full bg-inset`}
        role="meter"
        aria-valuenow={Math.round(ratio * 100)}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className={`h-full rounded-full transition-[width] duration-700 ease-out ${fill}`}
          style={{ width: `${ratio * 100}%` }}
        />
      </div>
      {showPct ? (
        <span className={`w-9 text-right text-xs2 num font-medium ${BAND_FG[b].replace('text-live', 'text-ok').replace('text-sodium', 'text-warn').replace('text-trip', 'text-bad')}`}>
          {pct(ratio, 0)}
        </span>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------- sortable heading */

export function SortHeader<K extends string>({
  column, label, active, direction, onSort, align = 'left',
}: {
  column: K;
  label: string;
  active: K;
  direction: 'asc' | 'desc';
  onSort: (c: K) => void;
  align?: 'left' | 'right';
}) {
  const on = active === column;
  return (
    <th
      className={`th ${align === 'right' ? 'text-right' : ''}`}
      // aria-sort belongs on the header cell, not the button inside it.
      aria-sort={on ? (direction === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <button
        type="button"
        onClick={() => onSort(column)}
        className={`inline-flex items-center gap-1 transition-colors hover:text-soft
                    ${on ? 'text-text' : ''} ${align === 'right' ? 'flex-row-reverse' : ''}`}
      >
        {label}
        <ChevronsUpDown
          className={`h-3 w-3 ${on ? 'text-info' : 'text-line'}`}
          strokeWidth={2.5}
        />
      </button>
    </th>
  );
}

/* ------------------------------------------------------------ empty state */

export function Empty({ icon: Icon, title, hint }: { icon: LucideIcon; title: string; hint: string }) {
  return (
    <div className="flex flex-col items-center gap-2 px-5 py-14 text-center">
      <Icon className="h-7 w-7 text-line" strokeWidth={1.6} />
      <p className="text-sm font-medium text-soft">{title}</p>
      <p className="max-w-sm text-xs2 leading-relaxed text-faint">{hint}</p>
    </div>
  );
}

/* ----------------------------------------------------------------- loader */

export function Skeleton({ className = 'h-28' }: { className?: string }) {
  return (
    <div className={`card relative overflow-hidden ${className}`}>
      <span className="absolute inset-y-0 w-1/3 animate-shimmer bg-gradient-to-r from-transparent via-line/50 to-transparent" />
    </div>
  );
}
