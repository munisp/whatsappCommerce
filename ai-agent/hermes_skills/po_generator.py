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
WA_TOKEN = os.getenv("WA_TOKEN", os.getenv("META_WA_TOKEN", ""))
WA_PHONE_NUMBER_ID = os.getenv("WA_PHONE_NUMBER_ID", "")


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

        # Notify merchant via WhatsApp with PO summary and approval instructions
        if merchant_phone:
            await _notify_merchant_wa(po, merchant_phone)

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



async def _notify_merchant_wa(po: PurchaseOrderDraft, merchant_phone: str) -> None:
    """Send a WhatsApp notification to the merchant when a PO draft is created."""
    if not WA_TOKEN or not WA_PHONE_NUMBER_ID:
        logger.debug("WA_TOKEN or WA_PHONE_NUMBER_ID not set — skipping merchant WA notification")
        return
    po_suffix = po.po_id.upper().replace("-", "")[-8:]
    line = po.line_items[0] if po.line_items else None
    product_name = line.product_name if line else "N/A"
    sku = line.sku if line else "N/A"
    quantity = line.quantity if line else 0
    currency = po.currency
    total = po.total_cost
    msg = (
        f"📦 *New Purchase Order Ready for Approval*\n\n"
        f"*PO-{po_suffix}* — {product_name} (SKU: {sku})\n"
        f"Quantity: {quantity} units\n"
        f"Total: {currency} {total:,.2f}\n"
        f"Supplier: {po.supplier_name}\n\n"
        f"Reply *APPROVE PO-{po_suffix}* to confirm and send supplier email.\n"
        f"Reply *REJECT PO-{po_suffix}* to cancel this order."
    )
    normalized = merchant_phone if merchant_phone.startswith("+") else f"+{merchant_phone}"
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(
                f"https://graph.facebook.com/v19.0/{WA_PHONE_NUMBER_ID}/messages",
                headers={"Authorization": f"Bearer {WA_TOKEN}", "Content-Type": "application/json"},
                json={
                    "messaging_product": "whatsapp",
                    "to": normalized,
                    "type": "text",
                    "text": {"body": msg},
                },
            )
            if resp.status_code not in (200, 201):
                logger.warning("WA notify failed: %s %s", resp.status_code, resp.text[:200])
            else:
                logger.info("WA PO notification sent to %s for PO-%s", merchant_phone, po_suffix)
    except Exception as exc:
        logger.warning("WA notify exception: %s", exc)


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
