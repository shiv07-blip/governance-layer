"""Policy engine.

Operators author policy as YAML because that is what a risk team will actually
maintain. That YAML is compiled into a decision table and pushed to OPA as
`data.governance.config`, so the Rego rules stay fixed while the data changes.
Hot reload is therefore a data upload, not a code deploy — no restart, no
in-flight request dropped.

If no OPA sidecar answers, the identical rule set runs in-process. Two
implementations of one rule set is a real risk, so `tests/test_parity.py`
asserts they agree on a matrix of cases.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Optional

import yaml

from .config import runtime, settings

VALID_TYPES = {"fee_reversal", "dispute_resolver", "claim_processor"}
VALID_ACTIONS = {"approve_refund", "approve_claim", "escalate"}


class PolicyError(ValueError):
    """Raised with an operator-readable message. Surfaced verbatim in the UI."""


@dataclass
class AgentPolicy:
    id: str
    type: str
    max_single_transaction: int
    max_daily_spend: int
    allowed_categories: list[str]
    allowed_actions: list[str] = field(default_factory=list)
    requires_dual_control_above: Optional[int] = None

    def permits_category(self, category: str) -> bool:
        return "all" in self.allowed_categories or category in self.allowed_categories

    def permits_action(self, action: str) -> bool:
        return not self.allowed_actions or action in self.allowed_actions


@dataclass
class CompiledPolicy:
    version: int
    yaml_text: str
    deployed_at: float
    deployed_by: str
    agents: dict[str, AgentPolicy]
    type_daily_caps: dict[str, int]

    def as_opa_data(self) -> dict[str, Any]:
        return {
            "agents": {
                aid: {
                    "type": p.type,
                    "max_single_transaction": p.max_single_transaction,
                    "max_daily_spend": p.max_daily_spend,
                    "allowed_categories": p.allowed_categories,
                    "allowed_actions": p.allowed_actions,
                    "requires_dual_control_above": p.requires_dual_control_above,
                }
                for aid, p in self.agents.items()
            },
            "type_daily_caps": self.type_daily_caps,
        }


def compile_policy(text: str, version: int, author: str) -> CompiledPolicy:
    """Parse and validate operator YAML. Rejects on the first real problem.

    Validation is strict on purpose. A typo in a category name would otherwise
    silently widen or narrow an agent's authority, and nothing in the audit log
    would look wrong.
    """
    try:
        doc = yaml.safe_load(text)
    except yaml.YAMLError as exc:
        raise PolicyError(f"YAML will not parse: {exc}") from exc

    if not isinstance(doc, dict) or "agents" not in doc:
        raise PolicyError("Policy needs a top-level `agents:` list.")
    if not isinstance(doc["agents"], list) or not doc["agents"]:
        raise PolicyError("`agents:` must be a non-empty list.")

    agents: dict[str, AgentPolicy] = {}
    for index, entry in enumerate(doc["agents"]):
        where = f"agents[{index}]"
        if not isinstance(entry, dict):
            raise PolicyError(f"{where} is not a mapping.")

        for required in ("id", "type", "max_single_transaction", "max_daily_spend"):
            if required not in entry:
                raise PolicyError(f"{where} is missing `{required}`.")

        aid = str(entry["id"])
        if aid in agents:
            raise PolicyError(f"Duplicate agent id `{aid}`.")

        atype = str(entry["type"])
        if atype not in VALID_TYPES:
            raise PolicyError(
                f"{where} type `{atype}` is not one of {sorted(VALID_TYPES)}."
            )

        try:
            single = int(entry["max_single_transaction"])
            daily = int(entry["max_daily_spend"])
        except (TypeError, ValueError) as exc:
            raise PolicyError(f"{where} caps must be whole numbers of cents.") from exc

        if single <= 0 or daily <= 0:
            raise PolicyError(f"{where} caps must be greater than zero.")
        if single > daily:
            raise PolicyError(
                f"{where} allows a single transaction of ${single / 100:,.2f} but a "
                f"daily total of only ${daily / 100:,.2f}. The daily cap would be "
                "unreachable — raise it or lower the single-transaction limit."
            )

        categories = entry.get("allowed_categories") or []
        if not isinstance(categories, list) or not categories:
            raise PolicyError(f"{where} needs at least one entry in allowed_categories.")
        categories = [str(c) for c in categories]

        actions = entry.get("allowed_actions") or []
        if not isinstance(actions, list):
            raise PolicyError(f"{where} allowed_actions must be a list.")
        actions = [str(a) for a in actions]
        unknown = set(actions) - VALID_ACTIONS
        if unknown:
            raise PolicyError(
                f"{where} lists unknown actions {sorted(unknown)}. "
                f"Valid actions: {sorted(VALID_ACTIONS)}."
            )

        dual = entry.get("requires_dual_control_above")
        if dual is not None:
            try:
                dual = int(dual)
            except (TypeError, ValueError) as exc:
                raise PolicyError(
                    f"{where} requires_dual_control_above must be a number of cents."
                ) from exc

        agents[aid] = AgentPolicy(
            id=aid,
            type=atype,
            max_single_transaction=single,
            max_daily_spend=daily,
            allowed_categories=categories,
            allowed_actions=actions,
            requires_dual_control_above=dual,
        )

    raw_type_caps = doc.get("type_daily_caps") or {}
    if not isinstance(raw_type_caps, dict):
        raise PolicyError("`type_daily_caps:` must be a mapping of type to cents.")

    type_caps: dict[str, int] = {}
    for atype in VALID_TYPES:
        if atype in raw_type_caps:
            type_caps[atype] = int(raw_type_caps[atype])
        else:
            # No explicit ceiling: fall back to the sum of member agents, which
            # means the type cap never binds tighter than the agents themselves.
            type_caps[atype] = sum(
                p.max_daily_spend for p in agents.values() if p.type == atype
            ) or 10**12

    return CompiledPolicy(
        version=version,
        yaml_text=text,
        deployed_at=time.time(),
        deployed_by=author,
        agents=agents,
        type_daily_caps=type_caps,
    )


@dataclass
class Verdict:
    allowed: bool
    reason: str
    rule: str  # which check decided, for the audit trail
    engine: str  # opa | embedded


class PolicyEngine:
    def __init__(self) -> None:
        self.compiled: Optional[CompiledPolicy] = None
        self._opa: Any = None
        self._rego_loaded = False

    # ---------------------------------------------------------------- lifecycle

    async def connect(self) -> None:
        if not settings.opa_url:
            return
        try:
            import httpx

            client = httpx.AsyncClient(base_url=settings.opa_url, timeout=1.0)
            resp = await client.get("/health")
            resp.raise_for_status()
            self._opa = client
            runtime.opa = True
            await self._push_rego()
            # Only claim OPA is the policy engine once it can actually answer.
            runtime.opa = self._rego_loaded
        except Exception:
            self._opa = None
            runtime.opa = False

    async def close(self) -> None:
        if self._opa is not None:
            await self._opa.aclose()

    async def _push_rego(self) -> None:
        """Upload the rule module. The control plane owns what OPA evaluates.

        OPA is deliberately started with no policy of its own. If a module were
        also preloaded from disk it would declare the same package as this one,
        the upload would be rejected as a conflict, and the service would fall
        back to the embedded engine — quietly, which is the worst outcome of the
        three. One owner, one module, one place to look.
        """
        try:
            with open(settings.rego_path, "r", encoding="utf-8") as fh:
                rego = fh.read()
            resp = await self._opa.put(
                "/v1/policies/governance",
                content=rego,
                headers={"Content-Type": "text/plain"},
            )
            if resp.status_code >= 400:
                raise RuntimeError(f"OPA rejected the module: {resp.status_code} {resp.text[:400]}")
            self._rego_loaded = True
            runtime.opa_note = ""
        except Exception as exc:
            self._rego_loaded = False
            runtime.opa_note = f"reachable, but the rule module was not accepted: {exc}"

    async def load(self, text: str, version: int, author: str) -> CompiledPolicy:
        """Validate, then swap. A rejected policy leaves the old one serving."""
        compiled = compile_policy(text, version, author)
        self.compiled = compiled
        if self._opa is not None:
            try:
                resp = await self._opa.put(
                    "/v1/data/governance/config", json=compiled.as_opa_data()
                )
                if resp.status_code >= 400:
                    raise RuntimeError(f"{resp.status_code} {resp.text[:200]}")
                runtime.opa_note = ""
            except Exception as exc:
                # OPA now holds stale config. Stop trusting it for decisions.
                self._rego_loaded = False
                runtime.opa = False
                runtime.opa_note = f"config upload failed, using the embedded engine: {exc}"
        return compiled

    # ---------------------------------------------------------------- decisions

    def agent_policy(self, agent_id: str) -> Optional[AgentPolicy]:
        if self.compiled is None:
            return None
        return self.compiled.agents.get(agent_id)

    def type_cap(self, agent_type: str) -> int:
        if self.compiled is None:
            return 10**12
        return self.compiled.type_daily_caps.get(agent_type, 10**12)

    async def evaluate(
        self, agent_id: str, action: str, amount: int, category: str
    ) -> Verdict:
        if self._opa is not None and self._rego_loaded:
            verdict = await self._evaluate_opa(agent_id, action, amount, category)
            if verdict is not None:
                return verdict
        return self.evaluate_embedded(agent_id, action, amount, category)

    async def _evaluate_opa(
        self, agent_id: str, action: str, amount: int, category: str
    ) -> Optional[Verdict]:
        try:
            resp = await self._opa.post(
                "/v1/data/governance/decision",
                json={
                    "input": {
                        "agent_id": agent_id,
                        "action": action,
                        "amount": amount,
                        "category": category,
                    }
                },
            )
            body = resp.json().get("result")
            if not isinstance(body, dict) or "allow" not in body:
                return None
            return Verdict(
                allowed=bool(body["allow"]),
                reason=str(body.get("reason") or "policy check passed"),
                rule=str(body.get("rule") or "opa"),
                engine="opa",
            )
        except Exception:
            # Sidecar wobbled. Fall through to the embedded engine rather than
            # failing open or blocking the agent.
            return None

    def evaluate_embedded(
        self, agent_id: str, action: str, amount: int, category: str
    ) -> Verdict:
        policy = self.agent_policy(agent_id)

        if policy is None:
            return Verdict(
                False,
                f"No policy is registered for `{agent_id}`. Unregistered agents are denied.",
                "unregistered_agent",
                "embedded",
            )
        if amount <= 0:
            return Verdict(False, "Amount must be positive.", "amount_positive", "embedded")
        if action not in VALID_ACTIONS:
            return Verdict(
                False, f"Unknown action `{action}`.", "known_action", "embedded"
            )
        if not policy.permits_action(action):
            return Verdict(
                False,
                f"`{policy.type}` agents may not perform `{action}`.",
                "action_scope",
                "embedded",
            )
        if not policy.permits_category(category):
            return Verdict(
                False,
                f"Category `{category}` is outside this agent's scope "
                f"({', '.join(policy.allowed_categories)}).",
                "category_scope",
                "embedded",
            )
        if amount > policy.max_single_transaction:
            return Verdict(
                False,
                f"${amount / 100:,.2f} exceeds the per-transaction limit of "
                f"${policy.max_single_transaction / 100:,.2f}.",
                "single_transaction_cap",
                "embedded",
            )
        if (
            policy.requires_dual_control_above is not None
            and amount > policy.requires_dual_control_above
        ):
            return Verdict(
                False,
                f"${amount / 100:,.2f} is above the dual-control threshold of "
                f"${policy.requires_dual_control_above / 100:,.2f} and needs a "
                "human approver.",
                "dual_control",
                "embedded",
            )
        return Verdict(True, "policy check passed", "permit", "embedded")


engine = PolicyEngine()
