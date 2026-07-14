"""
Model Drift Detection & Monitoring
=====================================
Detects:
  1. Data drift: input feature distribution shift (PSI - Population Stability Index)
  2. Concept drift: model performance degradation (AUPRC drop)
  3. Prediction drift: output score distribution shift (KL divergence)

Alerts are written to the warehouse drift_metrics table and optionally
sent to the platform via the owner notification API.
"""

import json
import uuid
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional

import duckdb
import numpy as np
import pandas as pd
from scipy import stats
from scipy.special import kl_div

LAKEHOUSE_DIR = Path(__file__).parent.parent / "data" / "lakehouse"


def compute_psi(expected: np.ndarray, actual: np.ndarray, buckets: int = 10) -> float:
    """
    Population Stability Index (PSI).
    PSI < 0.1: No significant change
    PSI 0.1-0.2: Moderate change — monitor
    PSI > 0.2: Significant change — retrain
    """
    min_val = min(expected.min(), actual.min())
    max_val = max(expected.max(), actual.max())
    bins = np.linspace(min_val, max_val, buckets + 1)

    exp_counts, _ = np.histogram(expected, bins=bins)
    act_counts, _ = np.histogram(actual, bins=bins)

    exp_pct = (exp_counts + 1e-6) / len(expected)
    act_pct = (act_counts + 1e-6) / len(actual)

    psi = np.sum((act_pct - exp_pct) * np.log(act_pct / exp_pct))
    return float(psi)


def compute_ks_statistic(reference: np.ndarray, current: np.ndarray) -> tuple:
    """Kolmogorov-Smirnov test for distribution shift"""
    ks_stat, p_value = stats.ks_2samp(reference, current)
    return float(ks_stat), float(p_value)


class DriftDetector:
    """
    Monitors model inputs and outputs for distribution shift.
    Connects to the DuckDB warehouse for historical baselines.
    """

    THRESHOLDS = {
        "psi": 0.2,           # PSI > 0.2 → retrain
        "ks_stat": 0.1,       # KS > 0.1 → monitor
        "auprc_drop": 0.05,   # AUPRC drop > 5% → alert
        "score_kl": 0.1,      # KL divergence > 0.1 → monitor
    }

    def __init__(self, model_name: str):
        self.model_name = model_name
        self.duck = duckdb.connect(str(LAKEHOUSE_DIR / "warehouse.duckdb"))

    def check_feature_drift(
        self,
        reference_features: np.ndarray,
        current_features: np.ndarray,
        feature_names: list,
    ) -> dict:
        """Check PSI for each feature"""
        results = {}
        drifted_features = []

        for i, feat_name in enumerate(feature_names):
            psi = compute_psi(reference_features[:, i], current_features[:, i])
            ks_stat, p_value = compute_ks_statistic(reference_features[:, i], current_features[:, i])
            is_drifted = psi > self.THRESHOLDS["psi"] or ks_stat > self.THRESHOLDS["ks_stat"]

            results[feat_name] = {
                "psi": psi, "ks_stat": ks_stat, "p_value": p_value,
                "is_drifted": is_drifted,
            }
            if is_drifted:
                drifted_features.append(feat_name)

            # Log to warehouse
            self._log_metric("psi_" + feat_name, psi, self.THRESHOLDS["psi"], is_drifted)

        results["_summary"] = {
            "n_drifted": len(drifted_features),
            "drifted_features": drifted_features,
            "needs_retraining": len(drifted_features) > len(feature_names) * 0.3,
        }
        return results

    def check_prediction_drift(
        self,
        reference_scores: np.ndarray,
        current_scores: np.ndarray,
    ) -> dict:
        """Check output score distribution shift"""
        psi = compute_psi(reference_scores, current_scores)
        ks_stat, p_value = compute_ks_statistic(reference_scores, current_scores)

        # KL divergence on binned distributions
        bins = np.linspace(0, 1, 21)
        ref_hist, _ = np.histogram(reference_scores, bins=bins, density=True)
        cur_hist, _ = np.histogram(current_scores, bins=bins, density=True)
        kl = float(np.sum(kl_div(ref_hist + 1e-10, cur_hist + 1e-10)))

        is_drifted = psi > self.THRESHOLDS["psi"] or kl > self.THRESHOLDS["score_kl"]
        self._log_metric("prediction_psi", psi, self.THRESHOLDS["psi"], is_drifted)
        self._log_metric("prediction_kl", kl, self.THRESHOLDS["score_kl"], is_drifted)

        return {"psi": psi, "ks_stat": ks_stat, "kl_divergence": kl, "is_drifted": is_drifted}

    def check_performance_drift(
        self,
        reference_auprc: float,
        current_auprc: float,
    ) -> dict:
        """Check if model performance has degraded"""
        drop = reference_auprc - current_auprc
        is_drifted = drop > self.THRESHOLDS["auprc_drop"]
        self._log_metric("auprc_drop", drop, self.THRESHOLDS["auprc_drop"], is_drifted)
        return {
            "reference_auprc": reference_auprc,
            "current_auprc": current_auprc,
            "drop": drop,
            "is_drifted": is_drifted,
            "needs_retraining": is_drifted,
        }

    def _log_metric(self, metric_name: str, value: float, threshold: float, is_drifted: bool):
        try:
            self.duck.execute("""
                INSERT INTO drift_metrics (metric_id, model_name, metric_name, metric_value,
                    threshold, is_drifted, window_start, window_end)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """, [
                str(uuid.uuid4()), self.model_name, metric_name, value,
                threshold, int(is_drifted),
                (datetime.now() - timedelta(hours=24)).isoformat(),
                datetime.now().isoformat(),
            ])
        except Exception:
            pass  # Non-blocking

    def get_drift_summary(self) -> dict:
        """Get latest drift metrics for all features"""
        try:
            df = self.duck.execute("""
                SELECT metric_name, metric_value, threshold, is_drifted, computed_at
                FROM drift_metrics
                WHERE model_name = ?
                ORDER BY computed_at DESC
                LIMIT 100
            """, [self.model_name]).df()
            return df.to_dict(orient="records")
        except Exception:
            return []


