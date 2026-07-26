'use client';

import { useState } from 'react';
import {
  Activity, AlertCircle, Ban, RotateCcw, ShieldCheck, TrendingUp, Users, Zap,
} from 'lucide-react';
import { DecisionSplit, SpendVsCap } from '@/components/Charts';
import { LatencyChart } from '@/components/LatencyChart';
import { Empty, KpiCard, Section, StatusPill, TypeTag, UtilBar } from '@/components/Bits';
import { useToast } from '@/components/Toast';
import { api } from '@/lib/api';
import {
  HIGH_UTILISATION, ago, band, displayStatus, money, pct, ruleLabel, statusExplanation,
} from '@/lib/format';
import type { Agent, LedgerRow, Metrics } from '@/lib/types';

export function AgentStatus({
  agents, metrics, tape, refresh, onOpenTrace,
}: {
  agents: Agent[];
  metrics: Metrics | null;
  tape: LedgerRow[];
  refresh: () => void;
  onOpenTrace: (row: LedgerRow) => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);

  const run = async (key: string, label: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    try {
      await fn();
      toast('ok', label);
      refresh();
    } catch (e) {
      toast('fail', e instanceof Error ? e.message : 'Action failed');
    } finally {
      setBusy(null);
    }
  };

  const total = metrics ? metrics.requests_approved + metrics.requests_denied : 0;
  const approvalRate = total ? (metrics as Metrics).requests_approved / total : 0;
  const atRisk = agents.filter((a) => {
    const s = displayStatus(a);
    return s === 'warning' || s === 'error';
  });
  const fleetRatio = metrics && metrics.fleet_daily_cap
    ? metrics.fleet_daily_spend / metrics.fleet_daily_cap
    : 0;

  return (
    <div className="flex flex-col gap-4">
      {/* Four readouts, each chosen because it prompts a different action ---- */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          label="Fleet daily spend"
          value={metrics ? money(metrics.fleet_daily_spend, { compact: true }) : '—'}
          note={
            metrics
              ? `of ${money(metrics.fleet_daily_cap, { compact: true })} cap · ${pct(fleetRatio, 1)} used`
              : ''
          }
          icon={TrendingUp}
          tone={fleetRatio >= HIGH_UTILISATION ? 'bad' : 'neutral'}
          bar={{
            ratio: fleetRatio,
            className: fleetRatio >= 0.8 ? 'bg-bad' : fleetRatio >= 0.5 ? 'bg-warn' : 'bg-ok',
          }}
        />
        <KpiCard
          label="Approval rate"
          value={total ? pct(approvalRate, 1) : '—'}
          note={
            metrics
              ? `${metrics.requests_approved.toLocaleString()} approved · ${metrics.requests_denied.toLocaleString()} denied`
              : 'no traffic yet'
          }
          icon={ShieldCheck}
          tone={approvalRate < 0.6 && total > 0 ? 'warn' : 'ok'}
        />
        <KpiCard
          label="Auth latency"
          value={metrics ? String(metrics.avg_latency_ms) : '—'}
          unit="ms"
          note={metrics ? `p95 ${metrics.p95_latency_ms}ms · p99 ${metrics.p99_latency_ms}ms` : ''}
          icon={Zap}
          tone={metrics && metrics.p99_latency_ms > 10 ? 'warn' : 'ok'}
        />
        <KpiCard
          label="Agents at risk"
          value={String(atRisk.length)}
          note={
            atRisk.length
              ? `${atRisk.map((a) => displayStatus(a)).filter((s) => s === 'error').length} in error · ${atRisk.filter((a) => displayStatus(a) === 'warning').length} near cap`
              : 'all agents inside their grant'
          }
          icon={AlertCircle}
          tone={atRisk.length ? 'bad' : 'ok'}
        />
      </div>

      {/* Charts ----------------------------------------------------------- */}
      {metrics ? (
        <div className="grid gap-4 xl:grid-cols-[1.55fr_1fr]">
          <LatencyChart metrics={metrics} />
          <DecisionSplit metrics={metrics} />
        </div>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-[1fr_1.1fr]">
        <SpendVsCap agents={agents} />

        {/* Recent decisions, clickable through to the full trace ----------- */}
        <Section
          title="Recent decisions"
          action={
            <span className="text-xs2 num text-faint">
              {tape.length ? `last ${Math.min(tape.length, 12)}` : ''}
            </span>
          }
        >
          {tape.length === 0 ? (
            <Empty
              icon={Activity}
              title="No decisions yet"
              hint="Start the traffic generator on Emergency Controls, or POST to /authorize."
            />
          ) : (
            <ul className="divide-y divide-line/60">
              {tape.slice(0, 12).map((row) => (
                <li key={row.trace_id}>
                  <button
                    type="button"
                    onClick={() => onOpenTrace(row)}
                    className="flex w-full items-center gap-3 px-5 py-2.5 text-left transition-colors hover:bg-surfaceHi"
                  >
                    <span
                      className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                        row.decision === 'APPROVED' ? 'bg-ok' : 'bg-bad'
                      }`}
                    />
                    <span className="w-40 shrink-0 truncate font-mono text-xs2 text-soft">
                      {row.agent_id}
                    </span>
                    <span className="w-20 shrink-0 text-right text-xs2 num font-medium text-text">
                      {money(row.amount)}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-xs2 text-faint">
                      {ruleLabel(row.rule)}
                    </span>
                    <span className="shrink-0 text-label num text-faint">{row.latency_ms}ms</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>

      {/* Agent cards ------------------------------------------------------ */}
      <Section
        title="Fleet agents"
        action={
          <span className="text-xs2 num text-faint">
            {agents.filter((a) => a.status === 'active').length} active / {agents.length} total
          </span>
        }
        className="border-none bg-transparent shadow-none"
      >
        <div className="grid gap-4 pt-4 md:grid-cols-2 2xl:grid-cols-3">
          {agents.length === 0 ? (
            <div className="card md:col-span-2 2xl:col-span-3">
              <Empty
                icon={Users}
                title="No agents registered"
                hint="Agents come from the policy document. Deploy one on Policy Editor."
              />
            </div>
          ) : null}

          {agents.map((a) => {
            const revoked = a.status === 'revoked';
            const status = displayStatus(a);
            return (
              <article
                key={a.id}
                className={`card animate-rise flex flex-col gap-4 p-5 ${revoked ? 'opacity-60' : ''}`}
              >
                <header className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="truncate text-sm font-semibold text-text">{a.name}</h3>
                    <p className="mt-0.5 truncate font-mono text-label text-faint">{a.id}</p>
                  </div>
                  <StatusPill agent={a} />
                </header>

                <TypeTag type={a.type} />

                <div>
                  <div className="mb-1.5 flex items-baseline justify-between gap-3">
                    <span className="text-xs2 text-faint">Daily spend</span>
                    <span className="text-xs2 num text-soft">
                      <span
                        className={`font-semibold ${
                          { calm: 'text-ok', warm: 'text-warn', hot: 'text-bad' }[
                            band(a.daily_spend, a.daily_cap)
                          ]
                        }`}
                      >
                        {money(a.daily_spend, { compact: true })}
                      </span>
                      {' / '}
                      {money(a.daily_cap, { compact: true })}
                    </span>
                  </div>
                  <UtilBar used={a.daily_spend} cap={a.daily_cap} width="w-full" showPct={false} />
                </div>

                <dl className="grid grid-cols-3 gap-3 border-t border-line pt-3.5">
                  {([
                    ['Per txn', a.single_cap ? money(a.single_cap, { compact: true }) : '—'],
                    ['Refused', a.decisions ? pct(a.denial_rate, 0) : '—'],
                    ['Last seen', ago(a.last_action_at)],
                  ] as const).map(([k, v]) => (
                    <div key={k}>
                      <dt className="label">{k}</dt>
                      <dd className="mt-0.5 text-xs2 num text-soft">{v}</dd>
                    </div>
                  ))}
                </dl>

                {status !== 'active' ? (
                  <p
                    className={`rounded-ctl px-3 py-2 text-label leading-relaxed ${
                      status === 'revoked'
                        ? 'bg-inset text-faint'
                        : status === 'error'
                          ? 'bg-badDim text-bad'
                          : 'bg-warnDim text-warn'
                    }`}
                  >
                    {statusExplanation(a)}
                  </p>
                ) : null}

                <footer className="mt-auto flex gap-2 border-t border-line pt-3.5">
                  <button
                    type="button"
                    className="btn-ghost flex-1"
                    disabled={busy === `${a.id}:reset` || a.daily_spend === 0}
                    onClick={() =>
                      run(`${a.id}:reset`, `Spend counter cleared — ${a.id}`, () =>
                        api.resetBudget(a.id),
                      )
                    }
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                    Clear spend
                  </button>
                  {revoked ? (
                    <button
                      type="button"
                      className="btn-ok-outline flex-1"
                      disabled={busy === `${a.id}:in`}
                      onClick={() =>
                        run(`${a.id}:in`, `Returned to service — ${a.id}`, () => api.reinstate(a.id))
                      }
                    >
                      Reinstate
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="btn-danger-outline flex-1"
                      disabled={busy === `${a.id}:rev`}
                      onClick={() =>
                        run(`${a.id}:rev`, `Revoked — ${a.id}`, () =>
                          api.revoke(a.id, 'Revoked from the agent list.'),
                        )
                      }
                    >
                      <Ban className="h-3.5 w-3.5" />
                      Revoke
                    </button>
                  )}
                </footer>
              </article>
            );
          })}
        </div>
      </Section>
    </div>
  );
}
