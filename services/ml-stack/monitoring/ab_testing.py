"""
Model A/B Testing Infrastructure
==================================
Supports:
  - Champion/Challenger model comparison
  - Traffic splitting (configurable %)
  - Statistical significance testing (Mann-Whitney U, t-test)
  - Automatic winner promotion when significance threshold is reached
"""

import json
import uuid
import hashlib
from datetime import datetime
from pathlib import Path
from typing import Optional

import duckdb
import numpy as np
from scipy import stats

LAKEHOUSE_DIR = Path(__file__).parent.parent / "data" / "lakehouse"


class ABTestManager:
    """
    Manages model A/B tests with statistical significance testing.
    """

    def __init__(self):
        self.duck = duckdb.connect(str(LAKEHOUSE_DIR / "warehouse.duckdb"))
        self._init_tables()

    def _init_tables(self):
        self.duck.execute("""
            CREATE TABLE IF NOT EXISTS ab_tests (
                test_id VARCHAR PRIMARY KEY,
                model_name VARCHAR,
                champion_version VARCHAR,
                challenger_version VARCHAR,
                traffic_split DOUBLE DEFAULT 0.1,
                metric VARCHAR DEFAULT 'auprc',
                status VARCHAR DEFAULT 'running',
                winner VARCHAR,
                started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                ended_at TIMESTAMP
            )
        """)
        self.duck.execute("""
            CREATE TABLE IF NOT EXISTS ab_observations (
                obs_id VARCHAR PRIMARY KEY,
                test_id VARCHAR,
                variant VARCHAR,
                score DOUBLE,
                actual_label INTEGER,
                observed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)

    def create_test(
        self,
        model_name: str,
        champion_version: str,
        challenger_version: str,
        traffic_split: float = 0.1,
        metric: str = "auprc",
    ) -> str:
        """Create a new A/B test"""
        test_id = str(uuid.uuid4())
        self.duck.execute("""
            INSERT INTO ab_tests (test_id, model_name, champion_version, challenger_version,
                traffic_split, metric)
            VALUES (?, ?, ?, ?, ?, ?)
        """, [test_id, model_name, champion_version, challenger_version, traffic_split, metric])
        print(f"  A/B test created: {test_id} ({champion_version} vs {challenger_version}, {traffic_split:.0%} traffic)")
        return test_id

    def route_request(self, test_id: str, request_id: str) -> str:
        """
        Deterministically route a request to champion or challenger.
        Uses hash(request_id) for consistent routing (same request always same variant).
        """
        test = self.duck.execute(
            "SELECT traffic_split FROM ab_tests WHERE test_id = ?", [test_id]
        ).fetchone()
        if not test:
            return "champion"
        traffic_split = test[0]
        h = int(hashlib.md5(request_id.encode()).hexdigest(), 16) % 10000
        return "challenger" if h < traffic_split * 10000 else "champion"

    def record_observation(
        self,
        test_id: str,
        variant: str,
        score: float,
        actual_label: Optional[int] = None,
    ):
        """Record a prediction observation for statistical analysis"""
        self.duck.execute("""
            INSERT INTO ab_observations (obs_id, test_id, variant, score, actual_label)
            VALUES (?, ?, ?, ?, ?)
        """, [str(uuid.uuid4()), test_id, variant, score, actual_label])

    def evaluate_test(self, test_id: str, min_samples: int = 1000, alpha: float = 0.05) -> dict:
        """
        Evaluate A/B test statistical significance.
        Uses Mann-Whitney U test (non-parametric, suitable for score distributions).
        """
        df = self.duck.execute("""
            SELECT variant, score, actual_label FROM ab_observations WHERE test_id = ?
        """, [test_id]).df()

        champion_scores = df[df["variant"] == "champion"]["score"].values
        challenger_scores = df[df["variant"] == "challenger"]["score"].values

        if len(champion_scores) < min_samples or len(challenger_scores) < min_samples:
            return {
                "status": "insufficient_data",
                "champion_n": len(champion_scores),
                "challenger_n": len(challenger_scores),
                "min_required": min_samples,
            }

        # Mann-Whitney U test
        u_stat, p_value = stats.mannwhitneyu(
            challenger_scores, champion_scores, alternative="greater"
        )
        is_significant = p_value < alpha
        champion_mean = float(np.mean(champion_scores))
        challenger_mean = float(np.mean(challenger_scores))
        winner = "challenger" if (is_significant and challenger_mean > champion_mean) else "champion"

        result = {
            "status": "significant" if is_significant else "not_significant",
            "winner": winner,
            "champion_mean_score": champion_mean,
            "challenger_mean_score": challenger_mean,
            "lift": (challenger_mean - champion_mean) / max(champion_mean, 1e-10),
            "u_statistic": float(u_stat),
            "p_value": float(p_value),
            "alpha": alpha,
            "champion_n": len(champion_scores),
            "challenger_n": len(challenger_scores),
        }

        if is_significant:
            self.duck.execute("""
                UPDATE ab_tests SET status = 'completed', winner = ?, ended_at = CURRENT_TIMESTAMP
                WHERE test_id = ?
            """, [winner, test_id])
            print(f"  A/B test {test_id}: winner = {winner} (p={p_value:.4f}, lift={result['lift']:.2%})")

        return result

    def get_active_tests(self) -> list:
        return self.duck.execute(
            "SELECT * FROM ab_tests WHERE status = 'running' ORDER BY started_at DESC"
        ).df().to_dict(orient="records")


