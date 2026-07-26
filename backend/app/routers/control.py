"""Operator-facing endpoints: registry, policy, ledger queries, metrics, E-stop."""

from __future__ import annotations

import asyncio
import time

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from ..core.config import runtime, settings
from ..core.counters import counters
from ..core.events import bus
from ..core.policy import PolicyError, engine
from ..core.seed import simulator
from ..core.store import row_to_dict, store

router = APIRouter()

# The operator identity would come from SSO in a real deployment. Kept explicit
# rather than defaulted so every control-log row names a person.
DEFAULT_ACTOR = "operator_local"


# ---------------------------------------------------------------- registry


@router.get("/agents")
async def list_agents() -> list[dict]:
    out = []
    for agent in store.agents():
        policy = engine.agent_policy(agent.id)
        spend = await counters.get(agent.id)
        health = store.agent_health(agent.id)
        out.append(
            {
                "id": agent.id,
                "name": agent.name,
                "type": agent.type,
                "status": agent.status,
                "daily_spend": spend,
                "daily_cap": policy.max_daily_spend if policy else agent.daily_cap,
                "single_cap": policy.max_single_transaction if policy else None,
                "allowed_categories": policy.allowed_categories if policy else [],
                "allowed_actions": policy.allowed_actions if policy else [],
                "dual_control_above": policy.requires_dual_control_above if policy else None,
                "last_action_at": agent.last_action_at,
                "created_at": agent.created_at,
                "revoked_at": agent.revoked_at,
                "revoked_by": agent.revoked_by,
                "in_policy": policy is not None,
                **health,
            }
        )
    return out


class ActorBody(BaseModel):
    actor: str = DEFAULT_ACTOR
    note: str = ""


@router.post("/agents/{agent_id}/revoke")
async def revoke_agent(agent_id: str, body: ActorBody | None = None) -> dict:
    body = body or ActorBody()
    agent = await store.set_status(agent_id, "revoked", body.actor)
    if agent is None:
        raise HTTPException(404, f"No agent `{agent_id}`.")
    row = await store.log_control(
        body.actor, "revoke", agent_id,
        body.note or "Revoked from the agent list.",
    )
    bus.publish("control", {"action": "revoke", "target": agent_id, "ts": row.ts})
    return {"status": "revoked", "agent_id": agent_id, "at": agent.revoked_at}


@router.post("/agents/{agent_id}/reinstate")
async def reinstate_agent(agent_id: str, body: ActorBody | None = None) -> dict:
    body = body or ActorBody()
    agent = await store.set_status(agent_id, "active", body.actor)
    if agent is None:
        raise HTTPException(404, f"No agent `{agent_id}`.")
    row = await store.log_control(
        body.actor, "reinstate", agent_id, body.note or "Returned to service."
    )
    bus.publish("control", {"action": "reinstate", "target": agent_id, "ts": row.ts})
    return {"status": "active", "agent_id": agent_id}


@router.post("/agents/{agent_id}/reset-budget")
async def reset_budget(agent_id: str, body: ActorBody | None = None) -> dict:
    body = body or ActorBody()
    if store.agent(agent_id) is None:
        raise HTTPException(404, f"No agent `{agent_id}`.")
    before = await counters.get(agent_id)
    await counters.reset_agent(agent_id)
    row = await store.log_control(
        body.actor, "reset_budget", agent_id,
        f"Cleared ${before / 100:,.2f} of recorded spend.",
    )
    bus.publish("control", {"action": "reset_budget", "target": agent_id, "ts": row.ts})
    return {"status": "reset", "agent_id": agent_id, "cleared": before, "new_spend": 0}


# ---------------------------------------------------------------- policy


class PolicyUpdate(BaseModel):
    policies_yaml: str = Field(min_length=1)
    actor: str = DEFAULT_ACTOR


