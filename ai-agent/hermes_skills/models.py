"""Shared Pydantic models for Hermes skill requests and responses."""
from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Any, Optional

from pydantic import BaseModel, Field


class SkillEventType(str, Enum):
    INVENTORY_LOW_STOCK = "inventory.low_stock"
    INVENTORY_OUT_OF_STOCK = "inventory.out_of_stock"
    ORDER_PLACED = "order.placed"
    ORDER_HIGH_VALUE = "order.high_value"
    FRAUD_ALERT = "fraud.alert"
    SUPPLIER_DELIVERY_DELAY = "supplier.delivery_delay"
    CUSTOMER_COMPLAINT = "customer.complaint"


class SkillRequest(BaseModel):
    event_id: str
    tenant_id: str
    event_type: str
    occurred_at: str
    payload: dict[str, Any]
    context: dict[str, Any] = Field(default_factory=dict)
    retry_count: int = 0


class POLineItem(BaseModel):
    sku: str
    product_name: str
    quantity: int
    unit_cost: float
    currency: str = "NGN"


class PurchaseOrderDraft(BaseModel):
    po_id: str
    tenant_id: str
    supplier_name: str
    supplier_email: str
    merchant_phone: str
    line_items: list[POLineItem]
    total_cost: float
    currency: str = "NGN"
    approval_token: str
    notes: str = ""
    created_at: str = Field(default_factory=lambda: datetime.utcnow().isoformat())


class SkillResult(BaseModel):
    event_id: str
    skill_name: str
    success: bool
    action_type: str  # po_draft | email_sent | sync_complete | alert | no_action
    payload: dict[str, Any] = Field(default_factory=dict)
    error: Optional[str] = None
    duration_ms: float = 0.0
