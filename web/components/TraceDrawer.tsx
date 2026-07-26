'use client';

import { useEffect } from 'react';
import { X } from 'lucide-react';
import { DecisionPill, TypeTag } from '@/components/Bits';
import { money, ruleLabel, stamp } from '@/lib/format';
import type { LedgerRow } from '@/lib/types';

/**
 * The whole decision for one trace id: what was asked, what came back, which
 * rule decided and how long it took.
 *
 * This is where an auditor lands when they ask "why was this permitted", so
 * nothing is summarised away and the raw payloads are shown verbatim.
 */
export function TraceDrawer({ row, onClose }: { row: LedgerRow | null; onClose: () => void }) {
  useEffect(() => {
    if (!row) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [row, onClose]);

  if (!row) return null;
  const ok = row.decision === 'APPROVED';

  return (
    <div className="fixed inset-0 z-40 flex justify-end" role="dialog" aria-modal="true"
         aria-label={`Decision ${row.trace_id}`}>
      <button type="button" aria-label="Close" onClick={onClose}
              className="flex-1 bg-app/75 backdrop-blur-[2px]" />

      <div className="flex w-[min(36rem,100vw)] animate-slideIn flex-col overflow-y-auto border-l border-line bg-surface shadow-pop">
        <header className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-line bg-surface px-5 py-4">
          <div>
            <p className="label">Decision</p>
            <div className="mt-2 flex items-center gap-2.5">
              <DecisionPill decision={row.decision} />
              <span className="text-xs2 text-faint">{ruleLabel(row.rule)}</span>
            </div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close"
                  className="rounded-ctl p-1.5 text-faint hover:bg-inset hover:text-soft">
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="flex flex-col gap-5 p-5">
          <p className={`rounded-ctl px-3.5 py-3 text-xs2 leading-relaxed
                        ${ok ? 'bg-okDim text-ok' : 'bg-badDim text-bad'}`}>
            {row.reason}
          </p>

          <dl className="grid grid-cols-2 gap-x-4 gap-y-4">
            <Field k="Trace ID" mono>{row.trace_id}</Field>
            <Field k="Recorded at">{stamp(row.ts)}</Field>
            <Field k="Agent" mono>{row.agent_id}</Field>
            <div>
              <dt className="label">Agent type</dt>
              <dd className="mt-1.5"><TypeTag type={row.agent_type} /></dd>
            </div>
            <Field k="Action">{row.action.replace(/_/g, ' ')}</Field>
            <Field k="Category">{row.category.replace(/_/g, ' ')}</Field>
            <Field k="Amount">{money(row.amount)}</Field>
            <Field k="Latency">{row.latency_ms} ms</Field>
            <Field k="Decided by">
              {row.engine === 'registry'
                ? 'registry (pre-policy)'
                : row.engine === 'opa'
                  ? 'OPA sidecar'
                  : 'embedded engine'}
            </Field>
            <Field k="Rule">{row.rule}</Field>
          </dl>

          {row.engine === 'registry' ? (
            <p className="rounded-ctl bg-inset px-3.5 py-2.5 text-label leading-relaxed text-faint">
              Registry checks run before either policy engine is consulted, so no
              policy evaluation happened for this request.
            </p>
          ) : null}

          <Payload title="Request" value={row.request} />
          <Payload title="Response" value={row.response} />
        </div>
      </div>
    </div>
  );
}

function Field({ k, children, mono }: { k: string; children: React.ReactNode; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="label">{k}</dt>
      <dd className={`mt-1 break-all text-xs2 num text-text ${mono ? 'font-mono' : ''}`}>{children}</dd>
    </div>
  );
}

function Payload({ title, value }: { title: string; value: Record<string, unknown> }) {
  return (
    <div>
      <p className="label pb-2">{title}</p>
      <pre className="overflow-x-auto rounded-ctl border border-line bg-inset p-3.5 font-mono text-label leading-relaxed text-soft">
{JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}
