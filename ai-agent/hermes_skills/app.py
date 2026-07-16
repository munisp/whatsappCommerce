"""
Hermes Skills FastAPI Application

Exposes a /skills/process endpoint that the Rust hermes-router calls.
Routes events to the appropriate Python skill based on event_type.
"""
from __future__ import annotations

import logging
import os
import time
from contextlib import asynccontextmanager
from typing import Any

import uvicorn
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, PlainTextResponse

from .models import SkillRequest, SkillResult
from .po_generator import generate_po
from .supplier_email import send_supplier_email
from .woocommerce_sync import sync_inventory

logging.basicConfig(
    level=logging.INFO,
    format='{"time":"%(asctime)s","level":"%(levelname)s","name":"%(name)s","message":"%(message)s"}',
)
logger = logging.getLogger(__name__)

# ─── Skill Registry ───────────────────────────────────────────────────────────

# Maps event_type → list of skill coroutines to execute (in order)
SKILL_REGISTRY: dict[str, list] = {
    "inventory.low_stock": [generate_po, sync_inventory],
    "inventory.out_of_stock": [generate_po, sync_inventory],
    "supplier.delivery_delay": [generate_po],
    "po.approved": [send_supplier_email],
}

# ─── Metrics ─────────────────────────────────────────────────────────────────

_metrics: dict[str, int] = {
    "requests_total": 0,
    "requests_success": 0,
    "requests_failed": 0,
    "skills_executed": 0,
}

# ─── App ─────────────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("hermes-skills starting on port %s", os.getenv("PORT", "8097"))
    yield
    logger.info("hermes-skills shutting down")


app = FastAPI(
    title="Hermes Skills Executor",
    description="Python AI skill runner for the Hermes Agent integration",
    version="1.0.0",
    lifespan=lifespan,
)


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "service": "hermes-skills",
        "skills_registered": list(SKILL_REGISTRY.keys()),
        "metrics": _metrics,
    }


@app.get("/metrics", response_class=PlainTextResponse)
async def metrics():
    lines = []
    for key, value in _metrics.items():
        lines.append(f"hermes_skills_{key} {value}")
    return "\n".join(lines)


@app.post("/skills/process", response_model=list[SkillResult])
async def process_event(request: SkillRequest):
    """
    Process a platform event through all registered skills for its event_type.
    Returns a list of SkillResult objects (one per skill executed).
    """
    _metrics["requests_total"] += 1
    start = time.monotonic()

    skills = SKILL_REGISTRY.get(request.event_type, [])
    if not skills:
        logger.info("no skills registered for event_type=%s", request.event_type)
        return []

    results: list[SkillResult] = []
    for skill_fn in skills:
        try:
            result = await skill_fn(request)
            results.append(result)
            _metrics["skills_executed"] += 1
            if not result.success:
                _metrics["requests_failed"] += 1
        except Exception as exc:
            logger.exception("skill %s raised uncaught exception", skill_fn.__name__)
            results.append(
                SkillResult(
                    event_id=request.event_id,
                    skill_name=skill_fn.__name__,
                    success=False,
                    action_type="no_action",
                    error=str(exc),
                )
            )
            _metrics["requests_failed"] += 1

    _metrics["requests_success"] += 1
    logger.info(
        "skills_processed",
        extra={
            "event_id": request.event_id,
            "event_type": request.event_type,
            "skills_run": len(results),
            "duration_ms": (time.monotonic() - start) * 1000,
        },
    )
    return results


@app.post("/skills/po-approved")
async def po_approved(body: dict[str, Any]):
    """
    Called by the platform when a merchant approves a PO via WhatsApp.
    Triggers the supplier_email skill.
    """
    request = SkillRequest(
        event_id=body.get("po_id", "unknown"),
        tenant_id=body.get("tenant_id", "unknown"),
        event_type="po.approved",
        occurred_at=body.get("approved_at", ""),
        payload=body,
    )
    result = await send_supplier_email(request)
    return result.model_dump()


if __name__ == "__main__":
    uvicorn.run(
        "hermes_skills.app:app",
        host="0.0.0.0",
        port=int(os.getenv("PORT", "8097")),
        reload=False,
        log_level="info",
    )
