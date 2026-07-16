"""
permify_client.py — Permify fine-grained authorization client for Python services

Wraps the Permify REST API for:
  - Permission checks (can user X do action Y on resource Z?)
  - Relationship writes (grant/revoke)
  - Bulk permission lookups

Falls back to allow-all when PERMIFY_URL is not set (dev mode).
"""
from __future__ import annotations

import logging
import os
import time
from typing import Any

import requests

logger = logging.getLogger(__name__)

PERMIFY_URL = os.getenv("PERMIFY_URL", "")
PERMIFY_TENANT_ID = os.getenv("PERMIFY_TENANT_ID", "t1")
_SESSION = None


def _session() -> requests.Session:
    global _SESSION
    if _SESSION is None:
        _SESSION = requests.Session()
        _SESSION.headers.update({"Content-Type": "application/json"})
    return _SESSION


def _base() -> str:
    return f"{PERMIFY_URL}/v1/tenants/{PERMIFY_TENANT_ID}"


# ─── Permission Check ─────────────────────────────────────────────────────────

def check(
    entity_type: str,
    entity_id: str,
    permission: str,
    subject_type: str,
    subject_id: str,
    subject_relation: str = "",
) -> bool:
    """
    Check if a subject has a permission on an entity.
    Returns True (allowed) when Permify is not configured (dev fallback).
    """
    if not PERMIFY_URL:
        return True  # dev fallback
    payload: dict[str, Any] = {
        "metadata": {"schema_version": "", "snap_token": "", "depth": 20},
        "entity": {"type": entity_type, "id": entity_id},
        "permission": permission,
        "subject": {"type": subject_type, "id": subject_id},
    }
    if subject_relation:
        payload["subject"]["relation"] = subject_relation
    try:
        resp = _session().post(
            f"{_base()}/permissions/check",
            json=payload,
            timeout=3,
        )
        resp.raise_for_status()
        return resp.json().get("can") == "CHECK_RESULT_ALLOWED"
    except Exception as exc:
        logger.warning("[Permify] check failed: %s", exc)
        return True  # fail-open in dev; set PERMIFY_URL to enable enforcement


# ─── Relationship Management ──────────────────────────────────────────────────

def write_relationship(
    entity_type: str,
    entity_id: str,
    relation: str,
    subject_type: str,
    subject_id: str,
    subject_relation: str = "",
) -> bool:
    """Grant a relationship tuple."""
    if not PERMIFY_URL:
        return True
    subject: dict[str, str] = {"type": subject_type, "id": subject_id}
    if subject_relation:
        subject["relation"] = subject_relation
    payload = {
        "metadata": {"schema_version": ""},
        "tuples": [
            {
                "entity": {"type": entity_type, "id": entity_id},
                "relation": relation,
                "subject": subject,
            }
        ],
    }
    try:
        resp = _session().post(f"{_base()}/relationships/write", json=payload, timeout=3)
        resp.raise_for_status()
        return True
    except Exception as exc:
        logger.warning("[Permify] write_relationship failed: %s", exc)
        return False


def delete_relationship(
    entity_type: str,
    entity_id: str,
    relation: str,
    subject_type: str,
    subject_id: str,
) -> bool:
    """Revoke a relationship tuple."""
    if not PERMIFY_URL:
        return True
    payload = {
        "filter": {
            "entity_filter": {"type": entity_type, "ids": [entity_id]},
            "relation": relation,
            "subject_filter": {"type": subject_type, "ids": [subject_id]},
        }
    }
    try:
        resp = _session().post(f"{_base()}/relationships/delete", json=payload, timeout=3)
        resp.raise_for_status()
        return True
    except Exception as exc:
        logger.warning("[Permify] delete_relationship failed: %s", exc)
        return False


# ─── Bulk Checks ──────────────────────────────────────────────────────────────

def check_many(
    checks: list[dict[str, str]],
) -> dict[str, bool]:
    """
    Run multiple permission checks in parallel.
    Each check dict: {entity_type, entity_id, permission, subject_type, subject_id}
    Returns {check_key: allowed} mapping.
    """
    from concurrent.futures import ThreadPoolExecutor, as_completed

    results: dict[str, bool] = {}
    with ThreadPoolExecutor(max_workers=min(len(checks), 10)) as pool:
        futures = {
            pool.submit(
                check,
                c["entity_type"], c["entity_id"], c["permission"],
                c["subject_type"], c["subject_id"],
            ): f"{c['entity_type']}:{c['entity_id']}:{c['permission']}"
            for c in checks
        }
        for future in as_completed(futures):
            key = futures[future]
            try:
                results[key] = future.result()
            except Exception:
                results[key] = True  # fail-open
    return results


# ─── Health Check ─────────────────────────────────────────────────────────────

def health_check() -> dict[str, Any]:
    """Return Permify health status."""
    if not PERMIFY_URL:
        return {"online": False, "error": "not_configured"}
    try:
        t0 = time.monotonic()
        resp = requests.get(f"{PERMIFY_URL}/healthz", timeout=3)
        latency_ms = int((time.monotonic() - t0) * 1000)
        if resp.ok:
            return {"online": True, "latency_ms": latency_ms}
        return {"online": False, "error": f"status {resp.status_code}"}
    except Exception as exc:
        return {"online": False, "error": str(exc)}
