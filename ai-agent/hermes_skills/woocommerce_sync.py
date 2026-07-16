"""
WooCommerce Sync Skill

Bidirectional inventory sync between this platform and a merchant's WooCommerce store.
Triggered by inventory.low_stock, order.placed, and sync_request events.
Uses the WooCommerce REST API v3.
"""
from __future__ import annotations

import logging
import os
import time
from typing import Any

import httpx

from .models import SkillRequest, SkillResult

logger = logging.getLogger(__name__)

WC_API_URL = os.getenv("WOOCOMMERCE_API_URL", "")        # e.g. https://mystore.com/wp-json/wc/v3
WC_CONSUMER_KEY = os.getenv("WOOCOMMERCE_CONSUMER_KEY", "")
WC_CONSUMER_SECRET = os.getenv("WOOCOMMERCE_CONSUMER_SECRET", "")
PLATFORM_API_URL = os.getenv("PLATFORM_API_URL", "http://localhost:3000")
PLATFORM_API_KEY = os.getenv("PLATFORM_API_KEY", "")


async def sync_inventory(request: SkillRequest) -> SkillResult:
    """Sync inventory levels between this platform and WooCommerce."""
    start = time.monotonic()
    event_id = request.event_id

    if not WC_API_URL or not WC_CONSUMER_KEY:
        return SkillResult(
            event_id=event_id,
            skill_name="woocommerce_sync",
            success=True,
            action_type="no_action",
            payload={"reason": "woocommerce_not_configured"},
            duration_ms=(time.monotonic() - start) * 1000,
        )

    try:
        payload = request.payload
        sku = payload.get("sku", "")
        new_stock = payload.get("new_stock", payload.get("current_stock", 0))
        tenant_id = request.tenant_id

        if not sku:
            return SkillResult(
                event_id=event_id,
                skill_name="woocommerce_sync",
                success=False,
                action_type="no_action",
                error="sku not provided in payload",
                duration_ms=(time.monotonic() - start) * 1000,
            )

        # Find the WooCommerce product by SKU
        wc_product = await _find_wc_product_by_sku(sku)
        if not wc_product:
            logger.warning("woocommerce product not found for sku=%s", sku)
            return SkillResult(
                event_id=event_id,
                skill_name="woocommerce_sync",
                success=True,
                action_type="no_action",
                payload={"reason": "product_not_found_in_woocommerce", "sku": sku},
                duration_ms=(time.monotonic() - start) * 1000,
            )

        wc_product_id = wc_product["id"]
        old_stock = wc_product.get("stock_quantity", 0)

        # Update WooCommerce stock
        await _update_wc_stock(wc_product_id, new_stock)

        duration_ms = (time.monotonic() - start) * 1000
        logger.info(
            "woocommerce_sync_complete",
            extra={
                "event_id": event_id,
                "sku": sku,
                "wc_product_id": wc_product_id,
                "old_stock": old_stock,
                "new_stock": new_stock,
                "tenant_id": tenant_id,
            },
        )

        return SkillResult(
            event_id=event_id,
            skill_name="woocommerce_sync",
            success=True,
            action_type="sync_complete",
            payload={
                "sku": sku,
                "wc_product_id": wc_product_id,
                "old_stock": old_stock,
                "new_stock": new_stock,
            },
            duration_ms=duration_ms,
        )

    except Exception as exc:
        logger.exception("woocommerce_sync failed", extra={"event_id": event_id})
        return SkillResult(
            event_id=event_id,
            skill_name="woocommerce_sync",
            success=False,
            action_type="no_action",
            error=str(exc),
            duration_ms=(time.monotonic() - start) * 1000,
        )


async def _find_wc_product_by_sku(sku: str) -> dict[str, Any] | None:
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.get(
            f"{WC_API_URL}/products",
            params={"sku": sku, "per_page": 1},
            auth=(WC_CONSUMER_KEY, WC_CONSUMER_SECRET),
        )
        resp.raise_for_status()
        products = resp.json()
        return products[0] if products else None


async def _update_wc_stock(product_id: int, stock_quantity: int) -> None:
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.put(
            f"{WC_API_URL}/products/{product_id}",
            auth=(WC_CONSUMER_KEY, WC_CONSUMER_SECRET),
            json={"stock_quantity": stock_quantity, "manage_stock": True},
        )
        resp.raise_for_status()
