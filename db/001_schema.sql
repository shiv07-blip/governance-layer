-- Governance layer schema.
--
-- The ledger's immutability is enforced here rather than trusted to the
-- application. A rule that only lives in Python is a rule that a future
-- migration script, an ops one-liner, or a second service can quietly break.

CREATE TABLE IF NOT EXISTS agents (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    type        TEXT NOT NULL CHECK (type IN ('fee_reversal', 'dispute_resolver', 'claim_processor')),
    status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
    daily_cap   BIGINT NOT NULL CHECK (daily_cap > 0),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at  TIMESTAMPTZ,
    revoked_by  TEXT,
    -- A revoked row must say who revoked it and when. Anonymous revocations are
    -- useless in an incident review.
    CONSTRAINT revocation_is_attributed CHECK (
        (status = 'revoked' AND revoked_at IS NOT NULL AND revoked_by IS NOT NULL)
        OR (status <> 'revoked' AND revoked_at IS NULL)
    )
);

-- Every authorisation decision, permitted and refused alike.
CREATE TABLE IF NOT EXISTS action_log (
    id            BIGSERIAL PRIMARY KEY,
    trace_id      UUID NOT NULL UNIQUE,
    ts            TIMESTAMPTZ NOT NULL DEFAULT now(),
    agent_id      TEXT NOT NULL,
    agent_type    TEXT NOT NULL,
    action        TEXT NOT NULL,
    amount        BIGINT NOT NULL,
    category      TEXT NOT NULL,
    decision      TEXT NOT NULL CHECK (decision IN ('APPROVED', 'DENIED')),
    reason        TEXT NOT NULL,
    rule          TEXT NOT NULL,
    engine        TEXT NOT NULL,
    latency_ms    DOUBLE PRECISION NOT NULL,
    request_json  JSONB NOT NULL,
    response_json JSONB NOT NULL
    -- Deliberately no foreign key to agents(id): a decision about an agent that
    -- is not in the registry is exactly the event most worth keeping, and an FK
    -- would refuse to record it.
);

-- Operator actions. Same immutability, separate table so a query for "what did
-- people do" never has to be filtered out of "what did agents do".
CREATE TABLE IF NOT EXISTS control_log (
    id      UUID PRIMARY KEY,
    ts      TIMESTAMPTZ NOT NULL DEFAULT now(),
    actor   TEXT NOT NULL,
    action  TEXT NOT NULL,
    target  TEXT NOT NULL,
    detail  TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS policies (
    id          BIGSERIAL PRIMARY KEY,
    version     INTEGER NOT NULL,
    yaml_content TEXT NOT NULL,
    deployed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deployed_by TEXT NOT NULL
);

-- Indexes follow the queries the ledger view actually issues: newest first,
-- filtered by agent, type or outcome.
CREATE INDEX IF NOT EXISTS action_log_ts_desc    ON action_log (ts DESC);
CREATE INDEX IF NOT EXISTS action_log_agent      ON action_log (agent_id, ts DESC);
CREATE INDEX IF NOT EXISTS action_log_decision   ON action_log (decision, ts DESC);
CREATE INDEX IF NOT EXISTS action_log_type       ON action_log (agent_type, ts DESC);
CREATE INDEX IF NOT EXISTS action_log_rule       ON action_log (rule);
CREATE INDEX IF NOT EXISTS control_log_ts_desc   ON control_log (ts DESC);

-- ---------------------------------------------------------------------------
-- Append-only enforcement.
--
-- Revoking UPDATE and DELETE from the application role is the first line, but a
-- trigger is the one that survives a role being granted more than it should be.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION refuse_mutation() RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION
        'action_log and control_log are append-only; % on % was refused. Record a correcting row instead.',
        TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS action_log_no_update ON action_log;
CREATE TRIGGER action_log_no_update
    BEFORE UPDATE OR DELETE ON action_log
    FOR EACH ROW EXECUTE FUNCTION refuse_mutation();

DROP TRIGGER IF EXISTS control_log_no_update ON control_log;
CREATE TRIGGER control_log_no_update
    BEFORE UPDATE OR DELETE ON control_log
    FOR EACH ROW EXECUTE FUNCTION refuse_mutation();

-- A read-only view for auditors, who should never need write access at all.
CREATE OR REPLACE VIEW decision_audit AS
SELECT ts, trace_id, agent_id, agent_type, action, category,
       amount::numeric / 100 AS amount_usd,
       decision, rule, reason, engine, latency_ms
FROM action_log
ORDER BY ts DESC;
