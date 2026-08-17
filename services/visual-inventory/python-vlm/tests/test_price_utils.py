"""
Tests for naira price parsing + price-tag schema tolerance.

parse_naira_price must stay semantically consistent with the TypeScript
receiptVision.parseReceiptAmount (server/services/receiptVision.ts).
"""
import pytest

from app.price_utils import parse_naira_price
from app.main import DetectedItem, InventoryAnalysisResponse, merge_results


# ── parse_naira_price ─────────────────────────────────────────────────────────
@pytest.mark.parametrize("text,expected", [
    ("₦12,500", 12500.0),
    ("₦1,500", 1500.0),
    ("NGN 12500.00", 12500.0),
    ("ngn 850", 850.0),
    ("12,500.00", 12500.0),
    ("N 2,300.50", 2300.5),
    ("₦950.00", 950.0),
    ("Price: ₦3,200 per carton", 3200.0),
])
def test_parse_valid_prices(text, expected):
    assert parse_naira_price(text) == pytest.approx(expected)


@pytest.mark.parametrize("text", [
    None,
    "",
    "free",
    "₦",
    "no digits here",
    "₦0",          # zero is not a valid price (matches TS value > 0 rule)
    "0.00",
])
def test_parse_invalid_prices_return_none(text):
    assert parse_naira_price(text) is None


def test_parse_strips_thousands_separators():
    assert parse_naira_price("₦1,234,567.89") == pytest.approx(1234567.89)


# ── Schema tolerance ──────────────────────────────────────────────────────────
def test_detected_item_price_tag_optional():
    # VLM omitting price_tag must not break the existing contract.
    item = DetectedItem(label="Peak Milk", count=3, confidence=0.8)
    assert item.price_tag is None
    dumped = item.model_dump()
    assert dumped["label"] == "Peak Milk"
    assert dumped["count"] == 3


def test_response_price_tags_default_empty():
    resp = InventoryAnalysisResponse(
        session_id="s1",
        scene_description="shelf",
        total_unique_products=0,
        total_items_counted=0,
        items=[],
        yolo_detections=0,
        vlm_model_used="mock",
        processing_ms=1,
        image_width=640,
        image_height=480,
        inventory_notes="",
        confidence_score=0.0,
    )
    assert resp.price_tags == []  # additive field, backwards compatible default


def test_merge_tolerates_vlm_items_without_price_tag():
    merged, _ = merge_results(
        {"items": [{"label": "Maggi Cubes", "count": 10, "confidence": 0.8}]},
        {"counts": {}, "detections": []},
        {"detections": [], "processed": False},
    )
    assert merged[0].price_tag is None  # no crash, field absent -> None


def test_merge_propagates_price_tag_when_present():
    merged, _ = merge_results(
        {"items": [{"label": "Maggi Cubes", "count": 10, "confidence": 0.8,
                    "price_tag": "₦1,200"}]},
        {"counts": {}, "detections": []},
        {"detections": [], "processed": False},
    )
    assert merged[0].price_tag == "₦1,200"