@router.get("/policies")
async def get_policy() -> dict:
    compiled = engine.compiled
    if compiled is None:
        raise HTTPException(503, "No policy is loaded.")
    return {
        "version": compiled.version,
        "yaml_content": compiled.yaml_text,
        "deployed_at": compiled.deployed_at,
        "deployed_by": compiled.deployed_by,
        "agent_count": len(compiled.agents),
        "engine": "opa" if runtime.opa else "embedded",
    }


@router.post("/policies/validate")
async def validate_policy(body: PolicyUpdate) -> dict:
    """Dry run. Same validator the deploy path uses, no side effects."""
    from ..core.policy import compile_policy

    try:
        compiled = compile_policy(body.policies_yaml, 0, body.actor)
    except PolicyError as exc:
        return {"valid": False, "error": str(exc)}

    current = engine.compiled
    diff = []
    if current is not None:
        for aid, new in compiled.agents.items():
            old = current.agents.get(aid)
            if old is None:
                diff.append(f"+ {aid} added ({new.type})")
                continue
            if old.max_single_transaction != new.max_single_transaction:
                diff.append(
                    f"~ {aid} per-transaction ${old.max_single_transaction / 100:,.0f} "
                    f"→ ${new.max_single_transaction / 100:,.0f}"
                )
            if old.max_daily_spend != new.max_daily_spend:
                diff.append(
                    f"~ {aid} daily ${old.max_daily_spend / 100:,.0f} "
                    f"→ ${new.max_daily_spend / 100:,.0f}"
                )
            if set(old.allowed_categories) != set(new.allowed_categories):
                diff.append(f"~ {aid} categories changed")
            if set(old.allowed_actions) != set(new.allowed_actions):
                diff.append(f"~ {aid} actions changed")
        for aid in current.agents:
            if aid not in compiled.agents:
                diff.append(f"- {aid} removed — it will be denied on next request")

    return {"valid": True, "agent_count": len(compiled.agents), "changes": diff}


@router.post("/policies/update")
async def update_policy(body: PolicyUpdate) -> dict:
    compiled = engine.compiled
    next_version = (compiled.version + 1) if compiled else 1
    try:
        new = await engine.load(body.policies_yaml, next_version, body.actor)
    except PolicyError as exc:
        # The previous policy is still serving. Nothing changed.
        raise HTTPException(400, str(exc)) from exc

    from ..core.seed import register_agents

    await register_agents()
    row = await store.log_control(
        body.actor, "deploy_policy", f"v{new.version}",
        f"Deployed policy v{new.version} covering {len(new.agents)} agents.",
    )
    bus.publish("control", {"action": "deploy_policy", "target": f"v{new.version}", "ts": row.ts})
    return {
        "status": "deployed",
        "version": new.version,
        "deployed_at": new.deployed_at,
        "agent_count": len(new.agents),
        "engine": "opa" if runtime.opa else "embedded",
    }


# ---------------------------------------------------------------- ledger


@router.get("/logs")
async def get_logs(
    agent_id: str | None = None,
    agent_type: str | None = None,
    decision: str | None = None,
    search: str | None = None,
    date_from: float | None = None,
    date_to: float | None = None,
    limit: int = Query(200, ge=1, le=1000),
    offset: int = Query(0, ge=0),
) -> dict:
    rows, total = store.query(
        agent_id=agent_id, agent_type=agent_type, decision=decision,
        search=search, date_from=date_from, date_to=date_to,
        limit=limit, offset=offset,
    )
    return {
        "logs": [row_to_dict(r) for r in rows],
        "total_count": total,
        "limit": limit,
        "offset": offset,
    }


@router.get("/logs/{trace_id}")
async def get_log(trace_id: str) -> dict:
    row = store.by_trace(trace_id)
    if row is None:
        raise HTTPException(404, f"No decision with trace id `{trace_id}`.")
    return row_to_dict(row)


# ---------------------------------------------------------------- metrics


