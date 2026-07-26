"""Governance layer control plane."""

from __future__ import annotations

import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .core.config import runtime, settings
from .core.counters import counters
from .core.policy import engine
from .core.seed import backfill, register_agents
from .core.store import store
from .routers import authorize, control


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Probe optional dependencies. Each failure degrades one subsystem rather
    # than stopping the service, and the mode is reported on /health.
    await store.connect()
    await counters.connect()
    await engine.connect()

    with open(settings.policy_path, "r", encoding="utf-8") as fh:
        await engine.load(fh.read(), 1, "system")
    await register_agents()

    if os.getenv("SEED_DEMO_DATA", "1") == "1":
        await backfill(int(os.getenv("SEED_DECISIONS", "320")))

    yield

    from .core.seed import simulator

    await simulator.stop()
    await engine.close()
    await counters.close()
    await store.close()


app = FastAPI(
    title="Governance layer",
    description="Permission, budget and revocation controls for autonomous financial agents.",
    version="1.0.0",
    lifespan=lifespan,
)

cors_origins = [
    origin.strip()
    for origin in os.getenv(
        "CORS_ORIGINS",
        "http://localhost:3000",
    ).split(",")
    if origin.strip()
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(authorize.router, tags=["authorization"])
app.include_router(control.router, tags=["control"])

app.include_router(authorize.router, tags=["authorization"])
app.include_router(control.router, tags=["control"])


@app.get("/", tags=["root"])
async def root() -> dict:
    return {
        "status": "ok",
        "message": "Governance layer API is running",
        "health": "/health",
        "docs": "/docs",
    }


@app.get("/health", tags=["health"])
async def health() -> dict:
    return {
        "status": "ok",
        "service": "governance-layer",
    }

