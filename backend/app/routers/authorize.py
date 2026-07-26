"""The authorisation path. Everything else in this service exists to serve it.

Order of checks matters and is deliberate:

  1. revocation      cheapest, and an operator's kill switch must beat every
                     other consideration including a valid policy grant
  2. policy scope    pure function of the request; no shared state touched
  3. budget reserve  atomic, and the only step with a side effect

Budget is last so a denial on scope never consumes a reservation. If step 3
succeeds but the caller later reports failure, `/authorize/release` returns the
money. Nothing is ever silently held.

Every outcome is written to the ledger, including the denials. A governance layer
that only records what it permitted is not an audit trail.
"""

from __future__ import annotations

import time
import uuid

from fastapi import APIRouter, Response
from pydantic import BaseModel, Field

from ..core.counters import counters
from ..core.events import bus
from ..core.policy import engine
from ..core.store import LedgerRow, row_to_dict, store

router = APIRouter()


class AuthorizeRequest(BaseModel):
    agent_id: str = Field(min_length=1)
    action: str = Field(min_length=1)
    amount: int = Field(description="Minor units (cents). Must be positive.")
    category: str = Field(min_length=1)
    idempotency_key: str | None = None


class AuthorizeResponse(BaseModel):
    allowed: bool
    reason: str
    rule: str
    engine: str
    trace_id: str
    decision_time_ms: float


class ReleaseRequest(BaseModel):
    trace_id: str


async def authorize_core(
    agent_id: str, action: str, amount: int, category: str, source: str = "api"
) -> AuthorizeResponse:
    started = time.perf_counter()
    trace_id = str(uuid.uuid4())

    agent = store.agent(agent_id)
    agent_type = agent.type if agent else "unknown"

    allowed = False
    rule = "unregistered_agent"
    reason = f"No agent `{agent_id}` is registered. Unregistered agents are denied."
    # Registry checks run before either policy engine is consulted, so the audit
    # row should name the registry rather than claim a policy evaluation happened.
    which_engine = "registry"

    if agent is not None:
        if agent.status == "revoked":
            which_engine = "registry"
            rule = "revoked"
            reason = (
                "Agent is revoked. "
                + (f"Revoked by {agent.revoked_by}." if agent.revoked_by else "")
            ).strip()
        else:
            verdict = await engine.evaluate(agent_id, action, amount, category)
            which_engine = verdict.engine
            if not verdict.allowed:
                rule, reason = verdict.rule, verdict.reason
            else:
                policy = engine.agent_policy(agent_id)
                assert policy is not None
                reservation = await counters.reserve(
                    agent_id=agent_id,
                    agent_type=agent.type,
                    amount=amount,
                    agent_cap=policy.max_daily_spend,
                    type_cap=engine.type_cap(agent.type),
                )
                if reservation.ok:
                    allowed = True
                    rule = "permit"
                    reason = verdict.reason
                else:
                    rule = f"{reservation.scope}_daily_cap"
                    reason = reservation.reason()

    latency_ms = round((time.perf_counter() - started) * 1000, 3)
    response = AuthorizeResponse(
        allowed=allowed,
        reason=reason,
        rule=rule,
        engine=which_engine,
        trace_id=trace_id,
        decision_time_ms=latency_ms,
    )

    row = LedgerRow(
        trace_id=trace_id,
        ts=time.time(),
        agent_id=agent_id,
        agent_type=agent_type,
        action=action,
        amount=amount,
        category=category,
        decision="APPROVED" if allowed else "DENIED",
        reason=reason,
        rule=rule,
        engine=which_engine,
        latency_ms=latency_ms,
        request={
            "agent_id": agent_id, "action": action, "amount": amount,
            "category": category, "source": source,
        },
        response=response.model_dump(),
    )
    await store.append(row)
    store.touch(agent_id)
    bus.publish("decision", row_to_dict(row))
    return response


@router.post("/authorize", response_model=AuthorizeResponse)
async def authorize(req: AuthorizeRequest, response: Response) -> AuthorizeResponse:
    result = await authorize_core(req.agent_id, req.action, req.amount, req.category)
    # A denial is a valid, successful decision about an invalid request. 403 is
    # the honest status for the caller: your request was understood and refused.
    response.status_code = 200 if result.allowed else 403
    return result


@router.post("/authorize/release")
async def release(req: ReleaseRequest) -> dict:
    """Return a reservation after the caller's downstream step failed."""
    row = store.by_trace(req.trace_id)
    if row is None:
        return {"released": False, "reason": "Unknown trace id."}
    if row.decision != "APPROVED":
        return {"released": False, "reason": "That decision was a denial; nothing was reserved."}

    await counters.release(row.agent_id, row.agent_type, row.amount)
    await store.log_control(
        "agent:" + row.agent_id, "release", row.trace_id,
        f"Returned ${row.amount / 100:,.2f} to budget after a downstream failure.",
    )
    return {"released": True, "amount": row.amount, "agent_id": row.agent_id}
