"""
Multi-angle stitching dedup tests for aggregate_batch_items.

Heuristic under test (see app.main.aggregate_batch_items docstring):
  - same overlap_group  -> per-label count = MAX across images (same shelf)
  - different groups     -> per-label count = SUM (disjoint stock)
  - no groups given      -> legacy SUM (each image its own group)
"""
from app.main import aggregate_batch_items


def _img(**label_counts):
    return [
        {"label": lbl, "count": cnt, "confidence": 0.8, "location": "",
         "notes": "", "bbox_count": cnt, "price_tag": None}
        for lbl, cnt in label_counts.items()
    ]


def _count(aggregated, label):
    return next(i["count"] for i in aggregated if i["label"] == label)


# 1. Same group -> max, not sum (dedup of overlapping shelf angles).
def test_same_group_takes_max_not_sum():
    per_image = [_img(**{"Coca-Cola": 8}), _img(**{"Coca-Cola": 6})]
    agg = aggregate_batch_items(per_image, ["shelf1", "shelf1"])
    assert _count(agg, "Coca-Cola") == 8  # NOT 14


# 2. Different groups -> sum (disjoint shelves).
def test_different_groups_sum():
    per_image = [_img(**{"Coca-Cola": 8}), _img(**{"Coca-Cola": 6})]
    agg = aggregate_batch_items(per_image, ["shelf1", "shelf2"])
    assert _count(agg, "Coca-Cola") == 14


# 3. Mixed: two images in group A dedup by max, then sum with group B.
def test_mixed_groups():
    per_image = [
        _img(**{"Coca-Cola": 8, "Peak Milk": 3}),   # group a
        _img(**{"Coca-Cola": 5, "Peak Milk": 7}),   # group a (same shelf)
        _img(**{"Coca-Cola": 4}),                   # group b (other shelf)
    ]
    agg = aggregate_batch_items(per_image, ["a", "a", "b"])
    assert _count(agg, "Coca-Cola") == 8 + 4   # max(8,5) + 4
    assert _count(agg, "Peak Milk") == 7        # max(3,7)


# 4. Backward compat: no overlap_groups -> legacy pure sum.
def test_no_groups_legacy_sum():
    per_image = [_img(**{"Coca-Cola": 8}), _img(**{"Coca-Cola": 6})]
    agg = aggregate_batch_items(per_image, None)
    assert _count(agg, "Coca-Cola") == 14


# 5. Wrong-length groups list degrades safely to legacy sum.
def test_mismatched_groups_fallback_to_sum():
    per_image = [_img(**{"Coca-Cola": 8}), _img(**{"Coca-Cola": 6})]
    agg = aggregate_batch_items(per_image, ["only-one"])
    assert _count(agg, "Coca-Cola") == 14


# 6. Confidence aggregation keeps the max confidence for a label.
def test_confidence_takes_max():
    img1 = [{"label": "Coca-Cola", "count": 8, "confidence": 0.6, "location": "",
             "notes": "", "bbox_count": 8, "price_tag": None}]
    img2 = [{"label": "Coca-Cola", "count": 6, "confidence": 0.9, "location": "",
             "notes": "", "bbox_count": 6, "price_tag": None}]
    agg = aggregate_batch_items([img1, img2], ["a", "a"])
    item = next(i for i in agg if i["label"] == "Coca-Cola")
    assert item["confidence"] == 0.9
