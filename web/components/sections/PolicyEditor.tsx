'use client';

import { useEffect, useState } from 'react';
import { CheckCircle2, RotateCcw, ScanLine, Upload, XCircle } from 'lucide-react';
import { Section } from '@/components/Bits';
import { useToast } from '@/components/Toast';
import { api } from '@/lib/api';
import { ago, stamp } from '@/lib/format';
import type { PolicyDoc, ValidationResult } from '@/lib/types';

const FIELD_DOCS: [string, string][] = [
  ['type', 'fee_reversal, dispute_resolver or claim_processor. Sets which family of work the agent belongs to.'],
  ['max_single_transaction', 'Ceiling on one action, in cents. Checked before any budget is touched.'],
  ['max_daily_spend', 'Rolling daily ceiling, in cents. Enforced atomically, so concurrent requests cannot overshoot it together.'],
  ['allowed_actions', 'Optional. Omit to allow every action for the type; list them to narrow it.'],
  ['allowed_categories', 'Required. Use `all` only where the agent genuinely needs the whole surface.'],
  ['requires_dual_control_above', 'Optional. Above this amount the request is refused and routed to a human.'],
  ['type_daily_caps', 'A ceiling per agent family, above the individual agents. Stops a whole class running away.'],
];

export function PolicyEditor({ onDeployed }: { onDeployed: () => void }) {
  const toast = useToast();
  const [doc, setDoc] = useState<PolicyDoc | null>(null);
  const [draft, setDraft] = useState('');
  const [check, setCheck] = useState<ValidationResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [deploying, setDeploying] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = () => {
    api
      .policy()
      .then((p) => {
        setDoc(p);
        setDraft(p.yaml_content);
        setCheck(null);
        setLoadError(null);
      })
      .catch((e) => setLoadError(e instanceof Error ? e.message : 'Could not load the policy'));
  };

  useEffect(load, []);

  const dirty = doc !== null && draft !== doc.yaml_content;

  // Any edit invalidates the previous check, so deploy re-locks.
  useEffect(() => {
    setCheck(null);
  }, [draft]);

  const runCheck = async () => {
    setChecking(true);
    try {
      const result = await api.validatePolicy(draft);
      setCheck(result);
      toast(result.valid ? 'ok' : 'warn', result.valid ? 'Policy is valid' : 'Policy has a problem');
    } catch (e) {
      toast('fail', e instanceof Error ? e.message : 'Check failed');
    } finally {
      setChecking(false);
    }
  };

  const deploy = async () => {
    setDeploying(true);
    try {
      const res = await api.deployPolicy(draft);
      toast('ok', `Policy v${res.version} live across ${res.agent_count} agents`);
      load();
      onDeployed();
    } catch (e) {
      // Say what is still enforcing, or the operator assumes the fleet is now
      // ungoverned.
      toast(
        'fail',
        `${e instanceof Error ? e.message : 'Deploy failed'} — v${doc?.version} is still enforcing`,
      );
    } finally {
      setDeploying(false);
    }
  };

  if (loadError) {
    return (
      <div className="card border-bad/40 p-5">
        <p className="flex items-center gap-2 text-sm font-semibold text-bad">
          <XCircle className="h-4 w-4" /> Policy unavailable
        </p>
        <p className="mt-2 text-xs2 leading-relaxed text-soft">{loadError}</p>
      </div>
    );
  }

  const lines = draft.split('\n').length;

  return (
    <div className="grid gap-4 xl:grid-cols-[1.6fr_1fr]">
      <Section
        title="Agent authority"
        action={
          <div className="flex flex-wrap items-center gap-2">
            {dirty ? (
              <span className="pill bg-warnDim text-warn">Unsaved edits</span>
            ) : (
              <span className="pill bg-okDim text-ok">In sync</span>
            )}
            <button type="button" className="btn-ghost" onClick={load} disabled={deploying || !dirty}>
              <RotateCcw className="h-3.5 w-3.5" />
              Revert
            </button>
            <button type="button" className="btn-ghost" onClick={runCheck} disabled={checking || deploying}>
              <ScanLine className="h-3.5 w-3.5" />
              {checking ? 'Checking…' : 'Check'}
            </button>
            <button
              type="button"
              className="btn-primary"
              onClick={deploy}
              disabled={deploying || !dirty || !check?.valid}
              title={
                !dirty
                  ? 'No changes to deploy'
                  : !check
                    ? 'Run the check first'
                    : !check.valid
                      ? 'Fix the reported problem first'
                      : 'Deploy across the fleet'
              }
            >
              <Upload className="h-3.5 w-3.5" />
              {deploying ? 'Deploying…' : 'Deploy'}
            </button>
          </div>
        }
      >
        <div className="border-b border-line bg-inset px-5 py-2">
          <p className="text-label num uppercase text-faint">
            {doc ? `v${doc.version} · ${doc.agent_count} agents · enforced by ${doc.engine}` : 'loading'}
            {' · '}
            {lines} lines
          </p>
        </div>

        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          spellCheck={false}
          aria-label="Policy YAML"
          className="min-h-[32rem] w-full resize-y bg-inset px-5 py-4 font-mono text-xs2 leading-relaxed
                     text-text outline-none placeholder:text-faint"
          placeholder="agents:"
        />

        <footer className="border-t border-line px-5 py-3">
          <p className="text-label uppercase text-faint">
            {doc ? `Last deploy ${ago(doc.deployed_at)} by ${doc.deployed_by} · ${stamp(doc.deployed_at)}` : '—'}
          </p>
        </footer>
      </Section>

      <div className="flex flex-col gap-4">
        <Section title="Check report">
          <div className="p-5">
            {!check ? (
              <p className="text-xs2 leading-relaxed text-faint">
                Run a check to validate the YAML and see which grants widen or
                narrow. Deploy stays locked until it passes — a cap change is a
                change to how much money an agent can move.
              </p>
            ) : check.valid ? (
              <div className="flex flex-col gap-3.5">
                <p className="flex items-center gap-2 text-xs2 font-medium text-ok">
                  <CheckCircle2 className="h-4 w-4" />
                  Valid · {check.agent_count} agents
                </p>
                {check.changes && check.changes.length > 0 ? (
                  <ul className="flex flex-col gap-2">
                    {check.changes.map((c) => (
                      <li
                        key={c}
                        className={`rounded-ctl px-3 py-2 font-mono text-label leading-relaxed ${
                          c.startsWith('-')
                            ? 'bg-badDim text-bad'
                            : c.startsWith('+')
                              ? 'bg-okDim text-ok'
                              : 'bg-warnDim text-warn'
                        }`}
                      >
                        {c}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-xs2 text-faint">No change to any agent&apos;s authority.</p>
                )}
              </div>
            ) : (
              <div className="rounded-ctl border border-bad/40 bg-badDim p-3.5">
                <p className="flex items-center gap-2 text-xs2 font-semibold text-bad">
                  <XCircle className="h-4 w-4" />
                  Will not deploy
                </p>
                <p className="mt-2 text-xs2 leading-relaxed text-soft">{check.error}</p>
              </div>
            )}
          </div>
        </Section>

        <Section title="How a grant is written">
          <dl className="divide-y divide-line/60">
            {FIELD_DOCS.map(([k, v]) => (
              <div key={k} className="px-5 py-3">
                <dt className="font-mono text-xs2 text-info">{k}</dt>
                <dd className="mt-1 text-label leading-relaxed text-faint">{v}</dd>
              </div>
            ))}
          </dl>
          <p className="border-t border-line px-5 py-3 text-label leading-relaxed text-faint">
            Values are cents throughout. A deploy replaces the whole document, so
            an agent left out of it is refused on its next request.
          </p>
        </Section>
      </div>
    </div>
  );
}
