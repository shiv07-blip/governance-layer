"""Agent registry and the audit ledger.

The ledger is append-only. There is no update path and no delete path anywhere
in this module, which is the property an auditor actually cares about: a
decision that was made cannot later be made to look different. Corrections go in
as new rows.

Postgres is used when reachable. Otherwise everything lives in a bounded
in-memory deque so the service still runs and still tells the truth about which
backend it used.
"""

from __future__ import annotations

import asyncio
import time
import uuid
from collections import deque
from dataclasses import asdict, dataclass, field
from typing import Any, Iterable, Optional

from .config import runtime, settings

MEMORY_LEDGER_LIMIT = 20_000


@dataclass
class Agent:
    id: str
    name: str
    type: str
    status: str = "active"  # active | revoked
    daily_cap: int = 0
    last_action_at: Optional[float] = None
    created_at: float = field(default_factory=time.time)
    revoked_at: Optional[float] = None
    revoked_by: Optional[str] = None
    error_count: int = 0


@dataclass
class LedgerRow:
    trace_id: str
    ts: float
    agent_id: str
    agent_type: str
    action: str
    amount: int
    category: str
    decision: str  # APPROVED | DENIED
    reason: str
    rule: str
    engine: str
    latency_ms: float
    request: dict[str, Any] = field(default_factory=dict)
    response: dict[str, Any] = field(default_factory=dict)


@dataclass
class ControlRow:
    """Operator actions. Kept beside the decision ledger, same immutability."""

    id: str
    ts: float
    actor: str
    action: str  # revoke | reinstate | reset_budget | halt_fleet | reset_all | deploy_policy
    target: str
    detail: str


