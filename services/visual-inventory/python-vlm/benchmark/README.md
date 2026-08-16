# Visual Inventory Benchmark Harness

Accuracy gate for the YOLO + VLM merge pipeline. Replays ground-truth
fixtures through the **real** `merge_results()` (and the Florence-2 adapter
`florence2_to_vlm_format()` for florence2 fixtures) from `app.main` and
scores per-class count accuracy.

## Run

```bash
cd services/visual-inventory/python-vlm
python3 benchmark/runner.py            # exit 0 if gate passes, 1 otherwise
python3 benchmark/runner.py --report   # also dump the full JSON report
CV_BENCH_THRESHOLD=0.9 python3 benchmark/runner.py   # stricter gate
```

Default gate: overall weighted accuracy >= **0.80**
(`CV_BENCH_THRESHOLD` env var overrides).

## Metrics

- **per-class accuracy**: `max(0, 1 - |pred - true| / true)`
- **MAE**: mean absolute count error across ground-truth classes
- **weighted accuracy**: per-class accuracy weighted by `true_count`

## Fixture format (`fixtures/*.json`)

```json
{
  "name": "shelf_beverages",
  "description": "what this scene simulates",
  "ground_truth": [{"label": "Coca-Cola 50cl", "true_count": 12}],
  "mock_vlm":  {"scene_description": "...", "inventory_notes": "...",
                "items": [{"label": "...", "count": 11, "confidence": 0.85}]},
  "mock_yolo": {"counts": {"coca cola": 12}, "detections": [], "total_detected": 12}
}
```

Florence-2 fixtures instead carry `mock_florence2: {"detections": [{"label",
"bbox": [x1,y1,x2,y2]}, ...]}` (set `"mock_vlm": null`) and are run through
the real Florence-2 → VLM-format adapter before merging.

## Adding real labeled photos later

1. Photograph a shelf, count the products by hand, and record counts in the
   same `ground_truth` format (label + true_count).
2. Replace the `mock_*` blocks with the **actual service output** for that
   photo:
   - call `POST /analyse` and copy `raw_vlm` into `mock_vlm` and
     `raw_yolo` into `mock_yolo` (keep the photo in a `photos/` dir and
     reference it from the fixture for provenance), or
   - for the Florence-2 backend, save the raw detection list as
     `mock_florence2`.
3. Re-run the harness. The mock fields are just serialized detector
   outputs, so real captures drop in without any runner changes.
4. Tighten `CV_BENCH_THRESHOLD` in CI as the labeled set grows.
