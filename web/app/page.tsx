'use client';

import { useState } from 'react';
import { Menu, RadioTower, RefreshCw } from 'lucide-react';
import { Skeleton } from '@/components/Bits';
import { Sidebar, type SectionId } from '@/components/Sidebar';
import { TraceDrawer } from '@/components/TraceDrawer';
import { AgentStatus } from '@/components/sections/AgentStatus';
import { AuditLogs } from '@/components/sections/AuditLogs';
import { Emergency } from '@/components/sections/Emergency';
import { PolicyEditor } from '@/components/sections/PolicyEditor';
import { API } from '@/lib/api';
import { useFleet } from '@/lib/useFleet';
import type { LedgerRow } from '@/lib/types';

const HEAD: Record<SectionId, { title: string; blurb: string }> = {
  agents: {
    title: 'Agent Status',
    blurb: 'What every agent is permitted to do, and how much of its budget is gone',
  },
  policy: {
    title: 'Policy Editor',
    blurb: 'The authority each agent holds — checked before it takes effect',
  },
  logs: {
    title: 'Audit Logs',
    blurb: 'Every authorization decision, refusals included',
  },
  emergency: {
    title: 'Emergency Controls',
    blurb: 'Hold one agent or halt the fleet — both are logged against your operator id',
  },
};

export default function Page() {
  const [section, setSection] = useState<SectionId>('agents');
  const [trace, setTrace] = useState<LedgerRow | null>(null);
  const [navOpen, setNavOpen] = useState(false);
  const { agents, metrics, tape, connected, error, ready, refresh } = useFleet();

  const head = HEAD[section];
  const clock = new Date().toLocaleTimeString('en-GB', { hour12: false });

  return (
    <div className="flex min-h-screen flex-col lg:flex-row">
      <div className={`${navOpen ? 'block' : 'hidden'} lg:block`}>
        <Sidebar
          active={section}
          onSelect={(id) => {
            setSection(id);
            setNavOpen(false);
          }}
          metrics={metrics}
          connected={connected}
        />
      </div>

      <main className="min-w-0 flex-1 lg:h-screen lg:overflow-y-auto">
        <header className="sticky top-0 z-20 flex flex-wrap items-center justify-between gap-4 border-b border-line bg-app/85 px-5 py-4 backdrop-blur lg:px-6">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setNavOpen((v) => !v)}
              aria-label="Toggle navigation"
              className="rounded-ctl border border-line p-2 text-soft lg:hidden"
            >
              <Menu className="h-4 w-4" />
            </button>
            <div>
              <h1 className="text-xl font-semibold tracking-tight text-text">{head.title}</h1>
              <p className="mt-0.5 text-xs2 text-faint">{head.blurb}</p>
            </div>
          </div>

          <div className="flex items-center gap-2.5">
            <span className="pill border border-line bg-surface text-faint">
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  connected ? 'animate-breathe bg-ok' : 'bg-warn'
                }`}
              />
              {connected ? 'Live' : 'Polling'} · {clock}
            </span>
            <button type="button" onClick={refresh} className="btn-ghost" aria-label="Refresh now">
              <RefreshCw className="h-3.5 w-3.5" />
              Refresh
            </button>
          </div>
        </header>

        <div className="p-5 lg:p-6">
          {/* A dead control plane is the one case where showing stale numbers
              would be actively misleading, so it replaces the console rather
              than sitting above it. */}
          {error ? (
            <div className="card border-bad/45 p-5">
              <p className="flex items-center gap-2 text-sm font-semibold text-bad">
                <RadioTower className="h-4 w-4" />
                Control plane unreachable
              </p>
              <p className="mt-2.5 max-w-2xl text-xs2 leading-relaxed text-soft">{error}</p>
              <p className="mt-3.5 text-label leading-relaxed text-faint">
                Expecting the API at <span className="font-mono text-soft">{API}</span> — start it
                with{' '}
                <span className="font-mono text-info">uvicorn app.main:app --reload</span> from the
                backend directory. This console reconnects on its own.
              </p>
            </div>
          ) : !ready ? (
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-36" />
              ))}
            </div>
          ) : (
            <>
              {section === 'agents' && (
                <AgentStatus
                  agents={agents}
                  metrics={metrics}
                  tape={tape}
                  refresh={refresh}
                  onOpenTrace={setTrace}
                />
              )}
              {section === 'policy' && <PolicyEditor onDeployed={refresh} />}
              {section === 'logs' && <AuditLogs onOpenTrace={setTrace} />}
              {section === 'emergency' && (
                <Emergency agents={agents} metrics={metrics} refresh={refresh} />
              )}
            </>
          )}
        </div>
      </main>

      <TraceDrawer row={trace} onClose={() => setTrace(null)} />
    </div>
  );
}
