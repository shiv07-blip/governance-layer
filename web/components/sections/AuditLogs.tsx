'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Download, FileSearch, Filter, Search } from 'lucide-react';
import { DecisionPill, Empty, Section, SortHeader, TypeTag } from '@/components/Bits';
import { useToast } from '@/components/Toast';
import { api } from '@/lib/api';
import { clock, csv, download, money, ruleLabel, stamp, titleCase } from '@/lib/format';
import type { LedgerRow } from '@/lib/types';

const TYPES = ['fee_reversal', 'dispute_resolver', 'claim_processor'];
type SortKey = 'ts' | 'agent_id' | 'amount' | 'decision' | 'latency_ms';

function toEpoch(local: string): number | undefined {
  if (!local) return undefined;
  const ms = new Date(local).getTime();
  return Number.isNaN(ms) ? undefined : ms / 1000;
}

export function AuditLogs({ onOpenTrace }: { onOpenTrace: (row: LedgerRow) => void }) {
  const toast = useToast();
  const [rows, setRows] = useState<LedgerRow[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [loading, setLoading] = useState(true);

  const [search, setSearch] = useState('');
  const [agentType, setAgentType] = useState('');
  const [decision, setDecision] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const [sort, setSort] = useState<SortKey>('ts');
  const [dir, setDir] = useState<'asc' | 'desc'>('desc');
  const [perPage, setPerPage] = useState(25);
  const [page, setPage] = useState(0);

  const query = useMemo(
    () => ({
      search: search || undefined,
      agent_type: agentType || undefined,
      decision: decision || undefined,
      date_from: toEpoch(from),
      date_to: toEpoch(to),
    }),
    [search, agentType, decision, from, to],
  );

  // Sorting is client-side over the fetched window, so the page size is also the
  // sort window. Pulling a generous slice keeps that from being surprising.
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.logs({ ...query, limit: 1000 });
      setRows(res.logs);
      setTotalCount(res.total_count);
    } catch (e) {
      toast('fail', e instanceof Error ? e.message : 'Could not load the ledger');
    } finally {
      setLoading(false);
    }
  }, [query, toast]);

  useEffect(() => {
    const t = setTimeout(load, 220); // debounce typing
    return () => clearTimeout(t);
  }, [load]);

  useEffect(() => {
    setPage(0);
  }, [query, perPage, sort, dir]);

  const sorted = useMemo(() => {
    const factor = dir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const x = a[sort];
      const y = b[sort];
      if (typeof x === 'number' && typeof y === 'number') return (x - y) * factor;
      return String(x).localeCompare(String(y)) * factor;
    });
  }, [rows, sort, dir]);

  const pageRows = sorted.slice(page * perPage, page * perPage + perPage);
  const pages = Math.max(1, Math.ceil(sorted.length / perPage));
  const filtered = Boolean(search || agentType || decision || from || to);

  const onSort = (c: SortKey) => {
    if (c === sort) setDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setSort(c);
      setDir(c === 'agent_id' ? 'asc' : 'desc');
    }
  };

  const exportCsv = () => {
    const flat = sorted.map((r) => ({
      timestamp: r.ts_iso,
      trace_id: r.trace_id,
      agent_id: r.agent_id,
      agent_type: r.agent_type,
      action: r.action,
      category: r.category,
      amount_usd: (r.amount / 100).toFixed(2),
      decision: r.decision,
      rule: r.rule,
      reason: r.reason,
      engine: r.engine,
      latency_ms: r.latency_ms,
    }));
    if (flat.length === 0) {
      toast('warn', 'Nothing to export with these filters');
      return;
    }
    download(
      `decisions-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.csv`,
      csv(flat, Object.keys(flat[0])),
    );
    toast('ok', `Exported ${flat.length} decisions`);
  };

  return (
    <div className="flex flex-col gap-4">
      {/* Filters ---------------------------------------------------------- */}
      <div className="card p-5">
        <div className="mb-3.5 flex items-center gap-2">
          <Filter className="h-3.5 w-3.5 text-faint" />
          <p className="label">Filters</p>
        </div>

        <div className="grid gap-3 lg:grid-cols-[minmax(0,2fr)_1fr_1fr_1fr_1fr]">
          <label className="relative block">
            <span className="sr-only">Search</span>
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-faint" />
            <input
              className="field pl-9"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Agent ID, trace ID, reason, category…"
            />
          </label>

          <label className="block">
            <span className="sr-only">Agent type</span>
            <select className="field" value={agentType} onChange={(e) => setAgentType(e.target.value)}>
              <option value="">All types</option>
              {TYPES.map((t) => (
                <option key={t} value={t}>{titleCase(t)}</option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="sr-only">Decision</span>
            <select className="field" value={decision} onChange={(e) => setDecision(e.target.value)}>
              <option value="">All decisions</option>
              <option value="APPROVED">Approved</option>
              <option value="DENIED">Denied</option>
            </select>
          </label>

          <label className="block">
            <span className="sr-only">From</span>
            <input type="datetime-local" className="field" value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>

          <label className="block">
            <span className="sr-only">To</span>
            <input type="datetime-local" className="field" value={to} onChange={(e) => setTo(e.target.value)} />
          </label>
        </div>

        <div className="mt-3.5 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-3.5">
          <p className="text-xs2 num text-faint">
            {loading ? 'Reading…' : `${totalCount.toLocaleString()} decisions match`}
            {filtered ? ' · filtered' : ''}
          </p>
          <div className="flex items-center gap-2">
            {filtered ? (
              <button
                type="button"
                className="btn-ghost"
                onClick={() => {
                  setSearch(''); setAgentType(''); setDecision(''); setFrom(''); setTo('');
                }}
              >
                Clear filters
              </button>
            ) : null}
            <button type="button" className="btn-primary" onClick={exportCsv}>
              <Download className="h-3.5 w-3.5" />
              Export CSV
            </button>
          </div>
        </div>
      </div>

      {/* Table ------------------------------------------------------------ */}
      <Section
        title={`${sorted.length.toLocaleString()} records`}
        action={
          <label className="flex items-center gap-2 text-xs2 text-faint">
            Rows per page
            <select
              className="field w-auto py-1"
              value={perPage}
              onChange={(e) => setPerPage(Number(e.target.value))}
            >
              {[10, 25, 50, 100].map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
          </label>
        }
      >
        <div className="overflow-x-auto">
          <table className="w-full min-w-[62rem] border-collapse">
            <thead>
              <tr className="border-b border-line">
                <SortHeader column="ts" label="Timestamp" active={sort} direction={dir} onSort={onSort} />
                <SortHeader column="agent_id" label="Agent ID" active={sort} direction={dir} onSort={onSort} />
                <th className="th">Type</th>
                <th className="th">Action</th>
                <SortHeader column="amount" label="Amount" active={sort} direction={dir} onSort={onSort} align="right" />
                <th className="th">Category</th>
                <SortHeader column="decision" label="Decision" active={sort} direction={dir} onSort={onSort} />
                <th className="th">Reason</th>
                <SortHeader column="latency_ms" label="ms" active={sort} direction={dir} onSort={onSort} align="right" />
                <th className="th">Trace ID</th>
              </tr>
            </thead>
            <tbody>
              {pageRows.map((r) => (
                <tr
                  key={r.trace_id}
                  onClick={() => onOpenTrace(r)}
                  className="cursor-pointer border-b border-line/50 transition-colors hover:bg-surfaceHi"
                >
                  <td className="td whitespace-nowrap num" title={stamp(r.ts)}>{clock(r.ts)}</td>
                  <td className="td max-w-[13rem] truncate font-mono">{r.agent_id}</td>
                  <td className="td"><TypeTag type={r.agent_type} /></td>
                  <td className="td whitespace-nowrap uppercase">{r.action.replace(/_/g, ' ')}</td>
                  <td className="td whitespace-nowrap text-right num font-medium text-text">
                    {money(r.amount)}
                  </td>
                  <td className="td uppercase text-faint">{r.category.replace(/_/g, ' ')}</td>
                  <td className="td"><DecisionPill decision={r.decision} /></td>
                  <td className="td max-w-[14rem] truncate" title={r.reason}>{ruleLabel(r.rule)}</td>
                  <td className="td text-right num text-faint">{r.latency_ms}</td>
                  <td className="td max-w-[10rem] truncate font-mono text-ok/80">{r.trace_id}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {pageRows.length === 0 && !loading ? (
          <Empty
            icon={FileSearch}
            title={filtered ? 'Nothing matches those filters' : 'The ledger is empty'}
            hint={
              filtered
                ? 'Widen the date range or clear the filters to see the full record.'
                : 'Every authorization decision lands here, approvals and refusals alike.'
            }
          />
        ) : null}

        {pages > 1 ? (
          <div className="flex items-center justify-between border-t border-line px-5 py-3">
            <button type="button" className="btn-ghost" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
              Previous
            </button>
            <span className="text-xs2 num text-faint">Page {page + 1} of {pages}</span>
            <button
              type="button"
              className="btn-ghost"
              disabled={page + 1 >= pages}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </button>
          </div>
        ) : null}
      </Section>

      <p className="px-1 text-xs2 leading-relaxed text-faint">
        The ledger is append-only — a Postgres trigger refuses updates and deletes,
        and corrections go in as new rows. Refusals are recorded beside approvals,
        so an unfiltered query is the complete record of what the layer decided.
      </p>
    </div>
  );
}
