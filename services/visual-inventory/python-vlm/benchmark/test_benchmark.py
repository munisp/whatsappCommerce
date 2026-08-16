"""
Benchmark gate tests.

1. The real fixtures must pass the accuracy gate (threshold 0.80).
2. A deliberately corrupted fixture (all counts wrong) MUST fail the gate —
   this proves the gate is mutation-proof and not a tautology.
"""
import copy
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from benchmark.runner import (  # noqa: E402
    DEFAULT_THRESHOLD,
    load_fixtures,
    run_benchmark,
    run_fixture,
)


def test_fixtures_exist_and_minimum_count():
    fixtures = load_fixtures()
    assert len(fixtures) >= 6, "need at least 6 ground-truth fixtures"
    for f in fixtures:
        assert f["ground_truth"], f"{f.get('name')} missing ground_truth"
        assert f.get("mock_vlm") or f.get("mock_florence2")
        assert "mock_yolo" in f


def test_benchmark_gate_passes_on_real_fixtures():
    report = run_benchmark()
    assert report["overall_weighted_accuracy"] >= DEFAULT_THRESHOLD, (
        f"weighted accuracy {report['overall_weighted_accuracy']} below gate"
    )


def test_gate_fails_on_corrupted_fixture():
    """Corrupt every mock so all predicted counts are wildly wrong."""
    fixtures = load_fixtures()
    corrupted = []
    for f in fixtures:
        bad = copy.deepcopy(f)
        if bad.get("mock_vlm"):
            for item in bad["mock_vlm"]["items"]:
                item["count"] = item["count"] * 10 + 25  # massive overcount
        if bad.get("mock_yolo"):
            bad["mock_yolo"]["counts"] = {
                k: v * 10 + 25 for k, v in bad["mock_yolo"]["counts"].items()
            }
        if bad.get("mock_florence2"):
            dets = bad["mock_florence2"]["detections"]
            # triple the detections -> ~3x overcount vs ground truth
            bad["mock_florence2"]["detections"] = dets * 3
        corrupted.append(bad)

    report = run_benchmark(fixture_docs=corrupted)
    assert report["overall_weighted_accuracy"] < DEFAULT_THRESHOLD, (
        "gate failed to catch corrupted fixture — benchmark is not mutation-proof"
    )


def test_all_wrong_counts_score_zero_accuracy():
    """A fixture whose predictions are entirely absent scores 0."""
    fixture = {
        "name": "all_wrong",
        "ground_truth": [{"label": "Coca-Cola", "true_count": 10}],
        "mock_vlm": {"items": [], "scene_description": "", "inventory_notes": ""},
        "mock_yolo": {"counts": {}, "detections": []},
    }
    rep = run_fixture(fixture)
    assert rep["weighted_accuracy"] == 0.0
    assert rep["mae"] == 10.0


def test_runner_main_exit_codes(capsys):
    from benchmark import runner

    assert runner.main([]) == 0  # real fixtures pass
    # env override to an impossible threshold flips the gate to FAIL
    import os
    os.environ["CV_BENCH_THRESHOLD"] = "1.01"
    try:
        assert runner.main([]) == 1
    finally:
        del os.environ["CV_BENCH_THRESHOLD"]
