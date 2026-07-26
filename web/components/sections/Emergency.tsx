'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Activity, AlertTriangle, Ban, CircleSlash, Gauge, RotateCcw, ScrollText, Siren, Target,
} from 'lucide-react';
import { Empty, KpiCard, Section, StatusPill, TypeTag, UtilBar } from '@/components/Bits';
import { HoldButton } from '@/components/HoldButton';
import { useToast } from '@/components/Toast';
import { api } from '@/lib/api';
import { ago, displayStatus, money, stamp } from '@/lib/format';
import type { Agent, ControlRow, Metrics } from '@/lib/types';

const ACTION_TONE: Record<string, string> = {
  revoke: 'text-bad',
  halt_fleet: 'text-bad',
  reinstate: 'text-ok',
  reinstate_fleet: 'text-ok',
  reset_budget: 'text-warn',
  reset_all: 'text-warn',
  deploy_policy: 'text-info',
  release: 'text-soft',
  seed: 'text-faint',
};

export function Emergency({
  agents, metrics, refresh,
}: {
  agents: Agent[];
  metrics: Metrics | null;
  refresh: () => void;
}) {
  const toast = useToast();
  const [log, setLog] = useState<ControlRow[]>([]);
  const [reason, setReason] = useState('');
  const [rate, setRate] = useState(6);

  const loadLog = useCallback(() => {
    api.controlLog(20).then(setLog).catch(() => {});
  }, []);

  useEffect(() => {
    loadLog();
    const id = setInterval(loadLog, 4000);
    return () => clearInterval(id);
  }, [loadLog]);

  const live = agents.filter((a) => a.status === 'active');
  const held = agents.filter((a) => a.status === 'revoked');
  const errored = agents.filter((a) => displayStatus(a) === 'error');

  const after = (msg: string) => {
    toast('ok', msg);
    refresh();
    loadLog();
  };

  const guard = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      after(ok);
    } catch (e) {
      toast('fail', e instanceof Error ? e.message : 'Action failed');
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {/* Fleet actions ---------------------------------------------------- */}
      <div className="card border-bad/35 p-5 shadow-glowBad">
        <div className="flex items-start gap-4">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-ctl bg-badDim">
            <AlertTriangle className="h-5 w-5 text-bad" strokeWidth={2} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold text-bad">Emergency stop</h2>
            <p className="mt-1.5 max-w-3xl text-xs2 leading-relaxed text-soft">
              Halting revokes every agent at once. Work already authorized will
              settle; nothing new is permitted until agents are reinstated. Spend
              counters are left alone, so the record of what was committed today
              survives the stop. Every action here is written to the control log
              against your operator id.
            </p>

            <label className="mt-4 block max-w-xl">
              <span className="label">Reason for the log</span>
              <input
                className="field mt-1.5"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="e.g. dispute agent approving duplicate claims"
              />
            </label>

            <div className="mt-4 flex flex-wrap items-center gap-2.5">
              <HoldButton
                label="Halt entire fleet"
                holdingLabel="Holding"
                icon={Siren}
                variant="danger"
                disabled={live.length === 0}
                onFire={() =>
                  guard(
                    () => api.haltFleet(reason || 'Fleet stop from the control panel.'),
                    `Fleet halted — ${live.length} agents revoked`,
                  ).then(() => setReason(''))
                }
              />
              <HoldButton
                label="Reset all budgets"
                holdingLabel="Holding"
                icon={RotateCcw}
                variant="danger-outline"
                onFire={() => guard(() => api.resetAllBudgets(), 'Every spend counter cleared')}
              />
              <button
                type="button"
                className="btn-ok-outline"
                disabled={held.length === 0}
                onClick={() =>
                  guard(() => api.reinstateFleet(), `${held.length} agents returned to service`)
                }
              >
                Reinstate all agents
              </button>

              <span className="ml-auto pill bg-badDim text-bad">
                <AlertTriangle className="h-3 w-3" />
                High-risk zone
              </span>
            </div>

            <p className="mt-3 text-label leading-relaxed text-faint">
              Destructive actions need a press and hold, not a click. Release
              before the fill completes to cancel.
            </p>
          </div>
        </div>
      </div>

      {/* Fleet state ------------------------------------------------------ */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          label="Authorizing now"
          value={String(live.length)}
          note={live.length === 0 ? 'fleet is fully stopped' : 'agents able to move money'}
          icon={Activity}
          tone={live.length === 0 ? 'bad' : 'ok'}
        />
        <KpiCard
          label="Held"
          value={String(held.length)}
          note="revoked, refusing every request"
          icon={CircleSlash}
          tone={held.length ? 'bad' : 'neutral'}
        />
        <KpiCard
          label="In error"
          value={String(errored.length)}
          note={errored.length ? 'refused more often than not' : 'no agent is being refused heavily'}
          icon={AlertTriangle}
          tone={errored.length ? 'warn' : 'ok'}
        />
        <KpiCard
          label="Committed today"
          value={metrics ? money(metrics.fleet_daily_spend, { compact: true }) : '—'}
          note="cleared by a budget reset, not by a halt"
          icon={Gauge}
          tone="neutral"
        />
      </div>

      {/* Per-agent controls ---------------------------------------------- */}
      <Section
        title="Individual agent controls"
        action={<span className="text-xs2 num text-faint">{agents.length} agents</span>}
      >
        <div className="overflow-x-auto">
          <table className="w-full min-w-[54rem] border-collapse">
            <thead>
              <tr className="border-b border-line">
                {['Agent', 'Type', 'Status', 'Daily spend', 'Utilization', 'Actions'].map((h) => (
                  <th key={h} className={`th ${h === 'Actions' ? 'text-right' : ''}`}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {agents.map((a) => (
                <tr key={a.id} className="border-b border-line/50">
                  <td className="td">
                    <span className="block text-xs2 font-medium text-text">{a.name}</span>
                    <span className="block font-mono text-label text-faint">{a.id}</span>
                  </td>
                  <td className="td"><TypeTag type={a.type} /></td>
                  <td className="td"><StatusPill agent={a} /></td>
                  <td className="td whitespace-nowrap num">
                    <span className="font-medium text-text">
                      {money(a.daily_spend, { compact: true })}
                    </span>
                    <span className="text-faint"> / {money(a.daily_cap, { compact: true })}</span>
                  </td>
                  <td className="td"><UtilBar used={a.daily_spend} cap={a.daily_cap} /></td>
                  <td className="td text-right">
                    <div className="inline-flex items-center gap-2">
                      <button
                        type="button"
                        className="btn-ghost"
                        disabled={a.daily_spend === 0}
                        onClick={() =>
                          guard(() => api.resetBudget(a.id), `Spend cleared — ${a.id}`)
                        }
                      >
                        Clear
                      </button>
                      {a.status === 'revoked' ? (
                        <button
                          type="button"
                          className="btn-ok-outline"
                          onClick={() =>
                            guard(() => api.reinstate(a.id), `Returned to service — ${a.id}`)
                          }
                        >
                          Release
                        </button>
                      ) : (
                        <HoldButton
                          label="Revoke"
                          icon={Ban}
                          variant="danger-outline"
                          holdMs={700}
                          onFire={() =>
                            guard(
                              () => api.revoke(a.id, reason || 'Held from emergency controls.'),
                              `Revoked — ${a.id}`,
                            )
                          }
                        />
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {agents.length === 0 ? (
          <Empty icon={Target} title="No agents registered" hint="Deploy a policy to register agents." />
        ) : null}
      </Section>

      <div className="grid gap-4 xl:grid-cols-[1fr_1.4fr]">
        {/* Traffic generator. Calls the real /authorize path, so the latency and
            refusal figures on this console are measured, not staged. --------- */}
        <Section title="Traffic generator">
          <div className="flex flex-col gap-4 p-5">
            <p className="text-xs2 leading-relaxed text-faint">
              Drives sample work through the live authorization path so the console
              shows real enforcement under load. It does not fabricate log rows.
            </p>

            <label className="flex items-center gap-3">
              <span className="label shrink-0">Rate</span>
              <input
                type="range" min={1} max={40} value={rate}
                onChange={(e) => setRate(Number(e.target.value))}
                className="flex-1 accent-[#3B82F6]"
                aria-label="Decisions per second"
              />
              <span className="w-16 shrink-0 text-right text-xs2 num text-soft">{rate}/sec</span>
            </label>

            <div className="flex flex-wrap items-center gap-2.5">
              {metrics?.simulator_running ? (
                <button
                  type="button"
                  className="btn-ghost"
                  onClick={() => guard(() => api.stopSim(), 'Traffic generator stopped')}
                >
                  Stop
                </button>
              ) : (
                <button
                  type="button"
                  className="btn-primary"
                  disabled={live.length === 0}
                  onClick={() =>
                    guard(() => api.startSim(rate), `Generating ${rate} decisions a second`)
                  }
                >
                  Start
                </button>
              )}
              {metrics?.simulator_running ? (
                <span className="pill bg-infoDim text-info">
                  <span className="h-1.5 w-1.5 animate-breathe rounded-full bg-info" />
                  running at {metrics.simulator_rate}/sec
                </span>
              ) : null}
              {live.length === 0 ? (
                <span className="text-label uppercase text-faint">
                  every agent is held — reinstate to generate traffic
                </span>
              ) : null}
            </div>
          </div>
        </Section>

        {/* Control log ---------------------------------------------------- */}
        <Section
          title="Control log"
          action={<span className="text-xs2 num text-faint">last {log.length}</span>}
        >
          {log.length === 0 ? (
            <Empty
              icon={ScrollText}
              title="No operator actions yet"
              hint="Revocations, budget resets and policy deploys are recorded here with the operator who made them."
            />
          ) : (
            <ul className="max-h-80 divide-y divide-line/60 overflow-y-auto">
              {log.map((r) => (
                <li key={r.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-5 py-2.5">
                  <span className="w-36 shrink-0 text-label num text-faint">{stamp(r.ts)}</span>
                  <span
                    className={`w-32 shrink-0 text-label font-semibold uppercase ${
                      ACTION_TONE[r.action] ?? 'text-soft'
                    }`}
                  >
                    {r.action.replace(/_/g, ' ')}
                  </span>
                  <span className="w-36 shrink-0 truncate font-mono text-label text-soft">
                    {r.target}
                  </span>
                  <span className="min-w-0 flex-1 text-label text-faint">{r.detail}</span>
                  <span className="shrink-0 font-mono text-label text-faint">{r.actor}</span>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
    </div>
  );
}
