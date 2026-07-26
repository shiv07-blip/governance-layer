"""Tests for the enforcement chain.

The cases worth writing down are the ones where a plausible implementation is
wrong: concurrent requests racing the same cap, a denial that should not consume
budget, a revocation that must beat a valid policy grant, and a bad policy that
must not take down the good one already serving.
"""

import asyncio
import os

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

os.environ["SEED_DEMO_DATA"] = "0"

from app.core.counters import counters  # noqa: E402
from app.core.policy import PolicyError, compile_policy  # noqa: E402
from app.main import app  # noqa: E402

FEE = "agent_fee_reversal_001"
PROBATION = "agent_fee_reversal_002"
DISPUTE = "agent_dispute_001"


@pytest_asyncio.fixture
async def client():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        async with app.router.lifespan_context(app):
            await counters.reset_all()
            yield c


async def ask(client, agent_id, action="approve_refund", amount=1000, category="late_fee"):
    r = await client.post(
        "/authorize",
        json={"agent_id": agent_id, "action": action, "amount": amount, "category": category},
    )
    return r.status_code, r.json()


# ---------------------------------------------------------------- policy scope


@pytest.mark.asyncio
async def test_permits_a_request_inside_every_limit(client):
    status, body = await ask(client, FEE, amount=45_000, category="late_fee")
    assert status == 200
    assert body["allowed"] is True
    assert body["rule"] == "permit"
    assert body["trace_id"]


@pytest.mark.asyncio
async def test_denial_returns_403_not_200(client):
    status, body = await ask(client, "agent_does_not_exist")
    assert status == 403
    assert body["allowed"] is False
    assert body["rule"] == "unregistered_agent"


@pytest.mark.asyncio
async def test_per_transaction_cap(client):
    _, body = await ask(client, FEE, amount=900_000, category="late_fee")
    assert body["allowed"] is False
    assert body["rule"] == "single_transaction_cap"


@pytest.mark.asyncio
async def test_category_outside_scope(client):
    _, body = await ask(client, FEE, amount=10_000, category="chargeback")
    assert body["allowed"] is False
    assert body["rule"] == "category_scope"


@pytest.mark.asyncio
async def test_action_outside_scope(client):
    _, body = await ask(client, PROBATION, action="escalate", amount=10_000)
    assert body["allowed"] is False
    assert body["rule"] == "action_scope"


@pytest.mark.asyncio
async def test_dual_control_threshold(client):
    # $8,000 sits under the $10,000 per-transaction cap but above the $7,500
    # dual-control line, so it must go to a human rather than through.
    _, body = await ask(
        client, DISPUTE, action="approve_claim", amount=800_000, category="fraud_claim"
    )
    assert body["allowed"] is False
    assert body["rule"] == "dual_control"


@pytest.mark.asyncio
async def test_negative_amount_rejected(client):
    _, body = await ask(client, FEE, amount=-5000)
    assert body["allowed"] is False


# ---------------------------------------------------------------- budgets


@pytest.mark.asyncio
async def test_daily_cap_binds(client):
    """Probation agent: $1,500 per transaction, $30,000 per day = 20 approvals."""
    approved = 0
    for _ in range(30):
        _, body = await ask(client, PROBATION, amount=150_000, category="late_fee")
        if body["allowed"]:
            approved += 1
    assert approved == 20
    _, body = await ask(client, PROBATION, amount=150_000, category="late_fee")
    assert body["rule"] == "agent_daily_cap"


@pytest.mark.asyncio
async def test_denied_request_does_not_consume_budget(client):
    before = await counters.get(FEE)
    await ask(client, FEE, amount=10_000, category="chargeback")  # wrong category
    await ask(client, FEE, amount=900_000, category="late_fee")   # over single cap
    assert await counters.get(FEE) == before


