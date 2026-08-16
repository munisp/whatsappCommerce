"""
Visual-inventory accuracy benchmark harness.

Loads ground-truth fixtures from ./fixtures, replays their mock detector
outputs through the REAL merge logic (app.main.merge_results) — and the real
Florence-2 adapter (app.main.florence2_to_vlm_format) for florence2 fixtures —
then scores per-class count accuracy against ground truth.

Metrics per fixture and overall:
  - per-class count accuracy: max(0, 1 - |pred - true| / true)   (true > 0)
  - MAE: mean absolute count error across ground-truth classes
  - weighted accuracy: per-class accuracy weighted by true_count

Gate: exits non-zero when the overall weighted accuracy is below the
threshold (default 0.80, override with env CV_BENCH_THRESHOLD).

Usage:
    python3 benchmark/runner.py                  # run gate, exit 0/1
    python3 benchmark/runner.py --report         # print JSON report too
"""
import json
import os
import sys
from pathlib import Path
from typing import Any

# Make `app` importable when run as a script from anywhere.
_PKG_ROOT = Path(__file__).resolve().parent.parent
if str(_PKG_ROOT) not in sys.path:
    sys.path.insert(0, str(_PKG_ROOT))

from app.main import florence2_to_vlm_format, merge_results  # noqa: E402

FIXTURES_DIR = Path(__file__).resolve().parent / "fixtures"
DEFAULT_THRESHOLD = 0.80
ENV_THRESHOLD = "CV_BENCH_THRESHOLD"


def _labels_match(a: str, b: str) -> bool:
    """Same fuzzy rule as merge_results: substring, case-insensitive."""
    a, b = a.lower(), b.lower()
    return a in b or b in a


def run_fixture(fixture: dict[str, Any]) -> dict[str, Any]:
    """Replay one fixture through the real merge pipeline and score it."""
    if fixture.get("mock_florence2"):
        # Florence-2 backend path: adapter converts detections to VLM format.
        vlm_result = florence2_to_vlm_format(fixture["mock_florence2"], hints=[])
        yolo_result = fixture.get("mock_yolo") or {"counts": {}, "detections": []}
    else:
        vlm_result = fixture["mock_vlm"]
        yolo_result = fixture.get("mock_yolo") or {"counts": {}, "detections": []}

    merged, overall_conf = merge_results(
        vlm_result, yolo_result, {"detections": [], "processed": False}
    )
    predicted = {item.label: item.count for item in merged}

    per_class = []
    total_weight = 0
    weighted_acc = 0.0
    abs_errors = []
    for gt in fixture["ground_truth"]:
        true_count = gt["true_count"]
        pred_count = next(
            (c for lbl, c in predicted.items() if _labels_match(lbl, gt["label"])),
            0,
        )
        acc = max(0.0, 1.0 - abs(pred_count - true_count) / true_count) if true_count > 0 else (
            1.0 if pred_count == 0 else 0.0
        )
        per_class.append({
            "label": gt["label"],
            "true": true_count,
            "predicted": pred_count,
            "accuracy": round(acc, 4),
        })
        total_weight += true_count
        weighted_acc += acc * true_count
        abs_errors.append(abs(pred_count - true_count))

    weighted = weighted_acc / total_weight if total_weight else 0.0
    return {
        "fixture": fixture.get("name", "unnamed"),
        "per_class": per_class,
        "mae": round(sum(abs_errors) / len(abs_errors), 4) if abs_errors else 0.0,
        "weighted_accuracy": round(weighted, 4),
        "overall_confidence": overall_conf,
    }


def load_fixtures(fixtures_dir: Path = FIXTURES_DIR) -> list[dict[str, Any]]:
    fixtures = []
    for path in sorted(fixtures_dir.glob("*.json")):
        fixtures.append(json.loads(path.read_text(encoding="utf-8")))
    return fixtures


def run_benchmark(
    fixtures_dir: Path = FIXTURES_DIR,
    fixture_docs: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Run all fixtures and return the aggregate report."""
    docs = fixture_docs if fixture_docs is not None else load_fixtures(fixtures_dir)
    reports = [run_fixture(doc) for doc in docs]

    total_weight = 0
    weighted_acc = 0.0
    all_errors = []
    for doc, rep in zip(docs, reports):
        for gt, pc in zip(doc["ground_truth"], rep["per_class"]):
            total_weight += gt["true_count"]
            weighted_acc += pc["accuracy"] * gt["true_count"]
            all_errors.append(abs(pc["predicted"] - pc["true"]))

    return {
        "fixtures": reports,
        "num_fixtures": len(reports),
        "overall_weighted_accuracy": round(weighted_acc / total_weight, 4) if total_weight else 0.0,
        "overall_mae": round(sum(all_errors) / len(all_errors), 4) if all_errors else 0.0,
    }


def get_threshold() -> float:
    raw = os.getenv(ENV_THRESHOLD)
    if raw:
        try:
            return float(raw)
        except ValueError:
            pass
    return DEFAULT_THRESHOLD


def main(argv: list[str]) -> int:
    report = run_benchmark()
    threshold = get_threshold()
    acc = report["overall_weighted_accuracy"]
    passed = acc >= threshold

    for rep in report["fixtures"]:
        print(f"[{rep['fixture']}] weighted_acc={rep['weighted_accuracy']:.4f} "
              f"mae={rep['mae']:.2f}")
        for pc in rep["per_class"]:
            print(f"    {pc['label']}: true={pc['true']} pred={pc['predicted']} "
                  f"acc={pc['accuracy']:.3f}")

    print(f"\nOverall weighted accuracy: {acc:.4f} (threshold {threshold:.2f}) "
          f"— MAE {report['overall_mae']:.2f} across {report['num_fixtures']} fixtures")
    print("BENCHMARK GATE:", "PASS" if passed else "FAIL")

    if "--report" in argv:
        print(json.dumps(report, indent=2))

    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
