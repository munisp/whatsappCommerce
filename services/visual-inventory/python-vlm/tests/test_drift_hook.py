"""Tests for app.drift_hook.drift_alert_payload (ml-stack drift wiring)."""
from app.drift_hook import DEFAULT_DRIFT_THRESHOLD, drift_alert_payload


def test_no_alert_below_threshold():
    report = {"metric": "psi", "drift_score": 0.1, "threshold": 0.2}
    assert drift_alert_payload(report) is None


def test_alert_above_threshold():
    report = {"metric": "psi", "drift_score": 0.25, "threshold": 0.2}
    payload = drift_alert_payload(report)
    assert payload is not None
    assert payload["metric"] == "psi"
    assert payload["severity"] == "warning"
    assert "0.25" in payload["message"]
    assert set(payload.keys()) == {"metric", "severity", "message"}


def test_critical_when_score_exceeds_double_threshold():
    report = {"metric": "psi", "drift_score": 0.45, "threshold": 0.2}
    payload = drift_alert_payload(report)
    assert payload["severity"] == "critical"


def test_default_threshold_used_when_missing():
    # 0.25 > DEFAULT_DRIFT_THRESHOLD (0.2) -> alert even without report threshold
    payload = drift_alert_payload({"metric": "score_kl", "drift_score": 0.25})
    assert payload is not None
    assert payload["metric"] == "score_kl"
    assert DEFAULT_DRIFT_THRESHOLD == 0.2  # matches ml-stack PSI threshold


def test_threshold_override_param():
    report = {"metric": "psi", "drift_score": 0.15, "threshold": 0.2}
    assert drift_alert_payload(report) is None
    assert drift_alert_payload(report, threshold=0.1) is not None


def test_malformed_reports_return_none():
    assert drift_alert_payload({}) is None
    assert drift_alert_payload({"metric": "psi"}) is None
    assert drift_alert_payload({"drift_score": "high"}) is None
    assert drift_alert_payload(None) is None


def test_boundary_score_at_threshold_no_alert():
    assert drift_alert_payload({"metric": "psi", "drift_score": 0.2, "threshold": 0.2}) is None