@pytest.mark.asyncio
async def test_concurrent_requests_cannot_oversubscribe_a_cap(client):
    """The race this whole design exists to prevent.

    Fifty simultaneous requests of $1,500 against a $30,000 daily cap. A
    read-check-write implementation lets more than 20 through. Exactly 20 must
    be approved and the total must land on the cap, not above it.
    """
    results = await asyncio.gather(
        *[ask(client, PROBATION, amount=150_000, category="late_fee") for _ in range(50)]
    )
    approved = sum(1 for _, body in results if body["allowed"])
    assert approved == 20, f"expected 20 approvals, got {approved}"
    assert await counters.get(PROBATION) == 3_000_000


@pytest.mark.asyncio
async def test_release_returns_budget(client):
    _, body = await ask(client, FEE, amount=100_000, category="late_fee")
    assert body["allowed"]
    spent = await counters.get(FEE)

    r = await client.post("/authorize/release", json={"trace_id": body["trace_id"]})
    assert r.json()["released"] is True
    assert await counters.get(FEE) == spent - 100_000


@pytest.mark.asyncio
async def test_release_refuses_on_a_denial(client):
    _, body = await ask(client, FEE, amount=900_000, category="late_fee")
    r = await client.post("/authorize/release", json={"trace_id": body["trace_id"]})
    assert r.json()["released"] is False


# ---------------------------------------------------------------- revocation


@pytest.mark.asyncio
async def test_revocation_beats_a_valid_policy_grant(client):
    _, body = await ask(client, FEE, amount=10_000, category="late_fee")
    assert body["allowed"] is True

    await client.post(f"/agents/{FEE}/revoke", json={"actor": "test"})
    _, body = await ask(client, FEE, amount=10_000, category="late_fee")
    assert body["allowed"] is False
    assert body["rule"] == "revoked"

    await client.post(f"/agents/{FEE}/reinstate", json={"actor": "test"})
    _, body = await ask(client, FEE, amount=10_000, category="late_fee")
    assert body["allowed"] is True


@pytest.mark.asyncio
async def test_fleet_halt_stops_everything(client):
    r = await client.post("/emergency/halt-fleet", json={"actor": "test"})
    assert r.json()["status"] == "all_agents_revoked"

    for agent_id in (FEE, PROBATION, DISPUTE):
        _, body = await ask(client, agent_id, amount=1_000, category="late_fee")
        assert body["allowed"] is False, f"{agent_id} still authorising after fleet halt"

    await client.post("/emergency/reinstate-fleet", json={"actor": "test"})
    _, body = await ask(client, FEE, amount=1_000, category="late_fee")
    assert body["allowed"] is True


@pytest.mark.asyncio
async def test_revocation_is_recorded_with_an_actor(client):
    await client.post(f"/agents/{FEE}/revoke", json={"actor": "risk_lead_ana"})
    rows = (await client.get("/control-log")).json()
    entry = next(r for r in rows if r["action"] == "revoke")
    assert entry["actor"] == "risk_lead_ana"
    assert entry["target"] == FEE


# ---------------------------------------------------------------- audit trail


@pytest.mark.asyncio
async def test_denials_are_logged_not_just_approvals(client):
    await ask(client, FEE, amount=900_000, category="late_fee")
    rows = (await client.get("/logs", params={"decision": "DENIED"})).json()
    assert rows["total_count"] >= 1
    assert rows["logs"][0]["rule"] == "single_transaction_cap"


@pytest.mark.asyncio
async def test_every_decision_is_retrievable_by_trace_id(client):
    _, body = await ask(client, FEE, amount=20_000, category="late_fee")
    row = (await client.get(f"/logs/{body['trace_id']}")).json()
    assert row["trace_id"] == body["trace_id"]
    assert row["amount"] == 20_000
    assert row["request"]["category"] == "late_fee"
    assert row["response"]["allowed"] is True


@pytest.mark.asyncio
async def test_ledger_exposes_no_mutation_path():
    """Immutability is a property of the interface, so assert on the interface."""
    from app.core import store as store_module

    forbidden = [
        name
        for name in dir(store_module.Store)
        if any(name.startswith(p) for p in ("update_log", "delete", "edit_", "remove_log"))
    ]
    assert forbidden == []


