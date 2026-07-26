"""A mock autonomous agent.

Its only job is to demonstrate the integration contract: an agent never touches
the ledger directly. It asks the governance layer first, acts only on an
approval, and hands the budget back if its own downstream step fails.

Run three of them:

    AGENT_ID=agent_fee_reversal_001 PORT=9001 python -m agents.agent_service
    AGENT_ID=agent_dispute_001      PORT=9002 python -m agents.agent_service
    AGENT_ID=agent_claim_001        PORT=9003 python -m agents.agent_service

Then drive one:

    curl -X POST localhost:9001/handle \\
      -d '{"amount": 45000, "category": "late_fee"}' \\
      -H 'Content-Type: application/json'
"""

from __future__ import annotations

import os
import random

import httpx
from fastapi import FastAPI
from pydantic import BaseModel

AGENT_ID = os.getenv("AGENT_ID", "agent_fee_reversal_001")
GOVERNANCE_URL = os.getenv("GOVERNANCE_URL", "http://localhost:8000")
DEFAULT_ACTION = os.getenv("AGENT_ACTION", "approve_refund")

# Probability the agent's own downstream ledger write fails, so the release path
# is exercised rather than just described.
FAILURE_RATE = float(os.getenv("DOWNSTREAM_FAILURE_RATE", "0.08"))

app = FastAPI(title=f"Mock agent {AGENT_ID}")


class Task(BaseModel):
    amount: int
    category: str
    action: str = DEFAULT_ACTION


@app.get("/health")
async def health() -> dict:
    return {"agent_id": AGENT_ID, "governance": GOVERNANCE_URL}


@app.post("/handle")
async def handle(task: Task) -> dict:
    async with httpx.AsyncClient(base_url=GOVERNANCE_URL, timeout=5.0) as client:
        decision = await client.post(
            "/authorize",
            json={
                "agent_id": AGENT_ID,
                "action": task.action,
                "amount": task.amount,
                "category": task.category,
            },
        )
        verdict = decision.json()

        if not verdict["allowed"]:
            # The agent does not retry, argue, or route around the refusal.
            return {
                "acted": False,
                "blocked_by": verdict["rule"],
                "reason": verdict["reason"],
                "trace_id": verdict["trace_id"],
            }

        try:
            await settle(task)
        except RuntimeError as exc:
            # Give the reservation back so the budget is not stranded until midnight.
            await client.post("/authorize/release", json={"trace_id": verdict["trace_id"]})
            return {
                "acted": False,
                "reason": f"Authorised, then the ledger write failed: {exc}. Budget returned.",
                "trace_id": verdict["trace_id"],
            }

        return {
            "acted": True,
            "amount": task.amount,
            "trace_id": verdict["trace_id"],
            "decision_time_ms": verdict["decision_time_ms"],
        }


async def settle(task: Task) -> None:
    """Stand-in for the real money movement."""
    if random.random() < FAILURE_RATE:
        raise RuntimeError("core ledger returned 503")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", "9001")))
