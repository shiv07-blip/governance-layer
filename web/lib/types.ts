export type AgentStatus = 'active' | 'revoked';
export type Decision = 'APPROVED' | 'DENIED';

export interface Agent {
  id: string;
  name: string;
  type: string;
  status: AgentStatus;
  daily_spend: number;
  daily_cap: number;
  single_cap: number | null;
  allowed_categories: string[];
  allowed_actions: string[];
  dual_control_above: number | null;
  last_action_at: number | null;
  created_at: number;
  revoked_at: number | null;
  revoked_by: string | null;
  in_policy: boolean;
  decisions: number;
  denial_rate: number;
  avg_ms: number;
}

export interface LedgerRow {
  trace_id: string;
  ts: number;
  ts_iso: string;
  agent_id: string;
  agent_type: string;
  action: string;
  amount: number;
  category: string;
  decision: Decision;
  reason: string;
  rule: string;
  engine: string;
  latency_ms: number;
  request: Record<string, unknown>;
  response: Record<string, unknown>;
}

export interface ControlRow {
  id: string;
  ts: number;
  actor: string;
  action: string;
  target: string;
  detail: string;
}

/** Shown in the UI. Derived from live figures, never stored on the agent. */
export type DisplayStatus = 'active' | 'warning' | 'error' | 'revoked';

export interface Runtime {
  postgres: boolean;
  redis: boolean;
  opa: boolean;
  policy_engine: 'opa' | 'embedded';
  ledger: 'postgres' | 'memory';
  counters: 'redis' | 'memory';
  opa_note: string;
}

export interface Metrics {
  requests_approved: number;
  requests_denied: number;
  avg_latency_ms: number;
  p95_latency_ms: number;
  p99_latency_ms: number;
  agents_active: number;
  agents_revoked: number;
  agents_total: number;
  fleet_daily_spend: number;
  fleet_daily_cap: number;
  denial_breakdown: { rule: string; count: number }[];
  latency_series: {
    t: number;
    p50: number;
    p95: number;
    p99: number;
    avg_ms: number;
    approved: number;
    denied: number;
    total: number;
  }[];
  runtime: Runtime;
  simulator_running: boolean;
  simulator_rate: number;
  stream_listeners: number;
}

export interface PolicyDoc {
  version: number;
  yaml_content: string;
  deployed_at: number;
  deployed_by: string;
  agent_count: number;
  engine: string;
}

export interface ValidationResult {
  valid: boolean;
  error?: string;
  agent_count?: number;
  changes?: string[];
}