class Store:
    def __init__(self) -> None:
        self._pool: Any = None
        self._agents: dict[str, Agent] = {}
        self._ledger: deque[LedgerRow] = deque(maxlen=MEMORY_LEDGER_LIMIT)
        self._control: deque[ControlRow] = deque(maxlen=2_000)
        self._latencies: deque[float] = deque(maxlen=5_000)
        self._lock = asyncio.Lock()

    # ---------------------------------------------------------------- lifecycle

    async def connect(self) -> None:
        if not settings.database_url:
            return
        try:
            import asyncpg

            self._pool = await asyncpg.create_pool(
                settings.database_url, min_size=1, max_size=8, timeout=3
            )
            async with self._pool.acquire() as conn:
                await conn.execute("SELECT 1")
            runtime.postgres = True
        except Exception:
            self._pool = None
            runtime.postgres = False

    async def close(self) -> None:
        if self._pool is not None:
            await self._pool.close()

    # ---------------------------------------------------------------- registry

    async def put_agent(self, agent: Agent) -> None:
        async with self._lock:
            self._agents[agent.id] = agent
        if self._pool is not None:
            async with self._pool.acquire() as conn:
                await conn.execute(
                    """
                    INSERT INTO agents (id, name, type, status, daily_cap, created_at)
                    VALUES ($1, $2, $3, $4, $5, to_timestamp($6))
                    ON CONFLICT (id) DO UPDATE
                      SET name = EXCLUDED.name,
                          type = EXCLUDED.type,
                          daily_cap = EXCLUDED.daily_cap
                    """,
                    agent.id, agent.name, agent.type, agent.status,
                    agent.daily_cap, agent.created_at,
                )

    def agent(self, agent_id: str) -> Optional[Agent]:
        return self._agents.get(agent_id)

    def agents(self) -> list[Agent]:
        return sorted(self._agents.values(), key=lambda a: a.id)

    def is_revoked(self, agent_id: str) -> bool:
        agent = self._agents.get(agent_id)
        return agent is None or agent.status == "revoked"

    async def set_status(
        self, agent_id: str, status: str, actor: str
    ) -> Optional[Agent]:
        agent = self._agents.get(agent_id)
        if agent is None:
            return None
        agent.status = status
        if status == "revoked":
            agent.revoked_at = time.time()
            agent.revoked_by = actor
        else:
            agent.revoked_at = None
            agent.revoked_by = None
        if self._pool is not None:
            async with self._pool.acquire() as conn:
                await conn.execute(
                    "UPDATE agents SET status=$2, revoked_at=$3, revoked_by=$4 WHERE id=$1",
                    agent_id,
                    status,
                    None if agent.revoked_at is None else _dt(agent.revoked_at),
                    agent.revoked_by,
                )
        return agent

    async def revoke_all(self, actor: str) -> list[str]:
        changed = []
        for agent in self._agents.values():
            if agent.status != "revoked":
                await self.set_status(agent.id, "revoked", actor)
                changed.append(agent.id)
        return changed

    def touch(self, agent_id: str) -> None:
        agent = self._agents.get(agent_id)
        if agent is not None:
            agent.last_action_at = time.time()

    # ---------------------------------------------------------------- ledger

    async def append(self, row: LedgerRow) -> None:
        self._ledger.appendleft(row)
        self._latencies.append(row.latency_ms)
        if self._pool is not None:
            async with self._pool.acquire() as conn:
                await conn.execute(
                    """
                    INSERT INTO action_log (
                      trace_id, ts, agent_id, agent_type, action, amount, category,
                      decision, reason, rule, engine, latency_ms, request_json, response_json
                    ) VALUES (
                      $1, to_timestamp($2), $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14
                    )
                    """,
                    row.trace_id, row.ts, row.agent_id, row.agent_type, row.action,
                    row.amount, row.category, row.decision, row.reason, row.rule,
                    row.engine, row.latency_ms,
                    _json(row.request), _json(row.response),
                )

    def query(
        self,
        agent_id: Optional[str] = None,
        agent_type: Optional[str] = None,
        decision: Optional[str] = None,
        trace_id: Optional[str] = None,
        search: Optional[str] = None,
        date_from: Optional[float] = None,
        date_to: Optional[float] = None,
        limit: int = 200,
        offset: int = 0,
    ) -> tuple[list[LedgerRow], int]:
        rows: Iterable[LedgerRow] = self._ledger

        def keep(r: LedgerRow) -> bool:
            if agent_id and agent_id not in r.agent_id:
                return False
            if agent_type and r.agent_type != agent_type:
                return False
            if decision and r.decision != decision:
                return False
            if trace_id and trace_id != r.trace_id:
                return False
            if date_from and r.ts < date_from:
                return False
            if date_to and r.ts > date_to:
                return False
            if search:
                needle = search.lower()
                haystack = f"{r.agent_id} {r.trace_id} {r.reason} {r.category} {r.action}"
                if needle not in haystack.lower():
                    return False
            return True

        matched = [r for r in rows if keep(r)]
        return matched[offset : offset + limit], len(matched)

    def by_trace(self, trace_id: str) -> Optional[LedgerRow]:
        for row in self._ledger:
            if row.trace_id == trace_id:
                return row
        return None

    def recent(self, n: int = 40) -> list[LedgerRow]:
        return list(self._ledger)[:n]

    # ---------------------------------------------------------------- control log

    async def log_control(self, actor: str, action: str, target: str, detail: str) -> ControlRow:
        row = ControlRow(
            id=str(uuid.uuid4()), ts=time.time(), actor=actor,
            action=action, target=target, detail=detail,
        )
        self._control.appendleft(row)
        if self._pool is not None:
            async with self._pool.acquire() as conn:
                await conn.execute(
                    """
                    INSERT INTO control_log (id, ts, actor, action, target, detail)
                    VALUES ($1, to_timestamp($2), $3, $4, $5, $6)
                    """,
                    row.id, row.ts, row.actor, row.action, row.target, row.detail,
                )
        return row

    def control_log(self, n: int = 20) -> list[ControlRow]:
        return list(self._control)[:n]

    # ---------------------------------------------------------------- metrics

    def counts(self) -> tuple[int, int]:
        approved = sum(1 for r in self._ledger if r.decision == "APPROVED")
        return approved, len(self._ledger) - approved

    def latency_percentiles(self) -> tuple[float, float, float]:
        if not self._latencies:
            return 0.0, 0.0, 0.0
        ordered = sorted(self._latencies)
        n = len(ordered)
        avg = sum(ordered) / n
        p95 = ordered[min(n - 1, int(n * 0.95))]
        p99 = ordered[min(n - 1, int(n * 0.99))]
        return round(avg, 2), round(p95, 2), round(p99, 2)

    def latency_series(self, buckets: int = 32, window_s: float = 900.0) -> list[dict]:
        """Per-bucket latency percentiles and volume over the trailing window.

        Percentiles are computed per bucket rather than reusing the global ones,
        because a chart that draws the same overall p95 across every bucket looks
        like three real series and is actually one. If a bucket is thin, the
        higher percentiles collapse onto the median, which is the honest picture.
        """
        now = time.time()
        width = window_s / buckets
        samples: list[list[float]] = [[] for _ in range(buckets)]
        ok = [0] * buckets
        no = [0] * buckets

        for row in self._ledger:
            age = now - row.ts
            if age < 0 or age > window_s:
                continue
            idx = min(buckets - 1, int((window_s - age) / width))
            samples[idx].append(row.latency_ms)
            if row.decision == "APPROVED":
                ok[idx] += 1
            else:
                no[idx] += 1

        def q(sorted_vals: list[float], fraction: float) -> float:
            if not sorted_vals:
                return 0.0
            i = min(len(sorted_vals) - 1, int(len(sorted_vals) * fraction))
            return round(sorted_vals[i], 2)

        out: list[dict] = []
        for i in range(buckets):
            vals = sorted(samples[i])
            total = ok[i] + no[i]
            out.append(
                {
                    "t": round(now - window_s + (i + 0.5) * width),
                    "p50": q(vals, 0.50),
                    "p95": q(vals, 0.95),
                    "p99": q(vals, 0.99),
                    "avg_ms": round(sum(vals) / len(vals), 2) if vals else 0.0,
                    "approved": ok[i],
                    "denied": no[i],
                    "total": total,
                }
            )
        return out

    def denial_breakdown(self) -> list[dict]:
        tally: dict[str, int] = {}
        for row in self._ledger:
            if row.decision == "DENIED":
                tally[row.rule] = tally.get(row.rule, 0) + 1
        return sorted(
            ({"rule": k, "count": v} for k, v in tally.items()),
            key=lambda d: d["count"],
            reverse=True,
        )

    def agent_health(self, agent_id: str) -> dict:
        rows = [r for r in self._ledger if r.agent_id == agent_id]
        if not rows:
            return {"decisions": 0, "denial_rate": 0.0, "avg_ms": 0.0}
        denied = sum(1 for r in rows if r.decision == "DENIED")
        return {
            "decisions": len(rows),
            "denial_rate": round(denied / len(rows), 4),
            "avg_ms": round(sum(r.latency_ms for r in rows) / len(rows), 2),
        }


def _dt(ts: float):
    from datetime import datetime, timezone

    return datetime.fromtimestamp(ts, tz=timezone.utc)


def _json(payload: dict) -> str:
    import json

    return json.dumps(payload, default=str)


def row_to_dict(row: LedgerRow) -> dict:
    data = asdict(row)
    data["ts_iso"] = _dt(row.ts).isoformat()
    return data


store = Store()
