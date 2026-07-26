'use client';

import {
  Activity, AlertTriangle, ChevronLeft, FileText, LogOut, Settings, ShieldCheck, SlidersHorizontal,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { ACTOR } from '@/lib/api';
import { money, pct } from '@/lib/format';
import type { Metrics } from '@/lib/types';

export type SectionId = 'agents' | 'policy' | 'logs' | 'emergency';

const GROUPS: { heading: string; items: { id: SectionId; name: string; icon: LucideIcon }[] }[] = [
  {
    heading: 'Monitor',
    items: [
      { id: 'agents', name: 'Agent Status', icon: Activity },
      { id: 'logs', name: 'Audit Logs', icon: FileText },
    ],
  },
  {
    heading: 'Configure',
    items: [{ id: 'policy', name: 'Policy Editor', icon: SlidersHorizontal }],
  },
  {
    heading: 'Control',
    items: [{ id: 'emergency', name: 'Emergency Controls', icon: AlertTriangle }],
  },
];

export function Sidebar({
  active, onSelect, metrics, connected, onCollapse,
}: {
  active: SectionId;
  onSelect: (id: SectionId) => void;
  metrics: Metrics | null;
  connected: boolean;
  onCollapse?: () => void;
}) {
  const spend = metrics?.fleet_daily_spend ?? 0;
  const cap = metrics?.fleet_daily_cap ?? 0;
  const ratio = cap > 0 ? spend / cap : 0;
  const rt = metrics?.runtime;
  const denied = metrics?.requests_denied ?? 0;

  const badges: Partial<Record<SectionId, { count: number; tone: string }>> = {
    logs: denied > 0 ? { count: denied, tone: 'bg-badDim text-bad' } : { count: 0, tone: '' },
    emergency:
      metrics && metrics.agents_revoked > 0
        ? { count: metrics.agents_revoked, tone: 'bg-badDim text-bad' }
        : { count: 0, tone: '' },
  };

  return (
    <aside className="flex w-full shrink-0 flex-col border-line bg-surface lg:h-screen lg:w-[248px] lg:border-r">
      {/* Brand ------------------------------------------------------------ */}
      <div className="flex items-center gap-3 border-b border-line px-4 py-4">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-ctl bg-info/12">
          <ShieldCheck className="h-5 w-5 text-info" strokeWidth={2} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-text">Governance Layer</p>
          <p className="flex items-center gap-1.5 text-label uppercase text-faint">
            <span
              className={`h-1.5 w-1.5 rounded-full ${connected ? 'animate-breathe bg-ok' : 'bg-warn'}`}
            />
            {rt ? `${rt.policy_engine === 'opa' ? 'OPA' : 'Embedded'} policy engine` : 'connecting'}
          </p>
        </div>
        {onCollapse ? (
          <button
            type="button"
            onClick={onCollapse}
            aria-label="Collapse sidebar"
            className="hidden rounded-ctl p-1 text-faint hover:bg-inset hover:text-soft lg:block"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
        ) : null}
      </div>

      {/* Environment ------------------------------------------------------ */}
      <div className="px-4 py-3">
        <div className="flex items-center gap-2 rounded-ctl border border-line bg-inset px-2.5 py-2">
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${connected ? 'bg-ok' : 'bg-warn'}`} />
          <span className="truncate font-mono text-xs2 text-soft">amex-fleet-01</span>
        </div>
      </div>

      {/* Navigation ------------------------------------------------------- */}
      <nav className="flex-1 overflow-y-auto px-2 pb-2" aria-label="Sections">
        {GROUPS.map((group) => (
          <div key={group.heading} className="mb-1">
            <p className="label px-2 pb-1.5 pt-3">{group.heading}</p>
            <ul>
              {group.items.map(({ id, name, icon: Icon }) => {
                const on = id === active;
                const badge = badges[id];
                return (
                  <li key={id}>
                    <button
                      type="button"
                      onClick={() => onSelect(id)}
                      aria-current={on ? 'page' : undefined}
                      className={`group flex w-full items-center gap-2.5 rounded-ctl px-2.5 py-2 text-left
                                  text-xs2 transition-colors
                                  ${on
                                    ? 'bg-info/10 font-medium text-info'
                                    : 'text-soft hover:bg-inset hover:text-text'}`}
                    >
                      <Icon className="h-4 w-4 shrink-0" strokeWidth={2} />
                      <span className="flex-1 truncate">{name}</span>
                      {badge && badge.count > 0 ? (
                        <span className={`rounded-full px-1.5 py-0.5 text-label num font-semibold ${badge.tone}`}>
                          {badge.count > 999 ? '999+' : badge.count}
                        </span>
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>

      {/* Fleet budget — pinned, because it is the number that outranks whatever
          page the operator happens to be reading. -------------------------- */}
      <div className="border-t border-line px-4 py-3.5">
        <div className="flex items-baseline justify-between">
          <p className="label">Fleet budget</p>
          <p className="text-label num text-faint">{cap ? pct(ratio, 1) : '—'}</p>
        </div>
        <p className="mt-1 text-lg num font-semibold text-text">
          {money(spend, { compact: true })}
          <span className="ml-1 text-xs2 font-normal text-faint">
            / {money(cap, { compact: true })}
          </span>
        </p>
        <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-inset">
          <div
            className={`h-full rounded-full transition-[width] duration-700 ${
              ratio >= 0.8 ? 'bg-bad' : ratio >= 0.5 ? 'bg-warn' : 'bg-ok'
            }`}
            style={{ width: `${Math.min(100, ratio * 100)}%` }}
          />
        </div>
      </div>

      {/* Where the numbers come from. A console that runs on in-process state
          while implying Postgres is a console that lies. ------------------- */}
      {rt ? (
        <div className="border-t border-line px-4 py-3">
          <p className="label pb-1.5">Backing services</p>
          <ul className="flex flex-col gap-1">
            {([
              ['Policy', rt.policy_engine, rt.opa],
              ['Ledger', rt.ledger, rt.postgres],
              ['Counters', rt.counters, rt.redis],
            ] as const).map(([name, value, real]) => (
              <li key={name} className="flex items-baseline justify-between text-label uppercase">
                <span className="text-faint">{name}</span>
                <span className={real ? 'text-ok' : 'text-warn'}>{value}</span>
              </li>
            ))}
          </ul>
          {rt.opa_note ? (
            <p className="mt-2 text-label leading-relaxed text-warn">{rt.opa_note}</p>
          ) : null}
        </div>
      ) : null}

      {/* Operator -------------------------------------------------------- */}
      <div className="border-t border-line px-2 py-2">
        <button type="button" className="flex w-full items-center gap-2.5 rounded-ctl px-2.5 py-2 text-xs2 text-soft hover:bg-inset hover:text-text">
          <Settings className="h-4 w-4" strokeWidth={2} />
          Settings
        </button>
        <button type="button" className="flex w-full items-center gap-2.5 rounded-ctl px-2.5 py-2 text-xs2 text-soft hover:bg-inset hover:text-text">
          <LogOut className="h-4 w-4" strokeWidth={2} />
          Sign out
        </button>
        <div className="mt-1 flex items-center gap-2.5 border-t border-line px-2.5 pt-3">
          <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-info/15 text-label font-semibold text-info">
            {ACTOR.slice(-2).toUpperCase()}
          </span>
          <span className="min-w-0">
            <span className="block truncate font-mono text-xs2 text-text">{ACTOR}</span>
            <span className="block text-label uppercase text-faint">Risk ops</span>
          </span>
        </div>
      </div>
    </aside>
  );
}
