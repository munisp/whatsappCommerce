"""
openappsec_config.py — OpenAppSec WAF configuration manager

OpenAppSec is an ML-based WAF/WAAP that can be deployed as a sidecar or
standalone agent. This module manages its configuration via the
OpenAppSec Management API and provides helpers to:
  - Push policy updates (block/detect/prevent modes)
  - Add custom threat intelligence rules
  - Query WAF event logs for security analytics
  - Health check the OpenAppSec agent

Falls back gracefully when OPENAPPSEC_MGMT_URL is not set.
"""
from __future__ import annotations

import logging
import os
import time
from typing import Any

import requests

logger = logging.getLogger(__name__)

OPENAPPSEC_URL = os.getenv("OPENAPPSEC_MGMT_URL", "")
OPENAPPSEC_TOKEN = os.getenv("OPENAPPSEC_TOKEN", "")


def _headers() -> dict[str, str]:
    h = {"Content-Type": "application/json"}
    if OPENAPPSEC_TOKEN:
        h["Authorization"] = f"Bearer {OPENAPPSEC_TOKEN}"
    return h


# ─── Policy Management ────────────────────────────────────────────────────────

WAF_POLICY_TEMPLATE = {
    "name": "wacommerce-policy",
    "mode": "prevent-learn",  # prevent-learn | detect | prevent
    "assets": [
        {
            "name": "wacommerce-api",
            "urls": ["/api/*", "/webhook/*"],
            "practices": ["wacommerce-waf-practice"],
        }
    ],
    "practices": [
        {
            "name": "wacommerce-waf-practice",
            "webAttacks": {
                "minimumConfidence": "medium",
                "maxBodySizeKb": 1024,
                "maxHeaderSizeBytes": 8192,
                "maxUrlSizeBytes": 2048,
            },
            "antiBot": {"injectedUriEnabled": True, "validatedUriEnabled": True},
            "snortSignatures": {"configMap": ""},
            "openSchemaValidation": [
                {"url": "/api/trpc/*", "schema": ""},
            ],
        }
    ],
}


def push_policy(policy: dict[str, Any] | None = None) -> bool:
    """Push a WAF policy to the OpenAppSec management API."""
    if not OPENAPPSEC_URL:
        logger.info("[OpenAppSec] OPENAPPSEC_MGMT_URL not set — WAF config disabled")
        return False
    payload = policy or WAF_POLICY_TEMPLATE
    try:
        resp = requests.put(
            f"{OPENAPPSEC_URL}/api/v1/policies",
            json=payload,
            headers=_headers(),
            timeout=10,
        )
        resp.raise_for_status()
        logger.info("[OpenAppSec] Policy pushed: %s", resp.status_code)
        return True
    except Exception as exc:
        logger.warning("[OpenAppSec] push_policy failed: %s", exc)
        return False


def add_custom_rule(
    rule_name: str,
    pattern: str,
    action: str = "prevent",
    severity: str = "high",
) -> bool:
    """Add a custom threat rule (e.g., block a specific IP range or pattern)."""
    if not OPENAPPSEC_URL:
        return False
    payload = {
        "name": rule_name,
        "pattern": pattern,
        "action": action,
        "severity": severity,
    }
    try:
        resp = requests.post(
            f"{OPENAPPSEC_URL}/api/v1/custom-rules",
            json=payload,
            headers=_headers(),
            timeout=5,
        )
        resp.raise_for_status()
        return True
    except Exception as exc:
        logger.warning("[OpenAppSec] add_custom_rule failed: %s", exc)
        return False


def get_waf_events(limit: int = 100, severity: str | None = None) -> list[dict[str, Any]]:
    """Retrieve recent WAF security events for analytics."""
    if not OPENAPPSEC_URL:
        return []
    params: dict[str, Any] = {"limit": limit}
    if severity:
        params["severity"] = severity
    try:
        resp = requests.get(
            f"{OPENAPPSEC_URL}/api/v1/events",
            params=params,
            headers=_headers(),
            timeout=5,
        )
        resp.raise_for_status()
        return resp.json().get("events", [])
    except Exception as exc:
        logger.warning("[OpenAppSec] get_waf_events failed: %s", exc)
        return []


def set_mode(mode: str) -> bool:
    """
    Set the WAF enforcement mode.
    mode: 'prevent-learn' | 'detect' | 'prevent' | 'inactive'
    """
    if not OPENAPPSEC_URL:
        return False
    valid_modes = {"prevent-learn", "detect", "prevent", "inactive"}
    if mode not in valid_modes:
        raise ValueError(f"Invalid mode: {mode}. Must be one of {valid_modes}")
    try:
        resp = requests.patch(
            f"{OPENAPPSEC_URL}/api/v1/policies/wacommerce-policy",
            json={"mode": mode},
            headers=_headers(),
            timeout=5,
        )
        resp.raise_for_status()
        logger.info("[OpenAppSec] Mode set to: %s", mode)
        return True
    except Exception as exc:
        logger.warning("[OpenAppSec] set_mode failed: %s", exc)
        return False


# ─── Health Check ─────────────────────────────────────────────────────────────

def health_check() -> dict[str, Any]:
    """Return OpenAppSec agent health status."""
    if not OPENAPPSEC_URL:
        return {"online": False, "error": "not_configured"}
    try:
        t0 = time.monotonic()
        resp = requests.get(
            f"{OPENAPPSEC_URL}/api/v1/health",
            headers=_headers(),
            timeout=3,
        )
        latency_ms = int((time.monotonic() - t0) * 1000)
        if resp.ok:
            return {"online": True, "latency_ms": latency_ms, **resp.json()}
        return {"online": False, "error": f"status {resp.status_code}"}
    except Exception as exc:
        return {"online": False, "error": str(exc)}

