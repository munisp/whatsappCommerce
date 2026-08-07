#!/usr/bin/env python3
"""
ML Inference Endpoint Helper
=============================
Called by POST /api/ml/predict in index.ts via execSync.
Accepts a JSON payload as the first CLI argument and prints a JSON result.

Loads the REAL trained weights committed at
services/ml-stack/models/weights/ (fraud_gnn_lstm.pt / credit_tabnet.pt, or
their .onnx siblings) via the shared loader in services/ml-stack/model_io.py
— the same loader the FastAPI inference server uses. CPU only. If the model
cannot be loaded, a deterministic, clearly labeled heuristic fallback is
used (source="heuristic-fallback").

Usage:
    python3 predict.py '{"amount": 50000, "num_items": 3, "has_phone": true, "has_customer": true}'

Output:
    {"fraud_probability": 0.12, "credit_score": 784, "risk_level": "low", "source": "model"}

Feature vector (20 dims, matches FRAUD_FEATURES in train_all.py):
    amount_ngn, hour_of_day, day_of_week, is_weekend,
    is_new_device, is_vpn, is_tor,
    tx_count_1h, tx_count_24h, tx_count_7d,
    tx_amount_1h, tx_amount_24h,
    unique_merchants_24h, avg_amount_7d, max_amount_7d,
    time_on_site_sec, pages_visited, cart_abandon_rate,
    days_since_account_creation, device_age_days
"""
import json
import sys
from pathlib import Path

# Shared loader: services/ml-stack/model_io.py
_ML_STACK_DIR = Path(__file__).resolve().parent.parent
if str(_ML_STACK_DIR) not in sys.path:
    sys.path.insert(0, str(_ML_STACK_DIR))

import model_io  # noqa: E402


def predict(payload: dict) -> dict:
    """
    Fraud + credit prediction for one transaction payload.
    Uses the loaded model when available; otherwise the deterministic
    heuristic fallback (source="heuristic-fallback"). No randomness.
    """
    payload = {k: v for k, v in payload.items() if v is not None}
    features = model_io.build_fraud_features(payload)

    fraud_bundle = model_io.load_fraud_bundle()
    if fraud_bundle:
        try:
            prob = model_io.predict_fraud_proba(fraud_bundle, features)
            fraud_source = "model"
        except Exception as e:
            print(f"model fraud inference failed, heuristic fallback: {e}",
                  file=sys.stderr)
            prob, _ = model_io.heuristic_fraud_score(features)
            fraud_source = "heuristic-fallback"
    else:
        prob, _ = model_io.heuristic_fraud_score(features)
        fraud_source = "heuristic-fallback"

    credit_bundle = model_io.load_credit_bundle()
    if credit_bundle:
        try:
            default_prob = model_io.predict_default_proba(
                credit_bundle, model_io.build_credit_features(payload))
            credit_score, _grade = model_io.credit_score_from_default_prob(default_prob)
            credit_source = "model"
        except Exception as e:
            print(f"model credit inference failed, heuristic fallback: {e}",
                  file=sys.stderr)
            credit_score, _grade = model_io.heuristic_credit_score(features)
            credit_source = "heuristic-fallback"
    else:
        credit_score, _grade = model_io.heuristic_credit_score(features)
        credit_source = "heuristic-fallback"

    return {
        "fraud_probability": round(prob, 4),
        "credit_score": credit_score,
        "risk_level": model_io.risk_level(prob),
        "source": fraud_source,
        "fraud_source": fraud_source,
        "credit_source": credit_source,
    }


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "No payload provided"}))
        sys.exit(1)

    try:
        payload = json.loads(sys.argv[1])
    except json.JSONDecodeError as e:
        print(json.dumps({"error": f"Invalid JSON: {e}"}))
        sys.exit(1)

    print(json.dumps(predict(payload)))


if __name__ == "__main__":
    main()
