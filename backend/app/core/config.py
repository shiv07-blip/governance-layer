"""Runtime configuration.

The service is designed to run in three modes without code changes:

  standalone  no Postgres, no Redis, no OPA  -> in-process store + embedded evaluator
  partial     Redis and/or Postgres present  -> those are used, OPA still embedded
  full        docker compose up              -> Postgres + Redis + OPA sidecar

Every dependency is probed at startup and recorded in `runtime`. The dashboard
shows which backing services are live, so a demo never silently lies about
where the numbers came from.
"""

import os


def _env(key: str, default: str) -> str:
    return os.getenv(key, default)


class Settings:
    database_url: str = _env("DATABASE_URL", "")
    redis_url: str = _env("REDIS_URL", "")
    opa_url: str = _env("OPA_URL", "")

    # Fleet-wide ceiling, in cents. Enforced on top of every per-agent cap.
    fleet_daily_cap: int = int(_env("FLEET_DAILY_CAP", "50000000"))

    # Reject anything slower than this and page the operator instead of queueing.
    authorize_timeout_ms: int = int(_env("AUTHORIZE_TIMEOUT_MS", "250"))

    policy_path: str = _env(
        "POLICY_PATH",
        os.path.join(os.path.dirname(__file__), "..", "..", "policies", "policy.yaml"),
    )
    rego_path: str = _env(
        "REGO_PATH",
        os.path.join(os.path.dirname(__file__), "..", "..", "policies", "governance.rego"),
    )


settings = Settings()


class Runtime:
    """Which backing services actually answered on boot."""

    postgres = False
    redis = False
    opa = False
    # Set when OPA answers but will not serve decisions, so a partial failure is
    # reported rather than silently degrading to the embedded engine.
    opa_note = ""

    def as_dict(self) -> dict:
        return {
            "postgres": self.postgres,
            "redis": self.redis,
            "opa": self.opa,
            "policy_engine": "opa" if self.opa else "embedded",
            "ledger": "postgres" if self.postgres else "memory",
            "counters": "redis" if self.redis else "memory",
            "opa_note": self.opa_note,
        }


runtime = Runtime()
