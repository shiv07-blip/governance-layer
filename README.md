# Governance layer for financial agents

Permission, budget and revocation controls that sit between a fleet of
autonomous agents and the systems that move money.

Built for CodeStreet 2026, theme 5.

---

## The problem this solves

An autonomous agent that can approve a refund is an agent that can spend money
without a human in the loop. One of them is a manageable risk. Fifty of them,
each individually well-behaved, is a systemic one — because nothing in the
picture answers these questions:

- What is this specific agent allowed to do, and who decided that?
- How much has the fleet committed today, and against what ceiling?
- If one agent starts misbehaving at 2am, how fast can it be stopped?
- Six months later, why was this particular $9,400 claim approved?

This service answers all four. Agents ask it before they act; it decides, records
the decision, and can withdraw an agent's authority instantly.

---

## What is actually enforced

Three checks run in a deliberate order.

```
  agent request
       │
       ▼
  1. registry     is this agent known, and is it revoked?
       │          cheapest check, and an operator's kill switch must beat
       │          every other consideration including a valid policy grant
       ▼
  2. policy       may this agent take this action, in this category,
       │          at this size?  pure function of the request — no shared
       │          state touched, so a refusal here costs nothing
       ▼
  3. budget       is there room under the agent, agent-type and fleet
       │          ceilings?  atomic, and the only step with a side effect
       ▼
  permitted → the agent acts.  refused → the agent stops.
  either way, a row lands in the ledger.
```

Budget is deliberately last. A refusal on scope must never consume a
reservation, or agents get quietly starved by requests that were rejected anyway.

### Why spend caps are not in Rego

OPA has no transactional state. A cap needs read-check-write against a shared
counter to be correct when two agents hit the same ceiling in the same
millisecond, so caps live in a Redis Lua script that checks all three ceilings
and increments all three, or increments none.

OPA answers the question it is good at: *is this agent allowed to do this kind of
thing at all* — a pure function of the request and the policy.

This split is the main design decision in the project. Putting caps in Rego would
demo fine and be wrong under load.

### Reservations are reversible

If the layer authorises and the agent's own downstream write then fails,
`POST /authorize/release` returns the budget. Without it, every downstream
failure strands money until midnight and the fleet slowly starves.

---

## Policy is data, not code

Operators write YAML. It compiles to a decision table that is uploaded to OPA as
`data.governance.config`. The Rego rules never change; the data does.

So a policy change is a data push — no restart, no dropped in-flight request.

```yaml
agents:
  - id: agent_dispute_001
    type: dispute_resolver
    max_single_transaction: 1000000       # $10,000
    max_daily_spend: 20000000             # $200,000
    requires_dual_control_above: 750000   # above $7,500 a human decides
    allowed_actions: [approve_claim, escalate]
    allowed_categories: [all]

type_daily_caps:
  dispute_resolver: 25000000              # ceiling above the individual agents
```

All values are cents.

Deploy is gated behind a check that reports which grants widen or narrow before
anything takes effect, and the validator refuses things that look fine but are
not — a daily cap lower than the single-transaction cap, duplicate agent ids, an
action that does not exist. A rejected policy leaves the previous one serving,
which is asserted in the tests.

### Two engines, held to one contract

Rego runs in a full deployment; an equivalent Python evaluator runs when no
sidecar is reachable. Two implementations of one rule set will drift, and if they
drift the same request gets different answers depending on deployment mode with
nothing in the audit log looking wrong.

`tests/test_parity.py` generates a matrix that lands on both sides of every rule
boundary and asserts the two engines agree — not just on permit/deny, but on
which rule they cite, because that string goes in the audit record.

```
57 cases across 5 agents, all 8 rules exercised
permit 16 · single_transaction_cap 10 · amount_positive 10 · dual_control 6
action_scope 5 · known_action 5 · category_scope 4 · unregistered_agent 1
```

---

## Runs three ways

Every dependency is optional and probed at startup. The mode is reported on
`/health` and shown in the UI, because a demo that runs on in-process state while
implying Postgres is a demo that lies.

| Mode | Command | Policy | Ledger | Counters |
|---|---|---|---|---|
| standalone | `uvicorn app.main:app` | embedded | memory | memory |
| partial | set any subset of the env vars | either | either | either |
| full | `docker compose up` | OPA sidecar | Postgres | Redis |

If OPA is reachable but will not accept the rule module, the service says so
instead of quietly degrading. That failure mode was found during development and
the silent `except` that hid it was the actual bug.

---

## Running it

### Standalone, no infrastructure

```bash
cd backend
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

```bash
cd web
npm install
npm run dev
```

Open http://localhost:3000. The API seeds a plausible trailing few hours of
decisions on boot, so nothing is empty on first load. `SEED_DEMO_DATA=0` turns
that off.

### Full stack

```bash
docker compose up --build
```

- dashboard http://localhost:3000
- api http://localhost:8000/docs
- opa http://localhost:8181

### Mock agents

Three agent services that demonstrate the integration contract — ask first, act
only on approval, hand back the budget on a downstream failure.

```bash
cd backend
AGENT_ID=agent_fee_reversal_001 PORT=9001 python -m agents.agent_service
curl -X POST localhost:9001/handle -H 'Content-Type: application/json' \
     -d '{"amount": 45000, "category": "late_fee"}'
