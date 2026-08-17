"""
Merge-logic contract tests for app.main.merge_results.

Each test pins one documented behaviour of the YOLO+VLM merge; reverting the
corresponding logic in main.py must fail the matching test.

These tests import app.main, which must remain importable WITHOUT
ultralytics/torch/transformers (lazy imports only).
"""
import asyncio

import pytest

from app.main import (
    DetectedItem,
    call_rust_bbox_processor,
    merge_results,
)
from app.config import settings


def _vlm(items):
    return {"items": items, "scene_description": "s", "inventory_notes": "n"}


def _yolo(counts, detections=None):
    return {
        "counts": counts,
        "detections": detections or [],
        "total_detected": sum(counts.values()),
    }


EMPTY_BBOX = {"detections": [], "processed": False}


# 1. VLM-primary label retention: merged labels come from the VLM, not YOLO.
def test_vlm_label_is_primary():
    merged, _ = merge_results(
        _vlm([{"label": "Indomie Noodles", "count": 5, "confidence": 0.8}]),
        _yolo({"indomie": 5}),
        EMPTY_BBOX,
    )
    assert len(merged) == 1
    assert merged[0].label == "Indomie Noodles"


# 2. Count rule: final count = max(vlm, yolo) when YOLO agrees.
def test_count_is_max_of_vlm_and_yolo():
    merged, _ = merge_results(
        _vlm([{"label": "Coca-Cola 50cl", "count": 3, "confidence": 0.7}]),
        _yolo({"coca-cola": 8}),
        EMPTY_BBOX,
    )
    assert merged[0].count == 8  # YOLO higher wins
    merged2, _ = merge_results(
        _vlm([{"label": "Coca-Cola 50cl", "count": 10, "confidence": 0.7}]),
        _yolo({"coca-cola": 8}),
        EMPTY_BBOX,
    )
    assert merged2[0].count == 10  # VLM higher wins


# 3. Agreement confidence boost: +0.1 when YOLO matches, capped at 1.0.
def test_confidence_boost_on_agreement_and_cap():
    merged, _ = merge_results(
        _vlm([{"label": "Peak Milk", "count": 4, "confidence": 0.75}]),
        _yolo({"peak": 4}),
        EMPTY_BBOX,
    )
    assert merged[0].confidence == pytest.approx(0.85, abs=1e-3)

    merged_cap, _ = merge_results(
        _vlm([{"label": "Peak Milk", "count": 4, "confidence": 0.97}]),
        _yolo({"peak": 4}),
        EMPTY_BBOX,
    )
    assert merged_cap[0].confidence == 1.0  # capped, not 1.07


# 4. No boost without YOLO agreement.
def test_no_boost_without_yolo_match():
    merged, _ = merge_results(
        _vlm([{"label": "Peak Milk", "count": 4, "confidence": 0.75}]),
        _yolo({"bottle": 4}),
        EMPTY_BBOX,
    )
    item = next(i for i in merged if i.label == "Peak Milk")
    assert item.confidence == pytest.approx(0.75, abs=1e-3)


# 5. YOLO-only detections are appended at 0.65 confidence with the exact note.
def test_yolo_only_items_flagged():
    merged, _ = merge_results(
        _vlm([{"label": "Peak Milk", "count": 4, "confidence": 0.8}]),
        _yolo({"peak": 4, "bottle": 12}),
        EMPTY_BBOX,
    )
    yolo_only = next(i for i in merged if i.label == "Bottle")
    assert yolo_only.count == 12
    assert yolo_only.confidence == 0.65
    assert yolo_only.notes == "YOLO detection only — VLM did not identify this item"
    assert yolo_only.bbox_count == 12


# 6. Fuzzy label matching is substring-based and case-insensitive.
def test_fuzzy_label_matching():
    merged, _ = merge_results(
        _vlm([{"label": "DANO MILK SACHET", "count": 2, "confidence": 0.8}]),
        _yolo({"dano milk": 7}),
        EMPTY_BBOX,
    )
    assert merged[0].bbox_count == 7
    assert merged[0].count == 7
    # YOLO label consumed -> no duplicate "Dano Milk" yolo-only entry
    assert len(merged) == 1


# 7. Empty-VLM edge: only YOLO-only items, valid overall confidence.
def test_empty_vlm_edge():
    merged, conf = merge_results(_vlm([]), _yolo({"bottle": 3, "box": 2}), EMPTY_BBOX)
    assert len(merged) == 2
    assert all(i.confidence == 0.65 for i in merged)
    assert conf == pytest.approx(0.65, abs=1e-3)

    merged_empty, conf_empty = merge_results(_vlm([]), _yolo({}), EMPTY_BBOX)
    assert merged_empty == []
    assert conf_empty == 0.0


# 8. Weighted overall confidence: count-weighted mean of item confidences.
def test_weighted_overall_confidence_math():
    merged, conf = merge_results(
        _vlm([
            {"label": "A beans", "count": 9, "confidence": 0.9},   # no yolo match
            {"label": "B rice", "count": 1, "confidence": 0.5},     # no yolo match
        ]),
        _yolo({}),
        EMPTY_BBOX,
    )
    expected = (0.9 * 9 + 0.5 * 1) / 10
    assert conf == pytest.approx(round(expected, 3), abs=1e-3)


# 9. rust-bbox unavailable fallback: returns unprocessed detections.
def test_rust_bbox_unavailable_fallback(monkeypatch):
    # Point at a guaranteed-unreachable address; must fall back gracefully.
    monkeypatch.setattr(settings, "rust_bbox_url", "http://127.0.0.1:9")
    dets = [{"label": "bottle", "confidence": 0.9, "bbox": [0, 0, 10, 10]}]
    result = asyncio.run(call_rust_bbox_processor(dets, 640, 480))
    assert result["processed"] is False
    assert result["detections"] == dets


# 10. bbox processor output feeds merged bbox_count when available.
def test_bbox_counts_propagate_to_items():
    merged, _ = merge_results(
        _vlm([{"label": "Golden Penny Sugar", "count": 1, "confidence": 0.8}]),
        _yolo({"sugar": 6}),
        EMPTY_BBOX,
    )
    assert merged[0].bbox_count == 6
    assert isinstance(merged[0], DetectedItem)