@router.get("/metrics")
async def metrics() -> dict:
    approved, denied = store.counts()
    avg, p95, p99 = store.latency_percentiles()
    agents = store.agents()
    fleet_spend = await counters.fleet_total()
    return {
        "requests_approved": approved,
        "requests_denied": denied,
        "avg_latency_ms": avg,
        "p95_latency_ms": p95,
        "p99_latency_ms": p99,
        "agents_active": sum(1 for a in agents if a.status == "active"),
        "agents_revoked": sum(1 for a in agents if a.status == "revoked"),
        "agents_total": len(agents),
        "fleet_daily_spend": fleet_spend,
        "fleet_daily_cap": settings.fleet_daily_cap,
        "denial_breakdown": store.denial_breakdown(),
        "latency_series": store.latency_series(),
        "runtime": runtime.as_dict(),
        "simulator_running": simulator.running,
        "simulator_rate": simulator.rate,
        "stream_listeners": bus.listeners,
    }


@router.get("/control-log")
async def control_log(limit: int = Query(20, ge=1, le=200)) -> list[dict]:
    return [
        {
            "id": r.id, "ts": r.ts, "actor": r.actor,
            "action": r.action, "target": r.target, "detail": r.detail,
        }
        for r in store.control_log(limit)
    ]


# ---------------------------------------------------------------- emergency


class HaltBody(BaseModel):
    actor: str = DEFAULT_ACTOR
    reason: str = ""


@router.post("/emergency/halt-fleet")
async def halt_fleet(body: HaltBody | None = None) -> dict:
    body = body or HaltBody()
    await simulator.stop()
    changed = await store.revoke_all(body.actor)
    row = await store.log_control(
        body.actor, "halt_fleet", "fleet",
        body.reason or f"Fleet stop. {len(changed)} agents revoked.",
    )
    bus.publish("control", {"action": "halt_fleet", "target": "fleet", "ts": row.ts})
    return {
        "status": "all_agents_revoked",
        "revoked": changed,
        "count": len(changed),
        "at": row.ts,
    }


@router.post("/emergency/reset-budgets")
async def reset_all_budgets(body: HaltBody | None = None) -> dict:
    body = body or HaltBody()
    await counters.reset_all()
    row = await store.log_control(
        body.actor, "reset_all", "fleet",
        body.reason or "Cleared every spend counter.",
    )
    bus.publish("control", {"action": "reset_all", "target": "fleet", "ts": row.ts})
    return {"status": "all_budgets_reset", "at": row.ts}


@router.post("/emergency/reinstate-fleet")
async def reinstate_fleet(body: HaltBody | None = None) -> dict:
    body = body or HaltBody()
    restored = []
    for agent in store.agents():
        if agent.status == "revoked":
            await store.set_status(agent.id, "active", body.actor)
            restored.append(agent.id)
    row = await store.log_control(
        body.actor, "reinstate_fleet", "fleet",
        body.reason or f"Returned {len(restored)} agents to service.",
    )
    bus.publish("control", {"action": "reinstate_fleet", "target": "fleet", "ts": row.ts})
    return {"status": "restored", "restored": restored, "count": len(restored)}


# ---------------------------------------------------------------- simulator


class SimBody(BaseModel):
    rate: float = 3.0


@router.post("/simulate/start")
async def sim_start(body: SimBody | None = None) -> dict:
    body = body or SimBody()
    simulator.start(body.rate)
    return {"running": True, "rate": simulator.rate}


@router.post("/simulate/stop")
async def sim_stop() -> dict:
    await simulator.stop()
    return {"running": False}


# ---------------------------------------------------------------- stream


@router.get("/stream")
async def stream(request: Request) -> StreamingResponse:
    """Server-sent events. Decisions and control actions as they happen."""
    queue = bus.subscribe()

    async def gen():
        try:
            yield 'event: hello\ndata: {"ok":true}\n\n'
            while True:
                if await request.is_disconnected():
                    break
                try:
                    frame = await asyncio.wait_for(queue.get(), timeout=15.0)
                    yield f"data: {frame}\n\n"
                except asyncio.TimeoutError:
                    yield ": keep-alive\n\n"
        finally:
            bus.unsubscribe(queue)

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
