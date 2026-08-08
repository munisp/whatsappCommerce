"""Shared-secret authentication for internal service-to-service endpoints (hermes-skills).

Callers must present an ``X-Internal-Token`` header matching the
``INTERNAL_API_KEY`` environment variable.

Failure policy:
  - production (ENV/NODE_ENV=production) with the variable unset:
    fail closed — every protected request is rejected with 503.
  - secret configured: constant-time comparison; mismatch/missing → 401.
  - development with the variable unset: allow with a warning so local
    development stacks keep working.

Dependency-free: stdlib + FastAPI only.
"""
from __future__ import annotations

import hmac
import logging
import os

from fastapi import HTTPException, Request

logger = logging.getLogger(__name__)

INTERNAL_TOKEN_HEADER = "x-internal-token"


def _is_production() -> bool:
    env = os.getenv("ENV") or os.getenv("NODE_ENV") or "development"
    return env.strip().lower() in ("production", "prod")


async def require_internal_token(request: Request) -> None:
    """FastAPI dependency enforcing the X-Internal-Token shared secret."""
    expected = os.getenv("INTERNAL_API_KEY", "")
    if not expected:
        if _is_production():
            logger.error(
                "INTERNAL_API_KEY is not set — rejecting %s %s (fail closed)",
                request.method,
                request.url.path,
            )
            raise HTTPException(
                status_code=503, detail="internal authentication not configured"
            )
        logger.warning(
            "INTERNAL_API_KEY is not set — allowing unauthenticated call to %s (dev mode)",
            request.url.path,
        )
        return
    provided = request.headers.get(INTERNAL_TOKEN_HEADER, "")
    if not provided or not hmac.compare_digest(provided, expected):
        logger.warning("invalid internal token on %s", request.url.path)
        raise HTTPException(status_code=401, detail="invalid internal token")
