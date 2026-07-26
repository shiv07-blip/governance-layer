"""Spend counters.

The interesting problem here is not "add up some numbers". It is that two
agents can hit the same cap in the same millisecond, and a naive
read-check-write lets both through. That is exactly how a fleet blows past a
budget while every individual decision looks correct in the log.

So the reserve step is atomic:

  Redis path   one Lua script checks the per-agent cap, the per-type cap and
               the fleet cap, then increments all three, or increments none.
  Memory path  the same logic under a single asyncio lock.

Reservations are also reversible. If a downstream ledger call fails after we
authorised, `release` gives the budget back rather than leaking it until
midnight.
"""

import asyncio
import time
from typing import Optional

from .config import runtime, settings

# KEYS: agent_key, type_key, fleet_key
# ARGV: amount, agent_cap, type_cap, fleet_cap, ttl_seconds
RESERVE_LUA = """
local amount    = tonumber(ARGV[1])
local agent_cap = tonumber(ARGV[2])
local type_cap  = tonumber(ARGV[3])
local fleet_cap = tonumber(ARGV[4])
local ttl       = tonumber(ARGV[5])

local agent = tonumber(redis.call('GET', KEYS[1]) or '0')
local typ   = tonumber(redis.call('GET', KEYS[2]) or '0')
local fleet = tonumber(redis.call('GET', KEYS[3]) or '0')

if agent + amount > agent_cap then
  return {0, 'agent', agent, agent_cap}
end
if typ + amount > type_cap then
  return {0, 'type', typ, type_cap}
end
if fleet + amount > fleet_cap then
  return {0, 'fleet', fleet, fleet_cap}
end

redis.call('INCRBY', KEYS[1], amount); redis.call('EXPIRE', KEYS[1], ttl)
redis.call('INCRBY', KEYS[2], amount); redis.call('EXPIRE', KEYS[2], ttl)
redis.call('INCRBY', KEYS[3], amount); redis.call('EXPIRE', KEYS[3], ttl)
return {1, 'ok', agent + amount, agent_cap}
"""


class Reservation:
    __slots__ = ("ok", "scope", "used", "cap")

    def __init__(self, ok: bool, scope: str, used: int, cap: int):
        self.ok = ok
        self.scope = scope  # which ceiling refused: agent | type | fleet | ok
        self.used = used
        self.cap = cap

    def reason(self) -> str:
        if self.ok:
            return "within budget"
        label = {
            "agent": "Agent daily cap",
            "type": "Agent-type daily cap",
            "fleet": "Fleet daily cap",
        }[self.scope]
        return (
            f"{label} would be breached "
            f"(used ${self.used / 100:,.2f} of ${self.cap / 100:,.2f})"
        )


def _seconds_to_midnight() -> int:
    now = time.time()
    return int(86400 - (now % 86400)) or 86400


class CounterStore:
    """Reserve-and-release spend accounting with a hard atomicity guarantee."""

    def __init__(self) -> None:
        self._redis = None
        self._script = None
        self._mem: dict[str, int] = {}
        self._lock = asyncio.Lock()

    async def connect(self) -> None:
        if not settings.redis_url:
            return
        try:
            import redis.asyncio as aioredis

            client = aioredis.from_url(settings.redis_url, decode_responses=True)
            await client.ping()
            self._redis = client
            self._script = client.register_script(RESERVE_LUA)
            runtime.redis = True
        except Exception:
            self._redis = None
            runtime.redis = False

    async def close(self) -> None:
        if self._redis is not None:
            await self._redis.close()

    @staticmethod
    def _keys(agent_id: str, agent_type: str) -> tuple[str, str, str]:
        return (
            f"spend:agent:{agent_id}",
            f"spend:type:{agent_type}",
            "spend:fleet:total",
        )

    async def reserve(
        self,
        agent_id: str,
        agent_type: str,
        amount: int,
        agent_cap: int,
        type_cap: int,
        fleet_cap: Optional[int] = None,
    ) -> Reservation:
        fleet_cap = settings.fleet_daily_cap if fleet_cap is None else fleet_cap
        ak, tk, fk = self._keys(agent_id, agent_type)

        if self._redis is not None and self._script is not None:
            raw = await self._script(
                keys=[ak, tk, fk],
                args=[amount, agent_cap, type_cap, fleet_cap, _seconds_to_midnight()],
            )
            return Reservation(bool(int(raw[0])), str(raw[1]), int(raw[2]), int(raw[3]))

        async with self._lock:
            a, t, f = self._mem.get(ak, 0), self._mem.get(tk, 0), self._mem.get(fk, 0)
            if a + amount > agent_cap:
                return Reservation(False, "agent", a, agent_cap)
            if t + amount > type_cap:
                return Reservation(False, "type", t, type_cap)
            if f + amount > fleet_cap:
                return Reservation(False, "fleet", f, fleet_cap)
            self._mem[ak] = a + amount
            self._mem[tk] = t + amount
            self._mem[fk] = f + amount
            return Reservation(True, "ok", a + amount, agent_cap)

    async def release(self, agent_id: str, agent_type: str, amount: int) -> None:
        """Hand budget back after a downstream failure."""
        ak, tk, fk = self._keys(agent_id, agent_type)
        if self._redis is not None:
            pipe = self._redis.pipeline()
            for key in (ak, tk, fk):
                pipe.incrby(key, -amount)
            await pipe.execute()
            return
        async with self._lock:
            for key in (ak, tk, fk):
                self._mem[key] = max(0, self._mem.get(key, 0) - amount)

    async def get(self, agent_id: str) -> int:
        key = f"spend:agent:{agent_id}"
        if self._redis is not None:
            return int(await self._redis.get(key) or 0)
        return self._mem.get(key, 0)

    async def fleet_total(self) -> int:
        if self._redis is not None:
            return int(await self._redis.get("spend:fleet:total") or 0)
        return self._mem.get("spend:fleet:total", 0)

    async def reset_agent(self, agent_id: str) -> None:
        key = f"spend:agent:{agent_id}"
        current = await self.get(agent_id)
        if self._redis is not None:
            pipe = self._redis.pipeline()
            pipe.set(key, 0)
            pipe.incrby("spend:fleet:total", -current)
            await pipe.execute()
            return
        async with self._lock:
            self._mem[key] = 0
            self._mem["spend:fleet:total"] = max(
                0, self._mem.get("spend:fleet:total", 0) - current
            )

    async def reset_all(self) -> None:
        if self._redis is not None:
            keys = [k async for k in self._redis.scan_iter("spend:*")]
            if keys:
                await self._redis.delete(*keys)
            return
        async with self._lock:
            self._mem.clear()

    async def seed(self, agent_id: str, agent_type: str, amount: int) -> None:
        """Preload demo spend so the dashboard has something to show on boot."""
        ak, tk, fk = self._keys(agent_id, agent_type)
        if self._redis is not None:
            pipe = self._redis.pipeline()
            for key in (ak, tk, fk):
                pipe.incrby(key, amount)
            await pipe.execute()
            return
        async with self._lock:
            for key in (ak, tk, fk):
                self._mem[key] = self._mem.get(key, 0) + amount


counters = CounterStore()
