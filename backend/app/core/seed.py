"""Demo seeding and a traffic generator.

Two separate jobs:

`seed` backfills a plausible morning of history so the dashboard is never empty
on first load — agents with realistic spend, a few hundred decisions, a spread of
denial reasons.

`Simulator` drives live traffic through the real `/authorize` path. It does not
fabricate log rows; it calls the same authoriser an agent would, so what the
operator sees on screen is the actual enforcement pipeline under load. That makes
it useful for the latency numbers as well as for a demo that looks alive.
"""

from __future__ import annotations

import asyncio
import random
import time

from .counters import counters
from .policy import engine
from .store import Agent, LedgerRow, store

NAMES = {
    "agent_fee_reversal_001": "Fee reversal — tier 1",
    "agent_fee_reversal_002": "Fee reversal — probation",
    "agent_dispute_001": "Dispute resolver — senior",
    "agent_dispute_002": "Dispute resolver — merchant desk",
    "agent_claim_001": "Claim processor — travel and goods",
}

CATEGORIES = {
    "fee_reversal": ["annual_fee", "late_fee", "account_fee", "fx_fee"],
    "dispute_resolver": ["chargeback", "merchant_dispute", "fraud_claim"],
    "claim_processor": ["travel", "purchase", "warranty", "cash_advance"],
}

VALID_ACTION_POOL = ["approve_refund", "approve_claim", "escalate"]

ACTIONS = {
    "fee_reversal": ["approve_refund", "approve_refund", "approve_refund", "escalate"],
    "dispute_resolver": ["approve_claim", "approve_claim", "escalate"],
    "claim_processor": ["approve_claim", "approve_claim", "approve_claim", "approve_refund"],
}

ALL_CATEGORIES = sorted({c for v in CATEGORIES.values() for c in v})


async def register_agents() -> None:
    """Create a registry entry for every agent the policy knows about."""
    compiled = engine.compiled
    if compiled is None:
        return
    for agent_id, policy in compiled.agents.items():
        await store.put_agent(
            Agent(
                id=agent_id,
                name=NAMES.get(agent_id, agent_id),
                type=policy.type,
                daily_cap=policy.max_daily_spend,
                created_at=time.time() - random.randint(20, 90) * 86400,
            )
        )


def _sample_request(policy) -> tuple[str, int, str]:
    """Draw a request the way a mostly well-behaved agent would send one.

    A fleet that gets two thirds of its requests refused is not a governed
    fleet, it is a broken integration — and a demo showing that reads as a bug
    rather than as enforcement working. So the sampler stays inside the agent's
    grant most of the time and steps outside it about one request in eight, which
    is enough to exercise every refusal path while leaving a believable
    approval rate.
    """
    cap = policy.max_single_transaction

    # Action: normally something the agent holds, occasionally something it does not.
    allowed_actions = policy.allowed_actions or ACTIONS[policy.type]
    if random.random() < 0.04:
        action = random.choice([a for a in VALID_ACTION_POOL if a not in allowed_actions] or allowed_actions)
    else:
        action = random.choice(allowed_actions)

    # Category: normally in scope. `all` agents can take anything for their type.
    in_scope = (
        CATEGORIES[policy.type]
        if "all" in policy.allowed_categories
        else policy.allowed_categories
    )
    out_of_scope = [c for c in ALL_CATEGORIES if c not in in_scope]
    if out_of_scope and random.random() < 0.05:
        category = random.choice(out_of_scope)
    else:
        category = random.choice(in_scope)

    # Amount: a long tail toward the cap, plus a thin slice that overshoots it.
    roll = random.random()
    if roll < 0.80:
        amount = random.randint(2_000, max(2_001, int(cap * 0.5)))
    elif roll < 0.96:
        amount = random.randint(int(cap * 0.5), cap)
    else:
        amount = random.randint(cap + 1, int(cap * 1.9))
    return action, amount, category


