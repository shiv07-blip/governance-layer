'use client';

import { band, money, pct, ruleLabel } from '@/lib/format';
import type { Agent, Metrics } from '@/lib/types';

/**
 * Spend against cap, one bar per agent.
 *
 * The bar is drawn as a proportion of the agent's *own* cap rather than a shared
 * dollar axis. Agents here have caps from $30K to $200K, so a shared axis would
 * make a small agent at 95% of its ceiling look safer than a large one at 30% —
 * exactly backwards from what the operator needs to see. The cap in dollars is
 * printed beside each bar so the absolute figure is not lost.
 */
export function SpendVsCap({ agents }: { agents: Agent[] }) {
  const ordered = [...agents].sort(
    (a, b) => (b.daily_spend / (b.daily_cap || 1)) - (a.daily_spend / (a.daily_cap || 1)),
  );

  return (
    <div className="card flex flex-col p-5">
      <header className="mb-4">
        <h2 className="text-sm font-semibold text-text">Spend against cap</h2>
        <p className="mt-0.5 text-xs2 text-faint">
          Each bar is a share of that agent&apos;s own ceiling
        </p>
      </header>

      <ul className="flex flex-col gap-3.5">
        {ordered.map((a) => {
          const ratio = a.daily_cap > 0 ? Math.min(1, a.daily_spend / a.daily_cap) : 0;
          const fill = { calm: 'bg-ok', warm: 'bg-warn', hot: 'bg-bad' }[band(a.daily_spend, a.daily_cap)];
          const tone = { calm: 'text-ok', warm: 'text-warn', hot: 'text-bad' }[band(a.daily_spend, a.daily_cap)];
          return (
            <li key={a.id}>
              <div className="mb-1.5 flex items-baseline justify-between gap-3">
                <span className="truncate font-mono text-xs2 text-soft">{a.id}</span>
                <span className="shrink-0 text-xs2 num text-faint">
                  <span className={`font-medium ${tone}`}>{money(a.daily_spend, { compact: true })}</span>
                  {' / '}
                  {money(a.daily_cap, { compact: true })}
                  <span className={`ml-2 font-medium ${tone}`}>{pct(ratio, 0)}</span>
                </span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-inset">
                <div
                  className={`h-full rounded-full transition-[width] duration-700 ease-out ${fill}`}
                  style={{ width: `${ratio * 100}%` }}
                />
              </div>
            </li>
          );
        })}
      </ul>

      {agents.length === 0 ? (
        <p className="py-6 text-center text-xs2 text-faint">No agents registered.</p>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------- donut */

export function DecisionSplit({ metrics }: { metrics: Metrics }) {
  const ok = metrics.requests_approved;
  const no = metrics.requests_denied;
  const total = ok + no;
  const share = total ? ok / total : 0;

  // Stroke-dash arithmetic on a circle: circumference is 2*pi*r.
  const r = 42;
  const c = 2 * Math.PI * r;

  return (
    <div className="card flex flex-col p-5">
      <header className="mb-4">
        <h2 className="text-sm font-semibold text-text">Decision split</h2>
        <p className="mt-0.5 text-xs2 text-faint">Every decision on record</p>
      </header>

      <div className="flex items-center gap-6">
        <div className="relative shrink-0">
          <svg width="112" height="112" viewBox="0 0 112 112" role="img"
               aria-label={`${pct(share, 1)} approved of ${total} decisions`}>
            <circle cx="56" cy="56" r={r} fill="none" stroke="#EF4444" strokeWidth="11" />
            <circle
              cx="56" cy="56" r={r} fill="none" stroke="#22C55E" strokeWidth="11"
              strokeDasharray={`${c * share} ${c}`}
              strokeLinecap="round"
              transform="rotate(-90 56 56)"
              className="transition-all duration-700"
            />
          </svg>
          <span className="absolute inset-0 grid place-items-center">
            <span className="text-base num font-semibold text-text">{pct(share, 1)}</span>
          </span>
        </div>

        <dl className="min-w-0 flex-1 space-y-2.5">
          {([
            ['Approved', ok, 'bg-ok', 'text-ok'],
            ['Denied', no, 'bg-bad', 'text-bad'],
          ] as const).map(([label, value, dot, tone]) => (
            <div key={label} className="flex items-baseline justify-between gap-3">
              <dt className="flex items-center gap-2 text-xs2 text-soft">
                <span className={`h-2 w-2 rounded-full ${dot}`} />
                {label}
              </dt>
              <dd className={`text-xs2 num font-semibold ${tone}`}>{value.toLocaleString()}</dd>
            </div>
          ))}
          <div className="flex items-baseline justify-between gap-3 border-t border-line pt-2.5">
            <dt className="text-xs2 text-faint">Total</dt>
            <dd className="text-xs2 num font-semibold text-text">{total.toLocaleString()}</dd>
          </div>
        </dl>
      </div>

      {metrics.denial_breakdown.length > 0 ? (
        <div className="mt-5 border-t border-line pt-4">
          <p className="label pb-2.5">Why requests were refused</p>
          <ul className="flex flex-col gap-2">
            {metrics.denial_breakdown.slice(0, 5).map((d) => {
              const worst = metrics.denial_breakdown[0].count;
              return (
                <li key={d.rule}>
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="truncate text-xs2 text-soft">{ruleLabel(d.rule)}</span>
                    <span className="shrink-0 text-xs2 num text-faint">{d.count}</span>
                  </div>
                  <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-inset">
                    <div className="h-full rounded-full bg-bad/70" style={{ width: `${(d.count / worst) * 100}%` }} />
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
