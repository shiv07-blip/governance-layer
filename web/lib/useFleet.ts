'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { API, api } from './api';
import type { Agent, LedgerRow, Metrics } from './types';

const TAPE_DEPTH = 60;

/**
 * One source of fleet truth for the whole panel.
 *
 * Decisions arrive over SSE so the tape reacts immediately. Aggregates still
 * come from a slower poll, because recomputing percentiles on the client from a
 * partial stream would drift from what the ledger actually holds — and on this
 * panel a number that disagrees with the audit log is worse than a number that
 * is two seconds old.
 */
export function useFleet(pollMs = 2500) {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [tape, setTape] = useState<LedgerRow[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const [a, m] = await Promise.all([api.agents(), api.metrics()]);
      if (!mounted.current) return;
      setAgents(a);
      setMetrics(m);
      setError(null);
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : 'Request failed');
    } finally {
      if (mounted.current) setReady(true);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    refresh();
    const id = setInterval(refresh, pollMs);
    return () => {
      mounted.current = false;
      clearInterval(id);
    };
  }, [refresh, pollMs]);

  // Seed the tape once so it is not empty before the first live decision lands.
  useEffect(() => {
    api
      .logs({ limit: TAPE_DEPTH })
      .then((r) => mounted.current && setTape(r.logs))
      .catch(() => {});
  }, []);

  useEffect(() => {
    let source: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;

    const open = () => {
      source = new EventSource(`${API}/stream`);
      source.onopen = () => setConnected(true);
      source.onmessage = (ev) => {
        try {
          const frame = JSON.parse(ev.data) as { kind: string; payload: unknown };
          if (frame.kind === 'decision') {
            setTape((prev) => [frame.payload as LedgerRow, ...prev].slice(0, TAPE_DEPTH));
          } else if (frame.kind === 'control') {
            refresh();
          }
        } catch {
          /* keep-alive frames and partial writes are not fatal */
        }
      };
      source.onerror = () => {
        setConnected(false);
        source?.close();
        retry = setTimeout(open, 3000);
      };
    };

    open();
    return () => {
      source?.close();
      if (retry) clearTimeout(retry);
    };
  }, [refresh]);

  return { agents, metrics, tape, connected, error, ready, refresh };
}