async def backfill(decisions: int = 320) -> None:
    """Write a trailing few hours of decisions straight into the ledger.

    This path bypasses the live authoriser on purpose: it reconstructs history
    with timestamps in the past, and the counters are seeded separately so the
    spend bars line up with the policy caps.
    """
    compiled = engine.compiled
    if compiled is None:
        return

    now = time.time()
    ids = list(compiled.agents.keys())
    per_agent_spend: dict[str, int] = {aid: 0 for aid in ids}

    # Target spend levels chosen to give the dashboard one healthy agent, one
    # mid-range, one close to its ceiling, so the colour thresholds are visible.
    targets = [0.31, 0.44, 0.62, 0.78, 0.91]
    random.shuffle(targets)
    budget = {
        aid: int(compiled.agents[aid].max_daily_spend * targets[i % len(targets)])
        for i, aid in enumerate(ids)
    }

    rows: list[LedgerRow] = []
    # Once an agent reaches its target for the replayed day it leaves the pool.
    # Letting it keep generating would fill the history with cap denials that say
    # more about how the backfill was written than about how the fleet behaves.
    # A small number are kept on purpose, so the cap-denial path is represented.
    pool = list(ids)
    cap_denials: dict[str, int] = {aid: 0 for aid in ids}
    CAP_DENIAL_TAIL = 3

    while pool and len(rows) < decisions:
        agent_id = random.choice(pool)
        policy = compiled.agents[agent_id]
        action, amount, category = _sample_request(policy)
        verdict = engine.evaluate_embedded(agent_id, action, amount, category)

        approved = verdict.allowed
        reason, rule = verdict.reason, verdict.rule

        if approved and per_agent_spend[agent_id] + amount > budget[agent_id]:
            approved = False
            rule = "agent_daily_cap"
            reason = (
                f"Agent daily cap would be breached "
                f"(used ${per_agent_spend[agent_id] / 100:,.2f} of "
                f"${policy.max_daily_spend / 100:,.2f})"
            )
            cap_denials[agent_id] += 1
            if cap_denials[agent_id] >= CAP_DENIAL_TAIL:
                pool.remove(agent_id)
        elif approved:
            per_agent_spend[agent_id] += amount

        rows.append(
            LedgerRow(
                trace_id=f"bf-{len(rows):05d}-{random.getrandbits(32):08x}",
                ts=0.0,  # assigned once the total count is known
                agent_id=agent_id,
                agent_type=policy.type,
                action=action,
                amount=amount,
                category=category,
                decision="APPROVED" if approved else "DENIED",
                reason=reason,
                rule=rule,
                engine=verdict.engine,
                latency_ms=round(random.uniform(1.6, 9.4), 2),
                request={
                    "agent_id": agent_id, "action": action,
                    "amount": amount, "category": category,
                },
                response={"allowed": approved, "reason": reason},
            )
        )

    # Spread the run across the trailing window, weighted toward the present.
    #
    # A uniform spread over several hours leaves the 15-minute latency chart with
    # one or two samples per bucket, where p50, p95 and p99 all collapse onto the
    # same value and the chart reads as three fake series. Squaring a uniform
    # draw concentrates roughly half the rows into the last quarter of the
    # window, which both fills the chart and looks like traffic ramping up.
    HISTORY_S = 45 * 60
    ages = sorted((random.random() ** 2) * HISTORY_S for _ in rows)
    for row, age in zip(rows, reversed(ages)):
        row.ts = now - age

    for row in sorted(rows, key=lambda r: r.ts):
        await store.append(row)
        store.touch(row.agent_id)

    for agent_id, spent in per_agent_spend.items():
        if spent:
            await counters.seed(agent_id, compiled.agents[agent_id].type, spent)

    await store.log_control(
        "system", "seed", "fleet",
        f"Backfilled {decisions} decisions and reconciled spend counters.",
    )


class Simulator:
    """Drives live traffic through the real authorisation path."""

    def __init__(self) -> None:
        self._task: asyncio.Task | None = None
        self.rate = 3.0  # decisions per second

    @property
    def running(self) -> bool:
        return self._task is not None and not self._task.done()

    def start(self, rate: float = 3.0) -> None:
        self.rate = max(0.2, min(rate, 60.0))
        if self.running:
            return
        self._task = asyncio.create_task(self._run())

    async def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):
                pass
            self._task = None

    async def _run(self) -> None:
        from ..routers.authorize import authorize_core  # late import, avoids a cycle

        while True:
            try:
                compiled = engine.compiled
                if compiled is None:
                    await asyncio.sleep(1)
                    continue
                live = [a for a in store.agents() if a.status == "active"]
                if not live:
                    await asyncio.sleep(1)
                    continue
                agent = random.choice(live)
                policy = compiled.agents.get(agent.id)
                if policy is None:
                    await asyncio.sleep(0.5)
                    continue
                action, amount, category = _sample_request(policy)
                await authorize_core(agent.id, action, amount, category, source="simulator")
                await asyncio.sleep(max(0.02, 1.0 / self.rate))
            except asyncio.CancelledError:
                raise
            except Exception:
                await asyncio.sleep(0.5)


simulator = Simulator()
