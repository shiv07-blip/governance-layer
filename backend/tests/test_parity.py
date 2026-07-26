"""Rego / embedded parity.

There are two implementations of one rule set: the Rego that OPA evaluates in a
full deployment, and the Python that runs when no sidecar is reachable. Two
implementations drift. If they drift here, the same request gets different
answers depending on which mode the service happens to be in, and the audit log
will not show anything wrong.

So the rule set is treated as the contract and both engines are held to it over a
generated matrix of requests. Skipped when no OPA binary is on PATH, which keeps
the suite green on a laptop while still failing CI where OPA is installed.

    export OPA_BIN=/usr/local/bin/opa   # or just have `opa` on PATH
    pytest tests/test_parity.py -v
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

import pytest

from app.core.policy import compile_policy

OPA_BIN = os.getenv("OPA_BIN") or shutil.which("opa")
POLICY_DIR = Path(__file__).resolve().parents[1] / "policies"

pytestmark = pytest.mark.skipif(
    OPA_BIN is None,
    reason="no opa binary found; set OPA_BIN or put opa on PATH",
)


def _cases(compiled) -> list[dict]:
    """A matrix that lands on both sides of every rule boundary."""
    cases: list[dict] = []
    for agent_id, policy in compiled.agents.items():
        in_scope = (
            "chargeback" if "all" in policy.allowed_categories
            else policy.allowed_categories[0]
        )
        out_scope = "definitely_not_a_real_category"
        good_action = (policy.allowed_actions or ["approve_refund"])[0]
        bad_action = next(
            (a for a in ("approve_refund", "approve_claim", "escalate")
             if policy.allowed_actions and a not in policy.allowed_actions),
            None,
        )
        cap = policy.max_single_transaction
        dual = policy.requires_dual_control_above

        amounts = [1, cap - 1, cap, cap + 1, cap * 3]
        if dual:
            amounts += [dual - 1, dual, dual + 1]

        for amount in amounts:
            cases.append({"agent_id": agent_id, "action": good_action,
                           "amount": amount, "category": in_scope})
        cases.append({"agent_id": agent_id, "action": good_action,
                       "amount": 1000, "category": out_scope})
        if bad_action:
            cases.append({"agent_id": agent_id, "action": bad_action,
                           "amount": 1000, "category": in_scope})
        cases.append({"agent_id": agent_id, "action": "wire_money",
                       "amount": 1000, "category": in_scope})
        cases.append({"agent_id": agent_id, "action": good_action,
                       "amount": 0, "category": in_scope})
        cases.append({"agent_id": agent_id, "action": good_action,
                       "amount": -500, "category": in_scope})

    cases.append({"agent_id": "agent_not_in_policy", "action": "approve_refund",
                   "amount": 1000, "category": "late_fee"})
    return cases


def _opa_eval(compiled, cases: list[dict]) -> list[dict]:
    """One `opa eval` per case against the real Rego and the compiled data."""
    with tempfile.TemporaryDirectory() as tmp:
        data_path = Path(tmp) / "data.json"
        data_path.write_text(json.dumps({"governance": {"config": compiled.as_opa_data()}}))

        out = []
        for case in cases:
            input_path = Path(tmp) / "input.json"
            input_path.write_text(json.dumps(case))
            proc = subprocess.run(
                [
                    OPA_BIN, "eval", "--format", "json",
                    "--data", str(POLICY_DIR / "governance.rego"),
                    "--data", str(data_path),
                    "--input", str(input_path),
                    "data.governance.decision",
                ],
                capture_output=True, text=True, timeout=30,
            )
            assert proc.returncode == 0, f"opa eval failed: {proc.stderr}"
            body = json.loads(proc.stdout)
            out.append(body["result"][0]["expressions"][0]["value"])
        return out


@pytest.fixture(scope="module")
def compiled():
    return compile_policy(
        (POLICY_DIR / "policy.yaml").read_text(), 1, "parity-test"
    )


def test_rego_compiles(compiled):
    proc = subprocess.run(
        [OPA_BIN, "check", str(POLICY_DIR / "governance.rego")],
        capture_output=True, text=True,
    )
    assert proc.returncode == 0, proc.stdout + proc.stderr


def test_both_engines_reach_the_same_verdict(compiled):
    from app.core.policy import PolicyEngine

    local = PolicyEngine()
    local.compiled = compiled

    cases = _cases(compiled)
    opa_results = _opa_eval(compiled, cases)

    mismatches = []
    for case, opa in zip(cases, opa_results):
        mine = local.evaluate_embedded(
            case["agent_id"], case["action"], case["amount"], case["category"]
        )
        if bool(opa["allow"]) != mine.allowed:
            mismatches.append(
                f"{case} -> opa allow={opa['allow']} ({opa['rule']}), "
                f"embedded allow={mine.allowed} ({mine.rule})"
            )

    assert not mismatches, (
        f"{len(mismatches)} of {len(cases)} cases disagree:\n" + "\n".join(mismatches[:15])
    )


def test_both_engines_cite_the_same_rule(compiled):
    """Agreeing on allow/deny is not enough — the audit trail records the rule."""
    from app.core.policy import PolicyEngine

    local = PolicyEngine()
    local.compiled = compiled

    cases = _cases(compiled)
    opa_results = _opa_eval(compiled, cases)

    mismatches = [
        f"{case} -> opa rule={opa['rule']}, embedded rule={local.evaluate_embedded(case['agent_id'], case['action'], case['amount'], case['category']).rule}"
        for case, opa in zip(cases, opa_results)
        if opa["rule"]
        != local.evaluate_embedded(
            case["agent_id"], case["action"], case["amount"], case["category"]
        ).rule
    ]
    assert not mismatches, (
        f"{len(mismatches)} of {len(cases)} cases cite different rules:\n"
        + "\n".join(mismatches[:15])
    )
