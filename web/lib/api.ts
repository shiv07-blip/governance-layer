import type {
  Agent, ControlRow, LedgerRow, Metrics, PolicyDoc, ValidationResult,
} from './types';

export const API =
  process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000';

/** The operator identity. Would come from SSO; every control action is signed with it. */
export const ACTOR = 'operator_local';

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
      cache: 'no-store',
    });
  } catch {
    throw new ApiError(
      `Cannot reach the control plane at ${API}. Start it with: uvicorn app.main:app`,
      0,
    );
  }
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  // 403 on /authorize is a real denial, not a transport failure, so callers that
  // expect it opt out of throwing by reading the body themselves.
  if (!res.ok && res.status !== 403) {
    throw new ApiError(body?.detail ?? `${path} failed with ${res.status}`, res.status);
  }
  return body as T;
}

const post = (path: string, body?: unknown) =>
  call<any>(path, { method: 'POST', body: JSON.stringify(body ?? {}) });

export const api = {
  agents: () => call<Agent[]>('/agents'),
  metrics: () => call<Metrics>('/metrics'),
  controlLog: (limit = 20) => call<ControlRow[]>(`/control-log?limit=${limit}`),

  revoke: (id: string, note = '') => post(`/agents/${id}/revoke`, { actor: ACTOR, note }),
  reinstate: (id: string) => post(`/agents/${id}/reinstate`, { actor: ACTOR }),
  resetBudget: (id: string) => post(`/agents/${id}/reset-budget`, { actor: ACTOR }),

  policy: () => call<PolicyDoc>('/policies'),
  validatePolicy: (yaml: string) =>
    post('/policies/validate', { policies_yaml: yaml, actor: ACTOR }) as Promise<ValidationResult>,
  deployPolicy: (yaml: string) =>
    post('/policies/update', { policies_yaml: yaml, actor: ACTOR }),

  logs: (params: Record<string, string | number | undefined>) => {
    const q = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== '') q.set(k, String(v));
    });
    return call<{ logs: LedgerRow[]; total_count: number }>(`/logs?${q}`);
  },
  trace: (id: string) => call<LedgerRow>(`/logs/${id}`),

  haltFleet: (reason: string) =>
    post('/emergency/halt-fleet', { actor: ACTOR, reason }),
  reinstateFleet: () => post('/emergency/reinstate-fleet', { actor: ACTOR }),
  resetAllBudgets: () => post('/emergency/reset-budgets', { actor: ACTOR }),

  startSim: (rate: number) => post('/simulate/start', { rate }),
  stopSim: () => post('/simulate/stop'),

  authorize: (body: {
    agent_id: string; action: string; amount: number; category: string;
  }) => post('/authorize', body),
};
