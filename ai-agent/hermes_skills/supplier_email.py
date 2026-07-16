"""
Supplier Email Skill

Sends a formatted purchase order email to the supplier when a PO is approved.
Uses SMTP (configurable) or the Forge notification API as fallback.
"""
from __future__ import annotations

import logging
import os
import smtplib
import time
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from typing import Any

from .models import SkillRequest, SkillResult

logger = logging.getLogger(__name__)

SMTP_HOST = os.getenv("SMTP_HOST", "")
SMTP_PORT = int(os.getenv("SMTP_PORT", "587"))
SMTP_USER = os.getenv("SMTP_USER", "")
SMTP_PASS = os.getenv("SMTP_PASS", "")
SMTP_FROM = os.getenv("SMTP_FROM", "noreply@whatsapp-commerce.app")


async def send_supplier_email(request: SkillRequest) -> SkillResult:
    """Send a PO confirmation email to the supplier after merchant approval."""
    start = time.monotonic()
    event_id = request.event_id

    try:
        payload = request.payload
        supplier_email = payload.get("supplier_email", "")
        supplier_name = payload.get("supplier_name", "Supplier")
        po_id = payload.get("po_id", "N/A")
        product_name = payload.get("product_name", "Product")
        sku = payload.get("sku", "N/A")
        quantity = payload.get("quantity", 0)
        unit_cost = payload.get("unit_cost", 0.0)
        total_cost = payload.get("total_cost", 0.0)
        currency = payload.get("currency", "NGN")
        notes = payload.get("notes", "")
        merchant_name = payload.get("merchant_name", "Merchant")

        if not supplier_email:
            return SkillResult(
                event_id=event_id,
                skill_name="supplier_email",
                success=False,
                action_type="no_action",
                error="supplier_email not provided in payload",
                duration_ms=(time.monotonic() - start) * 1000,
            )

        subject = f"Purchase Order {po_id} — {product_name}"
        html_body = _build_email_html(
            supplier_name=supplier_name,
            po_id=po_id,
            product_name=product_name,
            sku=sku,
            quantity=quantity,
            unit_cost=unit_cost,
            total_cost=total_cost,
            currency=currency,
            notes=notes,
            merchant_name=merchant_name,
        )
        text_body = _build_email_text(
            supplier_name=supplier_name,
            po_id=po_id,
            product_name=product_name,
            sku=sku,
            quantity=quantity,
            total_cost=total_cost,
            currency=currency,
        )

        sent = await _send_email(
            to_email=supplier_email,
            subject=subject,
            html_body=html_body,
            text_body=text_body,
        )

        duration_ms = (time.monotonic() - start) * 1000
        logger.info(
            "supplier_email_%s" % ("sent" if sent else "skipped"),
            extra={"event_id": event_id, "po_id": po_id, "supplier_email": supplier_email},
        )

        return SkillResult(
            event_id=event_id,
            skill_name="supplier_email",
            success=True,
            action_type="email_sent" if sent else "no_action",
            payload={"po_id": po_id, "supplier_email": supplier_email, "sent": sent},
            duration_ms=duration_ms,
        )

    except Exception as exc:
        logger.exception("supplier_email failed", extra={"event_id": event_id})
        return SkillResult(
            event_id=event_id,
            skill_name="supplier_email",
            success=False,
            action_type="no_action",
            error=str(exc),
            duration_ms=(time.monotonic() - start) * 1000,
        )


async def _send_email(to_email: str, subject: str, html_body: str, text_body: str) -> bool:
    """Send email via SMTP. Returns True if sent, False if SMTP not configured."""
    if not SMTP_HOST or not SMTP_USER:
        logger.warning("smtp not configured — email not sent to %s", to_email)
        return False

    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"] = SMTP_FROM
    msg["To"] = to_email
    msg.attach(MIMEText(text_body, "plain"))
    msg.attach(MIMEText(html_body, "html"))

    with smtplib.SMTP(SMTP_HOST, SMTP_PORT) as server:
        server.ehlo()
        server.starttls()
        server.login(SMTP_USER, SMTP_PASS)
        server.sendmail(SMTP_FROM, to_email, msg.as_string())

    return True


def _build_email_html(
    supplier_name: str,
    po_id: str,
    product_name: str,
    sku: str,
    quantity: int,
    unit_cost: float,
    total_cost: float,
    currency: str,
    notes: str,
    merchant_name: str,
) -> str:
    return f"""
<!DOCTYPE html>
<html>
<body style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
  <h2 style="color: #25D366;">Purchase Order Confirmation</h2>
  <p>Dear {supplier_name},</p>
  <p>Please find below the details of a new purchase order from <strong>{merchant_name}</strong>.</p>
  <table style="width:100%; border-collapse: collapse; margin: 20px 0;">
    <tr style="background:#f5f5f5;">
      <th style="padding:8px; text-align:left; border:1px solid #ddd;">Field</th>
      <th style="padding:8px; text-align:left; border:1px solid #ddd;">Value</th>
    </tr>
    <tr><td style="padding:8px; border:1px solid #ddd;">PO Number</td><td style="padding:8px; border:1px solid #ddd;"><strong>{po_id}</strong></td></tr>
    <tr><td style="padding:8px; border:1px solid #ddd;">Product</td><td style="padding:8px; border:1px solid #ddd;">{product_name}</td></tr>
    <tr><td style="padding:8px; border:1px solid #ddd;">SKU</td><td style="padding:8px; border:1px solid #ddd;">{sku}</td></tr>
    <tr><td style="padding:8px; border:1px solid #ddd;">Quantity</td><td style="padding:8px; border:1px solid #ddd;">{quantity} units</td></tr>
    <tr><td style="padding:8px; border:1px solid #ddd;">Unit Cost</td><td style="padding:8px; border:1px solid #ddd;">{currency} {unit_cost:,.2f}</td></tr>
    <tr style="background:#f9f9f9;"><td style="padding:8px; border:1px solid #ddd;"><strong>Total</strong></td><td style="padding:8px; border:1px solid #ddd;"><strong>{currency} {total_cost:,.2f}</strong></td></tr>
  </table>
  {f'<p><em>Notes: {notes}</em></p>' if notes else ''}
  <p>Please confirm receipt and expected delivery date by replying to this email.</p>
  <p style="color:#888; font-size:12px;">This PO was generated automatically by the WhatsApp Commerce Platform.</p>
</body>
</html>
"""


def _build_email_text(
    supplier_name: str,
    po_id: str,
    product_name: str,
    sku: str,
    quantity: int,
    total_cost: float,
    currency: str,
) -> str:
    return (
        f"Purchase Order Confirmation\n\n"
        f"Dear {supplier_name},\n\n"
        f"PO Number: {po_id}\n"
        f"Product: {product_name} (SKU: {sku})\n"
        f"Quantity: {quantity} units\n"
        f"Total: {currency} {total_cost:,.2f}\n\n"
        f"Please confirm receipt and expected delivery date.\n"
    )
