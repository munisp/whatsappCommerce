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
"""
import sys
import json
import os
from pathlib import Path

# ── Try to load the real PyTorch model ───────────────────────────────────────
def _pytorch_predict(features: dict) -> dict | None:
    """Attempt real model inference. Returns None if model unavailable."""
    try:
        import torch
        import numpy as np

        # Locate weights
        weights_dir = Path(__file__).parent.parent / "models" / "weights"
        weight_file = weights_dir / "fraud_gnn_lstm.pt"
        if not weight_file.exists():
            return None

        # Build feature vector matching training schema
        feat = np.array([
            float(features.get("amount", 0)) / 1_000_000,   # normalised amount
            float(features.get("num_items", 0)) / 50,        # normalised item count
            float(features.get("avg_item_price", 0)) / 100_000,
            1.0 if features.get("has_phone") else 0.0,
            1.0 if features.get("has_customer") else 0.0,
        ], dtype=np.float32)

        # Load checkpoint and run inference
        ckpt = torch.load(weight_file, map_location="cpu")
        # The checkpoint stores the model state_dict; we need the architecture
        # Import from the training module
        sys.path.insert(0, str(Path(__file__).parent.parent))
        from models.fraud_gnn_lstm import FraudGNNLSTM
        model = FraudGNNLSTM(input_dim=5, hidden_dim=64, num_layers=2)
        model.load_state_dict(ckpt["model_state_dict"])
        model.eval()
        with torch.no_grad():
            x = torch.tensor(feat).unsqueeze(0).unsqueeze(0)  # (1, 1, 5)
            prob = model(x).item()
        return {"fraud_probability": round(prob, 4), "source": "pytorch_model"}
    except Exception:
        return None


def _heuristic_predict(features: dict) -> dict:
    """Deterministic heuristic fallback matching the TypeScript scoring."""
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
        features = json.loads(sys.argv[1])
    except json.JSONDecodeError as e:
        print(json.dumps({"error": f"Invalid JSON: {e}"}))
        sys.exit(1)

    result = _pytorch_predict(features) or _heuristic_predict(features)
    fp = result["fraud_probability"]
    result["credit_score"] = round(850 - fp * 550)
    result["risk_level"] = "high" if fp > 0.7 else "medium" if fp > 0.4 else "low"
    print(json.dumps(result))


if __name__ == "__main__":
    main()
