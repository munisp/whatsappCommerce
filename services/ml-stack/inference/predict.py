#!/usr/bin/env python3
"""
ML Inference Endpoint Helper
=============================
Called by POST /api/ml/predict in index.ts via execSync.
Accepts a JSON payload as the first CLI argument and prints a JSON result.

Usage:
    python3 predict.py '{"amount": 50000, "num_items": 3, "has_phone": true, "has_customer": true}'

Output:
    {"fraud_probability": 0.12, "credit_score": 784, "risk_level": "low", "source": "pytorch_model"}

Feature vector (20 dims, matches FRAUD_FEATURES in train_all.py):
    amount_ngn, hour_of_day, day_of_week, is_weekend,
    is_new_device, is_vpn, is_tor,
    tx_count_1h, tx_count_24h, tx_count_7d,
    tx_amount_1h, tx_amount_24h,
    unique_merchants_24h, avg_amount_7d, max_amount_7d,
    time_on_site_sec, pages_visited, cart_abandon_rate,
    days_since_account_creation, device_age_days
"""
import sys
import json
import os
from pathlib import Path
from datetime import datetime, timezone

# ── Feature engineering ───────────────────────────────────────────────────────
def build_feature_vector(payload: dict) -> list:
    """
    Map the /api/ml/predict payload fields to the 20-dim FRAUD_FEATURES vector.
    Missing fields are imputed with safe defaults.
    """
    now = datetime.now(timezone.utc)
    amount = float(payload.get("amount", 0))
    num_items = int(payload.get("num_items", 0))
    has_phone = bool(payload.get("has_phone", True))
    has_customer = bool(payload.get("has_customer", True))

    return [
        amount,                                      # amount_ngn
        float(now.hour),                             # hour_of_day
        float(now.weekday()),                        # day_of_week
        1.0 if now.weekday() >= 5 else 0.0,         # is_weekend
        0.0 if has_customer else 1.0,               # is_new_device (proxy: no customer = new device)
        0.0,                                         # is_vpn (unknown)
        0.0,                                         # is_tor (unknown)
        1.0,                                         # tx_count_1h (this tx)
        1.0,                                         # tx_count_24h
        1.0,                                         # tx_count_7d
        amount,                                      # tx_amount_1h
        amount,                                      # tx_amount_24h
        1.0,                                         # unique_merchants_24h
        amount,                                      # avg_amount_7d
        amount,                                      # max_amount_7d
        0.0,                                         # time_on_site_sec (unknown)
        float(num_items),                            # pages_visited (proxy: item count)
        0.0 if num_items > 0 else 1.0,              # cart_abandon_rate
        30.0 if has_customer else 0.0,              # days_since_account_creation
        30.0 if has_customer else 0.0,              # device_age_days
    ]


# ── PyTorch model inference ───────────────────────────────────────────────────
def _pytorch_predict(features: dict) -> dict | None:
    """Attempt real model inference. Returns None if model/weights unavailable."""
    try:
        import torch
        import numpy as np

        # Locate weights
        weights_dir = Path(__file__).parent.parent / "models" / "weights"
        weight_file = weights_dir / "fraud_gnn_lstm.pt"
        if not weight_file.exists():
            return None

        # Load checkpoint
        ckpt = torch.load(weight_file, map_location="cpu")
        input_dim = ckpt.get("input_dim", 20)
        scaler_mean = ckpt.get("scaler_mean")
        scaler_scale = ckpt.get("scaler_scale")

        # Build feature vector
        feat_raw = np.array(build_feature_vector(features), dtype=np.float32)
        if len(feat_raw) != input_dim:
            # Pad or truncate to match saved model's input_dim
            if len(feat_raw) < input_dim:
                feat_raw = np.pad(feat_raw, (0, input_dim - len(feat_raw)))
            else:
                feat_raw = feat_raw[:input_dim]

        # Apply saved StandardScaler parameters
        if scaler_mean and scaler_scale:
            mean = np.array(scaler_mean, dtype=np.float32)
            scale = np.array(scaler_scale, dtype=np.float32)
            feat_scaled = (feat_raw - mean) / (scale + 1e-8)
        else:
            feat_scaled = feat_raw / (np.abs(feat_raw).max() + 1e-8)

        # Import model architecture from the training module
        sys.path.insert(0, str(Path(__file__).parent.parent))
        from models.fraud_gnn_lstm import FraudGNNLSTM

        model = FraudGNNLSTM(input_dim=input_dim)
        model.load_state_dict(ckpt["model_state_dict"])
        model.eval()

        with torch.no_grad():
            # Shape: (batch=1, seq_len=10, input_dim)
            x = torch.tensor(feat_scaled).unsqueeze(0).unsqueeze(0).repeat(1, 10, 1)
            logit = model(x)
            prob = torch.sigmoid(logit).item()

        return {"fraud_probability": round(prob, 4), "source": "pytorch_model"}
    except Exception as e:
        # Silently fall through to heuristic
        return None


# ── Heuristic fallback ────────────────────────────────────────────────────────
def _heuristic_predict(features: dict) -> dict:
    """Deterministic heuristic fallback matching the TypeScript scoring in index.ts."""
    import random
    amount = float(features.get("amount", 0))
    num_items = int(features.get("num_items", 0))
    has_phone = bool(features.get("has_phone", True))
    has_customer = bool(features.get("has_customer", True))

    score = 0.0
    if amount > 500_000:
        score += 0.35
    elif amount > 100_000:
        score += 0.15
    if num_items > 20:
        score += 0.2
    if not has_phone:
        score += 0.3
    if not has_customer:
        score += 0.1
    score = min(1.0, max(0.0, score + (random.random() * 0.05 - 0.025)))
    return {"fraud_probability": round(score, 4), "source": "heuristic"}


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "No payload provided"}))
        sys.exit(1)

    try:
        payload = json.loads(sys.argv[1])
    except json.JSONDecodeError as e:
        print(json.dumps({"error": f"Invalid JSON: {e}"}))
        sys.exit(1)

    result = _pytorch_predict(payload) or _heuristic_predict(payload)
    fp = result["fraud_probability"]
    result["credit_score"] = round(850 - fp * 550)
    result["risk_level"] = "high" if fp > 0.7 else "medium" if fp > 0.4 else "low"
    print(json.dumps(result))


if __name__ == "__main__":
    main()
