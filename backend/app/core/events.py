"""A tiny fan-out bus so the dashboard can stream decisions instead of polling.

Each connected operator gets a bounded queue. If a client stalls, its queue
fills and the oldest events are dropped for that client only — a slow browser
must never apply back-pressure to the authorisation path.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

QUEUE_DEPTH = 200


class EventBus:
    def __init__(self) -> None:
        self._subscribers: set[asyncio.Queue[str]] = set()

    def subscribe(self) -> asyncio.Queue[str]:
        queue: asyncio.Queue[str] = asyncio.Queue(maxsize=QUEUE_DEPTH)
        self._subscribers.add(queue)
        return queue

    def unsubscribe(self, queue: asyncio.Queue[str]) -> None:
        self._subscribers.discard(queue)

    @property
    def listeners(self) -> int:
        return len(self._subscribers)

    def publish(self, kind: str, payload: Any) -> None:
        if not self._subscribers:
            return
        frame = json.dumps({"kind": kind, "payload": payload}, default=str)
        for queue in list(self._subscribers):
            try:
                queue.put_nowait(frame)
            except asyncio.QueueFull:
                try:
                    queue.get_nowait()
                    queue.put_nowait(frame)
                except Exception:
                    pass


bus = EventBus()