# ---------------------------------------------------------------- policy deploys


@pytest.mark.asyncio
async def test_valid_policy_deploys_and_takes_effect_immediately(client):
    tighter = """
agents:
  - id: agent_fee_reversal_001
    type: fee_reversal
    max_single_transaction: 5000
    max_daily_spend: 100000
    allowed_actions: [approve_refund]
    allowed_categories: [late_fee]
"""
    r = await client.post(
        "/policies/update", json={"policies_yaml": tighter, "actor": "test"}
    )
    assert r.status_code == 200

    # $500 was fine a moment ago; the new $50 ceiling must bite with no restart.
    _, body = await ask(client, FEE, amount=50_000, category="late_fee")
    assert body["allowed"] is False
    assert body["rule"] == "single_transaction_cap"


@pytest.mark.asyncio
async def test_broken_policy_is_rejected_and_the_old_one_keeps_serving(client):
    before = (await client.get("/policies")).json()["version"]

    r = await client.post(
        "/policies/update",
        json={"policies_yaml": "agents:\n  - id: x\n    type: nonsense\n", "actor": "test"},
    )
    assert r.status_code == 400

    after = (await client.get("/policies")).json()["version"]
    assert after == before

    _, body = await ask(client, FEE, amount=10_000, category="late_fee")
    assert body["allowed"] is True, "old policy stopped serving after a rejected deploy"


@pytest.mark.asyncio
async def test_validate_is_a_dry_run(client):
    before = (await client.get("/policies")).json()["version"]
    r = await client.post(
        "/policies/validate",
        json={
            "policies_yaml": """
agents:
  - id: agent_new_001
    type: claim_processor
    max_single_transaction: 1000
    max_daily_spend: 5000
    allowed_categories: [travel]
""",
            "actor": "test",
        },
    )
    body = r.json()
    assert body["valid"] is True
    assert any("agent_new_001" in c for c in body["changes"])
    assert (await client.get("/policies")).json()["version"] == before


def test_validator_catches_an_unreachable_daily_cap():
    with pytest.raises(PolicyError, match="unreachable"):
        compile_policy(
            """
agents:
  - id: a
    type: fee_reversal
    max_single_transaction: 100000
    max_daily_spend: 5000
    allowed_categories: [late_fee]
""",
            1,
            "test",
        )


def test_validator_catches_duplicate_ids():
    with pytest.raises(PolicyError, match="Duplicate"):
        compile_policy(
            """
agents:
  - id: a
    type: fee_reversal
    max_single_transaction: 1000
    max_daily_spend: 5000
    allowed_categories: [late_fee]
  - id: a
    type: fee_reversal
    max_single_transaction: 1000
    max_daily_spend: 5000
    allowed_categories: [late_fee]
""",
            1,
            "test",
        )


def test_validator_catches_unknown_action():
    with pytest.raises(PolicyError, match="unknown actions"):
        compile_policy(
            """
agents:
  - id: a
    type: fee_reversal
    max_single_transaction: 1000
    max_daily_spend: 5000
    allowed_actions: [wire_money]
    allowed_categories: [late_fee]
""",
            1,
            "test",
        )


# ---------------------------------------------------------------- observability


@pytest.mark.asyncio
async def test_metrics_report_the_real_backing_services(client):
    body = (await client.get("/metrics")).json()
    assert set(body["runtime"]) >= {"postgres", "redis", "opa", "policy_engine"}
    assert body["runtime"]["policy_engine"] in {"opa", "embedded"}


@pytest.mark.asyncio
async def test_latency_is_measured_per_decision(client):
    _, body = await ask(client, FEE, amount=1_000, category="late_fee")
    assert body["decision_time_ms"] > 0
    metrics = (await client.get("/metrics")).json()
    assert metrics["p99_latency_ms"] >= metrics["avg_latency_ms"]
