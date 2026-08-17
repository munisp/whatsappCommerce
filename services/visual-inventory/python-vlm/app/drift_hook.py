"""
Drift alert hook for the CV stack.

Converts drift reports produced by the ml-stack drift detector
(`services/ml-stack/monitoring/drift_detector.py`) into a small alert
payload suitable for the platform notification API / CI drift wiring.

A drift report is expected to look like::

    {"metric": "psi", "drift_score": 0.23, "threshold": 0.2, "model": "yolo11n"}

`drift_alert_payload` returns::

    {"metric": "psi", "severity": "warning", "message": "..."}

or None when the score is at/below threshold (no drift worth alerting on).

Severity rules:
  - score > 2 * threshold  -> "critical"  (retrain now)
  - score >     threshold  -> "warning"   (monitor closely)
"""
from typing import Any, Optional

# Fallback threshold when the report itself doesn't carry one.
# Matches DriftDetector.THRESHOLDS["psi"] in ml-stack.
DEFAULT_DRIFT_THRESHOLD = 0.2


def drift_alert_payload(
    report: dict[str, Any],
    threshold: Optional[float] = None,
) -> Optional[dict[str, str]]:
    """
    Convert a drift report into an alert payload, or None if no alert.

    Args:
        report: drift detector output with at least a numeric ``drift_score``.
        threshold: optional override; falls back to ``report["threshold"]``
                   then to ``DEFAULT_DRIFT_THRESHOLD``.
    """
    if not isinstance(report, dict):
        return None

    score = report.get("drift_score")
    if not isinstance(score, (int, float)):
        return None

    thr = threshold
    if thr is None:
        raw = report.get("threshold")
        thr = raw if isinstance(raw, (int, float)) and raw > 0 else DEFAULT_DRIFT_THRESHOLD

    if score <= thr:
        return None

    metric = str(report.get("metric") or report.get("metric_name") or "unknown")
    severity = "critical" if score > 2 * thr else "warning"
    model = report.get("model") or report.get("model_name")
    subject = f"{metric}" + (f" ({model})" if model else "")
    message = (
        f"Drift detected in {subject}: drift_score={score:.4f} exceeds "
        f"threshold={thr:.4f} (severity={severity})."
    )
    return {"metric": metric, "severity": severity, "message": message}