```

### Tests

```bash
cd backend
pip install -r requirements-dev.txt
pytest -q                                  # 26 pass, parity skipped
OPA_BIN=$(which opa) pytest -q             # + 3 parity tests against real OPA
```

---

## The console

Four sections in a left rail, with the fleet budget pinned so the number that
outranks everything else never scrolls away. The rail also reports which backing
services are live, because a console that runs on in-process state while implying
Postgres is a console that lies.

**Agent Status** — four KPI cards chosen because each prompts a different action:
fleet spend against ceiling, approval rate, decision latency, and agents at risk.
Then latency percentiles over the trailing window, a decision-split donut with a
breakdown of *why* requests were refused, spend against cap per agent, a live
feed of recent decisions, and a card per agent.

**Policy Editor** — the YAML with a check-then-deploy gate. Deploy stays locked
until the check passes and shows a diff of which grants widen or narrow, because
a cap change is a change to how much money an agent can move.

**Audit Logs** — every decision, refusals included. Sortable columns, filters on
type, outcome and date range, free-text search across agent id, trace id, reason
and category, adjustable page size, and CSV export of the filtered set. Any row
opens the full request, response, deciding rule and latency.

**Emergency Controls** — fleet halt, reinstate, budget reset, and per-agent hold.
Plus a traffic generator that drives sample work through the *real* `/authorize`
path, so the latency and refusal figures on the console are measured rather than
staged.

### Two UI decisions worth explaining

**Destructive actions are press-and-hold, not click.** The usual answer is a
modal confirm, and it stops working within about a week: operators learn to clear
dialogs without reading them, so the guard protects nothing. A hold cannot be
dismissed by muscle memory and stays cancellable to the last moment — letting go
aborts. The buttons look ordinary until pressed, so it costs nothing visually.
Keyboard has parity. Pass `holdMs={0}` to any `HoldButton` to make it a plain
click.

**Warning and error are derived, not stored.** The backend stores only `active`
or `revoked`, because those are the two states that change what the layer *does*.
The console computes `warning` at 80% of cap and `error` when an agent is refused
more often than not over a meaningful sample, so it can draw attention without
inventing a stored field that nothing enforces. Thresholds live in one place in
`lib/format.ts`.

### Charts are hand-drawn SVG

No charting library. Three areas, a threshold rule and a donut do not justify
~90KB, and hand-drawn plots inherit the console's exact tokens, which a generic
chart theme never quite does. Total first-load JS is 107KB.

Latency percentiles are computed **per bucket** rather than reusing the global
ones. A chart that draws the same overall p95 across every bucket looks like three
real series and is actually one. Where a bucket is thin the higher percentiles
collapse onto the median, which is the honest picture.

## Measured behaviour

From the runs in development, standalone mode on one laptop core:

| | |
|---|---|
| embedded policy decision | 0.02 – 0.06 ms |
| OPA sidecar decision | 1.8 – 3.5 ms (HTTP round trip) |
| end-to-end authorise, seeded load | avg 5.5 ms, p95 9.1 ms, p99 9.4 ms |
| self-imposed budget | 10 ms, drawn on the latency plot |

The concurrency guarantee, asserted in
`test_concurrent_requests_cannot_oversubscribe_a_cap`: 50 simultaneous requests
of $1,500 against a $30,000 daily cap produce **exactly 20** approvals and the
counter lands on the cap, not above it. A read-check-write implementation lets
more through, which is how a fleet exceeds a budget while every individual
decision looks correct in the log.

---

## API

| | |
|---|---|
| `POST /authorize` | the decision. 200 permitted, 403 refused, both recorded |
| `POST /authorize/release` | return a reservation after a downstream failure |
| `GET /agents` | registry with live spend and per-agent health |
| `POST /agents/{id}/revoke` · `/reinstate` · `/reset-budget` | single-agent control |
| `GET /policies` · `POST /policies/validate` · `/update` | read, dry-run, deploy |
| `GET /logs` · `/logs/{trace_id}` | the ledger, filtered or by trace |
| `GET /metrics` | counts, latency percentiles, refusal breakdown, runtime mode |
| `GET /control-log` | operator actions, attributed |
| `POST /emergency/halt-fleet` · `/reinstate-fleet` · `/reset-budgets` | fleet control |
| `GET /stream` | server-sent events, decisions and control actions |

Interactive docs at `/docs`.

---

## Immutability

The ledger is append-only, and that is enforced in three places rather than
trusted to one:

- no update or delete method exists on the store — asserted by a test that
  inspects the interface
- a Postgres trigger refuses `UPDATE` and `DELETE` on both log tables
- a `decision_audit` view gives auditors read access without write access

Corrections go in as new rows. There is deliberately no foreign key from
`action_log` to `agents`, because a decision about an agent that is *not* in the
registry is the single most interesting event to keep, and an FK would refuse to
record it.

---

## Layout

```
backend/
  app/core/      config, policy engine, counters, store, events, seeding
  app/routers/   authorize (the hot path), control (everything operator-facing)
  policies/      governance.rego, policy.yaml
  agents/        mock agent microservice
  tests/         26 behaviour tests + 3 parity tests
web/
  app/           layout, page
  components/    sidebar, charts, KPI and table primitives, hold button, trace drawer
  components/sections/  agent status, policy editor, audit logs, emergency
  lib/           api client, types, formatting, live-data hook
db/001_schema.sql
docker-compose.yml
```

---

## Known limits

Honest list, since these are the first questions worth asking.

- **No authentication.** Operator identity is a constant. Real deployment needs
  SSO and role separation — an analyst should not hold the fleet stop.
- **Dual control refuses rather than queues.** It routes above-threshold requests
  to a human by denying them; there is no approval inbox yet.
- **Single control-plane instance.** Redis makes the counters correct across
  replicas, but revocation state is in process memory, so a second instance would
  need it moved to Redis or Postgres.
- **The ledger is bounded in memory** at 20,000 rows in standalone mode. Postgres
  mode has no such limit.
- **`SEED_DECISIONS` is a ceiling, not a target.** Backfill stops generating for
  an agent once it reaches its target spend, so the actual row count comes in
  lower.
- **Idempotency keys are accepted but not yet enforced**, so a retried request is
  a second decision.
