/** Everything on the wire is in cents. Nothing in the UI does its own arithmetic. */

export function money(cents: number, opts: { compact?: boolean } = {}): string {
  const dollars = cents / 100;
  if (opts.compact) {
    if (Math.abs(dollars) >= 1_000_000) return `$${(dollars / 1_000_000).toFixed(2)}M`;
    if (Math.abs(dollars) >= 1_000) return `$${(dollars / 1_000).toFixed(1)}K`;
    return `$${dollars.toFixed(0)}`;
  }
  return dollars.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2,
  });
}

export function pct(n: number, digits = 0): string {
  return `${(n * 100).toFixed(digits)}%`;
}

export function clock(ts: number | null | undefined): string {
  if (!ts) return '—';
  return new Date(ts * 1000).toLocaleTimeString('en-GB', { hour12: false });
}

export function stamp(ts: number | null | undefined): string {
  if (!ts) return '—';
  const d = new Date(ts * 1000);
  return `${d.toLocaleDateString('en-CA')} ${d.toLocaleTimeString('en-GB', { hour12: false })}`;
}

export function ago(ts: number | null | undefined): string {
  if (!ts) return 'never';
  const s = Math.max(0, Date.now() / 1000 - ts);
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** Rule identifiers are machine names. Operators read plain English. */
const RULE_LABELS: Record<string, string> = {
  permit: 'Permitted',
  revoked: 'Agent revoked',
  unregistered_agent: 'Not in policy',
  amount_positive: 'Invalid amount',
  known_action: 'Unknown action',
  action_scope: 'Action out of scope',
  category_scope: 'Category out of scope',
  single_transaction_cap: 'Over per-transaction limit',
  dual_control: 'Needs a human approver',
  agent_daily_cap: 'Agent daily cap',
  type_daily_cap: 'Agent-type daily cap',
  fleet_daily_cap: 'Fleet daily cap',
  default_deny: 'Denied by default',
};

export function ruleLabel(rule: string): string {
  return RULE_LABELS[rule] ?? rule.replace(/_/g, ' ');
}

export function typeLabel(t: string): string {
  return t.replace(/_/g, ' ');
}

/** Utilisation bands drive colour everywhere, so the thresholds live in one place. */
export type Band = 'calm' | 'warm' | 'hot';

export function band(used: number, cap: number): Band {
  if (cap <= 0) return 'calm';
  const r = used / cap;
  if (r >= 0.8) return 'hot';
  if (r >= 0.5) return 'warm';
  return 'calm';
}

export const BAND_FG: Record<Band, string> = {
  calm: 'text-live',
  warm: 'text-sodium',
  hot: 'text-trip',
};

export const BAND_BG: Record<Band, string> = {
  calm: 'bg-live',
  warm: 'bg-sodium',
  hot: 'bg-trip',
};

export function csv(rows: Record<string, unknown>[], columns: string[]): string {
  const escape = (v: unknown) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [
    columns.join(','),
    ...rows.map((r) => columns.map((c) => escape(r[c])).join(',')),
  ].join('\n');
}

export function download(filename: string, content: string, mime = 'text/csv') {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// Derived display state.
//
// The backend stores only active or revoked, because those are the two states
// that change what the layer *does*. Warning and error are read-outs, computed
// here from live figures so the console can draw attention without inventing a
// stored field that nothing enforces.
// ---------------------------------------------------------------------------

import type { Agent, DisplayStatus } from './types';

export const HIGH_UTILISATION = 0.8;
export const HIGH_REFUSAL_RATE = 0.5;
export const MIN_DECISIONS_FOR_REFUSAL_SIGNAL = 20;

export function displayStatus(a: Agent): DisplayStatus {
  if (a.status === 'revoked') return 'revoked';
  // A healthy agent is occasionally refused. One refused more often than not,
  // over a meaningful sample, is misconfigured or misbehaving.
  if (
    a.decisions >= MIN_DECISIONS_FOR_REFUSAL_SIGNAL &&
    a.denial_rate >= HIGH_REFUSAL_RATE
  ) {
    return 'error';
  }
  if (a.daily_cap > 0 && a.daily_spend / a.daily_cap >= HIGH_UTILISATION) return 'warning';
  return 'active';
}

export const STATUS_STYLE: Record<DisplayStatus, { dot: string; text: string; label: string }> = {
  active:  { dot: 'bg-ok',   text: 'text-ok',   label: 'Active' },
  warning: { dot: 'bg-warn', text: 'text-warn', label: 'Warning' },
  error:   { dot: 'bg-bad',  text: 'text-bad',  label: 'Error' },
  revoked: { dot: 'bg-faint', text: 'text-faint', label: 'Revoked' },
};

export function statusExplanation(a: Agent): string {
  switch (displayStatus(a)) {
    case 'revoked':
      return `Revoked${a.revoked_by ? ` by ${a.revoked_by}` : ''}. Every request is refused.`;
    case 'error':
      return `${pct(a.denial_rate, 0)} of this agent's requests are being refused over ${a.decisions} decisions. Check its grant.`;
    case 'warning':
      return `${pct(a.daily_spend / a.daily_cap, 0)} of the daily cap is spent.`;
    default:
      return 'Operating inside its grant.';
  }
}

export const TYPE_STYLE: Record<string, { text: string; bg: string; stroke: string }> = {
  fee_reversal:     { text: 'text-fee',     bg: 'bg-fee/12',     stroke: '#60A5FA' },
  dispute_resolver: { text: 'text-dispute', bg: 'bg-dispute/12', stroke: '#FBBF24' },
  claim_processor:  { text: 'text-claim',   bg: 'bg-claim/12',   stroke: '#34D399' },
};

export function typeStyle(t: string) {
  return TYPE_STYLE[t] ?? { text: 'text-soft', bg: 'bg-line/40', stroke: '#94A0B0' };
}

/** Title-case a machine name for headings: fee_reversal -> Fee Reversal */
export function titleCase(s: string): string {
  return s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
