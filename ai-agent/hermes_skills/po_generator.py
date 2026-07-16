"""
Purchase Order Generator Skill

Triggered by inventory.low_stock and inventory.out_of_stock events.
Uses the platform's LLM API to draft a contextual PO, then returns
a PODraftPayload for the Go bridge to send to the merchant via WhatsApp.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import time
import uuid
from typing import Any

import httpx

from .models import POLineItem, PurchaseOrderDraft, SkillRequest, SkillResult

logger = logging.getLogger(__name__)

# Platform LLM API (Manus built-in Forge)
FORGE_API_URL = os.getenv("BUILT_IN_FORGE_API_URL", "http://localhost:3000/api/forge")
FORGE_API_KEY = os.getenv("BUILT_IN_FORGE_API_KEY", "")
PLATFORM_API_URL = os.getenv("PLATFORM_API_URL", "http://localhost:3000")
PLATFORM_API_KEY = os.getenv("PLATFORM_API_KEY", "")


async def generate_po(request: SkillRequest) -> SkillResult:
    """Generate a purchase order draft for a low/out-of-stock event."""
    start = time.monotonic()
    event_id = request.event_id

    try:
        payload = request.payload
        sku = payload.get("sku", "UNKNOWN")
        product_name = payload.get("product_name", "Unknown Product")
        current_stock = payload.get("current_stock", 0)
        reorder_point = payload.get("reorder_point", 10)
        reorder_qty = payload.get("reorder_quantity", max(reorder_point * 3, 30))
        supplier_name = payload.get("supplier_name", "Default Supplier")
        supplier_email = payload.get("supplier_email", "supplier@example.com")
        merchant_phone = payload.get("merchant_phone", "")
        unit_cost = float(payload.get("unit_cost", 0.0))
        currency = payload.get("currency", "NGN")

        # Use LLM to generate a contextual PO note if Forge API is available
        po_notes = await _generate_po_notes(
            product_name=product_name,
            sku=sku,
            current_stock=current_stock,
            reorder_qty=reorder_qty,
            supplier_name=supplier_name,
        )

        # Build the PO
        po_id = str(uuid.uuid4())
        approval_token = hashlib.sha256(f"{po_id}{event_id}".encode()).hexdigest()[:16]
        total_cost = reorder_qty * unit_cost

        po = PurchaseOrderDraft(
            po_id=po_id,
            tenant_id=request.tenant_id,
            supplier_name=supplier_name,
            supplier_email=supplier_email,
            merchant_phone=merchant_phone,
            line_items=[
                POLineItem(
                    sku=sku,
                    product_name=product_name,
                    quantity=reorder_qty,
                    unit_cost=unit_cost,
                    currency=currency,
                )
            ],
            total_cost=total_cost,
            currency=currency,
            approval_token=approval_token,
            notes=po_notes,
        )

        # Persist the draft PO to the platform via internal API
        await _save_po_draft(po)

        duration_ms = (time.monotonic() - start) * 1000
        logger.info(
            "po_generated",
            extra={
                "event_id": event_id,
                "po_id": po_id,
                "sku": sku,
                "quantity": reorder_qty,
                "total_cost": total_cost,
                "duration_ms": duration_ms,
            },
        )

        return SkillResult(
            event_id=event_id,
            skill_name="po_generator",
            success=True,
            action_type="po_draft",
            payload={
                "po_id": po_id,
                "supplier_name": supplier_name,
                "supplier_email": supplier_email,
                "sku": sku,
                "product_name": product_name,
                "quantity": reorder_qty,
                "unit_cost": unit_cost,
                "total_cost": total_cost,
                "currency": currency,
                "merchant_phone": merchant_phone,
                "approval_token": approval_token,
                "notes": po_notes,
            },
            duration_ms=duration_ms,
        )

    except Exception as exc:
        logger.exception("po_generator failed", extra={"event_id": event_id})
        return SkillResult(
            event_id=event_id,
            skill_name="po_generator",
            success=False,
            action_type="no_action",
            error=str(exc),
            duration_ms=(time.monotonic() - start) * 1000,
        )


async def _generate_po_notes(
    product_name: str,
    sku: str,
    current_stock: int,
    reorder_qty: int,
    supplier_name: str,
) -> str:
    """Use the Forge LLM to generate a contextual PO note."""
    if not FORGE_API_KEY:
        return f"Auto-generated reorder for {product_name} (SKU: {sku}). Current stock: {current_stock} units."

    prompt = (
        f"Write a brief, professional purchase order note for a WhatsApp commerce merchant in Africa.\n"
        f"Product: {product_name} (SKU: {sku})\n"
        f"Current stock: {current_stock} units (below reorder point)\n"
        f"Reorder quantity: {reorder_qty} units\n"
        f"Supplier: {supplier_name}\n"
        f"Keep it under 2 sentences. Be direct and professional."
    )

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(
                f"{FORGE_API_URL}/v1/chat/completions",
                headers={"Authorization": f"Bearer {FORGE_API_KEY}"},
                json={
                    "model": "claude-3-5-haiku",
                    "messages": [{"role": "user", "content": prompt}],
                    "max_tokens": 100,
                },
            )
            if resp.status_code == 200:
                data = resp.json()
                return data["choices"][0]["message"]["content"].strip()
    except Exception:
        pass  # Fall back to default note

    return f"Auto-generated reorder for {product_name} (SKU: {sku}). Current stock: {current_stock} units."


async def _save_po_draft(po: PurchaseOrderDraft) -> None:
    """Persist the PO draft to the platform via internal API."""
    if not PLATFORM_API_URL:
        return
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            await client.post(
                f"{PLATFORM_API_URL}/api/hermes/po-draft",
                headers={"X-Internal-Key": PLATFORM_API_KEY},
                json=po.model_dump(),
            )
    except Exception as exc:
        logger.warning("failed to save po draft to platform: %s", exc)
