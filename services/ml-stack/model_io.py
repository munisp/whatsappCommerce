"""
Shared model loading + feature construction + inference helpers.
=================================================================
Single source of truth used by:
  - inference/server.py   (FastAPI inference server)
  - inference/predict.py  (CLI predictor called by the TS backend)
  - lakehouse/pipeline.py (retraining — saves checkpoints in this format)

Loading rules (CPU only, no CUDA anywhere):
  1. Weights directory: ``MODEL_DIR`` env override if it contains the weight
     file, otherwise ``<repo>/services/ml-stack/models/weights/`` (the
     committed, trained weights).
  2. If an ``.onnx`` sibling of a ``.pt`` checkpoint exists, serve it with
     onnxruntime (CPUExecutionProvider); otherwise reconstruct the torch
     architecture from ``model_defs`` and load the state_dict on CPU.
  3. If neither is loadable, callers fall back to the deterministic heuristic
     in this module, clearly labeled ``source="heuristic-fallback"``.

Checkpoint format (produced by training/train_all.py and lakehouse/pipeline.py):
  {
    "model_state_dict": <state_dict>,
    "scaler_mean":      [float] * input_dim,
    "scaler_scale":     [float] * input_dim,
    "feature_names":    [str] * input_dim,
    "input_dim":        int,
    ...
  }
"""

import logging
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

# Ensure model_defs (same directory) is importable regardless of caller's cwd.
_ML_STACK_DIR = Path(__file__).resolve().parent
if str(_ML_STACK_DIR) not in sys.path:
    sys.path.insert(0, str(_ML_STACK_DIR))

log = logging.getLogger("ml-model-io")

# ── Feature orders (must match training/train_all.py exactly) ─────────────────

FRAUD_FEATURES = [
    "amount_ngn", "hour_of_day", "day_of_week", "is_weekend",
    "is_new_device", "is_vpn", "is_tor",
    "tx_count_1h", "tx_count_24h", "tx_count_7d",
    "tx_amount_1h", "tx_amount_24h",
    "unique_merchants_24h", "avg_amount_7d", "max_amount_7d",
    "time_on_site_sec", "pages_visited", "cart_abandon_rate",
    "days_since_account_creation", "device_age_days",
]

CREDIT_FEATURES = [
    "business_age_months", "monthly_revenue_ngn", "debt_to_revenue_ratio",
    "payment_history_score", "whatsapp_order_count_30d", "avg_order_value_ngn",
    "customer_return_rate", "inventory_turnover_days", "bank_account_age_months",
    "num_product_categories", "has_physical_store", "has_cac_registration",
    "social_media_followers", "whatsapp_response_time_min", "refund_rate",
]

FRAUD_SEQ_LEN = 10  # matches TransactionSequenceDataset(seq_len=10) in training

_REPO_WEIGHTS_DIR = Path(__file__).resolve().parent / "models" / "weights"

# ── CPU-only torch setup ──────────────────────────────────────────────────────

_torch = None


def get_torch():
    """Import torch once, force CPU thread count. Returns the torch module."""
    global _torch
    if _torch is None:
        import torch
        torch.set_num_threads(int(os.getenv("TORCH_NUM_THREADS", "2")))
        _torch = torch
    return _torch


def resolve_weights_dir(weight_file: str = "fraud_gnn_lstm.pt") -> Path:
    """
    Locate the weights directory. ``MODEL_DIR`` env wins if it actually
    contains the weight file; otherwise fall back to the committed repo
    weights under services/ml-stack/models/weights/.
    """
    env_dir = os.getenv("MODEL_DIR")
    if env_dir and (Path(env_dir) / weight_file).exists():
        return Path(env_dir)
    return _REPO_WEIGHTS_DIR


# ── Model loading ─────────────────────────────────────────────────────────────


def _load_onnx(onnx_path: Path):
    """Load an ONNX session pinned to CPU. Returns None on failure."""
    try:
        import onnxruntime as ort
        sess_opts = ort.SessionOptions()
        sess_opts.intra_op_num_threads = int(os.getenv("TORCH_NUM_THREADS", "2"))
        sess_opts.inter_op_num_threads = 1
        sess = ort.InferenceSession(
            str(onnx_path), sess_opts=sess_opts, providers=["CPUExecutionProvider"]
        )
        return sess
    except Exception as e:
        log.warning("Failed to load ONNX model %s: %s", onnx_path, e)
        return None


def _read_checkpoint_meta(pt_path: Path) -> dict:
    """Read scaler/feature metadata from a checkpoint without building a model."""
    torch = get_torch()
    try:
        ckpt = torch.load(str(pt_path), map_location="cpu", weights_only=False)
    except TypeError:  # older torch without weights_only kwarg
        ckpt = torch.load(str(pt_path), map_location="cpu")
    if not isinstance(ckpt, dict):
        return {}
    return ckpt


def load_fraud_bundle(weights_dir: Optional[Path] = None) -> Optional[dict]:
    """
    Load the fraud model (FraudGNNLSTM). Prefers an ONNX sibling when present.
    Returns a bundle dict or None if nothing loadable was found.
    """
    weights_dir = weights_dir or resolve_weights_dir("fraud_gnn_lstm.pt")
    pt_path = weights_dir / "fraud_gnn_lstm.pt"
    onnx_path = weights_dir / "fraud_gnn_lstm.onnx"

    meta: dict = {}
    if pt_path.exists():
        try:
            meta = _read_checkpoint_meta(pt_path)
        except Exception as e:
            log.warning("Failed to read fraud checkpoint %s: %s", pt_path, e)

    if onnx_path.exists():
        sess = _load_onnx(onnx_path)
        if sess is not None:
            log.info("Fraud model loaded (onnxruntime CPU) from %s", onnx_path)
            return {
                "kind": "onnx", "session": sess, "model": None,
                "input_dim": int(meta.get("input_dim", len(FRAUD_FEATURES))),
                "scaler_mean": meta.get("scaler_mean"),
                "scaler_scale": meta.get("scaler_scale"),
                "feature_names": meta.get("feature_names", FRAUD_FEATURES),
                "version": "fraud_gnn_lstm.onnx",
            }

    if pt_path.exists() and meta.get("model_state_dict"):
        try:
            torch = get_torch()
            from model_defs import FraudGNNLSTM
            model = FraudGNNLSTM(input_dim=int(meta.get("input_dim", len(FRAUD_FEATURES))))
            model.load_state_dict(meta["model_state_dict"])
            model.eval()  # CPU by construction (map_location="cpu")
            log.info("Fraud model loaded (torch CPU) from %s", pt_path)
            return {
                "kind": "torch", "model": model, "session": None,
                "input_dim": int(meta.get("input_dim", len(FRAUD_FEATURES))),
                "scaler_mean": meta.get("scaler_mean"),
                "scaler_scale": meta.get("scaler_scale"),
                "feature_names": meta.get("feature_names", FRAUD_FEATURES),
                "version": "fraud_gnn_lstm.pt",
            }
        except Exception as e:
            log.warning("Failed to load fraud torch weights %s: %s", pt_path, e)

    log.warning("No fraud model loadable in %s — heuristic fallback active", weights_dir)
    return None


def load_credit_bundle(weights_dir: Optional[Path] = None) -> Optional[dict]:
    """
    Load the credit model (TabNet). Prefers an ONNX sibling when present.
    Returns a bundle dict or None if nothing loadable was found.
    """
    weights_dir = weights_dir or resolve_weights_dir("credit_tabnet.pt")
    pt_path = weights_dir / "credit_tabnet.pt"
    onnx_path = weights_dir / "credit_tabnet.onnx"

    meta: dict = {}
    if pt_path.exists():
        try:
            meta = _read_checkpoint_meta(pt_path)
        except Exception as e:
            log.warning("Failed to read credit checkpoint %s: %s", pt_path, e)

    if onnx_path.exists():
        sess = _load_onnx(onnx_path)
        if sess is not None:
            log.info("Credit model loaded (onnxruntime CPU) from %s", onnx_path)
            return {
                "kind": "onnx", "session": sess, "model": None,
                "input_dim": int(meta.get("input_dim", len(CREDIT_FEATURES))),
                "scaler_mean": meta.get("scaler_mean"),
                "scaler_scale": meta.get("scaler_scale"),
                "feature_names": meta.get("feature_names", CREDIT_FEATURES),
                "version": "credit_tabnet.onnx",
            }

    if pt_path.exists() and meta.get("model_state_dict"):
        try:
            torch = get_torch()
            from model_defs import TabNet
            model = TabNet(input_dim=int(meta.get("input_dim", len(CREDIT_FEATURES))))
            model.load_state_dict(meta["model_state_dict"])
            model.eval()
            log.info("Credit model loaded (torch CPU) from %s", pt_path)
            return {
                "kind": "torch", "model": model, "session": None,
                "input_dim": int(meta.get("input_dim", len(CREDIT_FEATURES))),
                "scaler_mean": meta.get("scaler_mean"),
                "scaler_scale": meta.get("scaler_scale"),
                "feature_names": meta.get("feature_names", CREDIT_FEATURES),
                "version": "credit_tabnet.pt",
            }
        except Exception as e:
            log.warning("Failed to load credit torch weights %s: %s", pt_path, e)

    log.warning("No credit model loadable in %s — heuristic fallback active", weights_dir)
    return None


# ── Scaling ───────────────────────────────────────────────────────────────────


def apply_scaler(bundle: dict, features: list[float]) -> list[float]:
    """Apply the checkpoint's StandardScaler params; adjust length to input_dim."""
    input_dim = int(bundle.get("input_dim", len(features)))
    feats = list(features[:input_dim])
    if len(feats) < input_dim:
        feats = feats + [0.0] * (input_dim - len(feats))
    mean = bundle.get("scaler_mean")
    scale = bundle.get("scaler_scale")
    if mean and scale and len(mean) == input_dim and len(scale) == input_dim:
        return [(f - m) / (s + 1e-8) for f, m, s in zip(feats, mean, scale)]
    return feats


# ── Feature construction ──────────────────────────────────────────────────────


def _payload_timestamp(payload: dict) -> datetime:
    """
    Transaction time for temporal features. Uses the payload's own timestamp
    when provided ("timestamp" / "created_at", ISO-8601 or epoch seconds);
    falls back to now (a real-time prediction for a transaction happening now).
    """
    raw = payload.get("timestamp") or payload.get("created_at")
    if raw:
        try:
            if isinstance(raw, (int, float)):
                return datetime.fromtimestamp(float(raw), tz=timezone.utc)
            ts = datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
            return ts if ts.tzinfo else ts.replace(tzinfo=timezone.utc)
        except (ValueError, TypeError, OSError):
            pass
    return datetime.now(timezone.utc)


def build_fraud_features(payload: dict) -> list[float]:
    """
    Map a prediction payload to the 20-dim fraud feature vector, in exactly
    the FRAUD_FEATURES order used by training/train_all.py.
    """
    ts = _payload_timestamp(payload)
    amount = float(payload.get("amount", 0) or 0)
    num_items = int(payload.get("num_items", 0) or 0)
    has_customer = bool(payload.get("has_customer", True))
    tx_count_1h = float(payload.get("tx_count_1h", 1) or 0)
    tx_count_24h = float(payload.get("tx_count_24h", 1) or 0)
    tx_count_7d = float(payload.get("tx_count_7d", 1) or 0)
    is_new_device = float(payload.get("is_new_device", 0.0 if has_customer else 1.0))
    is_vpn = float(payload.get("is_vpn", 0.0))
    is_tor = float(payload.get("is_tor", 0.0))
    return [
        amount,                                                        # amount_ngn
        float(ts.hour),                                                # hour_of_day
        float(ts.weekday()),                                           # day_of_week
        1.0 if ts.weekday() >= 5 else 0.0,                            # is_weekend
        is_new_device,                                                 # is_new_device
        is_vpn,                                                        # is_vpn
        is_tor,                                                        # is_tor
        tx_count_1h,                                                   # tx_count_1h
        tx_count_24h,                                                  # tx_count_24h
        tx_count_7d,                                                   # tx_count_7d
        amount * tx_count_1h,                                          # tx_amount_1h
        amount * tx_count_24h,                                         # tx_amount_24h
        float(payload.get("unique_merchants_24h", 1)),                # unique_merchants_24h
        float(payload.get("avg_amount_7d", amount) or 0),             # avg_amount_7d
        float(payload.get("max_amount_7d", amount) or 0),             # max_amount_7d
        float(payload.get("time_on_site_sec", 0) or 0),               # time_on_site_sec
        float(payload.get("pages_visited", num_items) or 0),          # pages_visited
        float(payload.get("cart_abandon_rate",
                          0.0 if num_items > 0 else 1.0)),            # cart_abandon_rate
        float(payload.get("days_since_account_creation",
                          30.0 if has_customer else 0.0)),            # days_since_account_creation
        float(payload.get("device_age_days", 30.0 if has_customer else 0.0)),  # device_age_days
    ]


def build_credit_features(payload: dict) -> list[float]:
    """
    Map a prediction payload to the 15-dim credit feature vector, in exactly
    the CREDIT_FEATURES order used by training/train_all.py. Fields not
    present in a transaction payload take deterministic neutral defaults.
    """
    amount = float(payload.get("amount", 0) or 0)
    tx_count_7d = float(payload.get("tx_count_7d", 1) or 0)
    tx_count_24h = float(payload.get("tx_count_24h", 1) or 0)
    avg_amount = float(payload.get("avg_amount_7d", amount) or 0)
    days_account = float(payload.get("days_since_account_creation",
                                     30.0 if payload.get("has_customer", True) else 0.0))
    g = lambda k, d: float(payload.get(k, d) or 0)  # noqa: E731
    return [
        g("business_age_months", max(days_account / 30.0, 0.0)),   # business_age_months
        g("monthly_revenue_ngn", avg_amount * tx_count_7d * 4.0),  # monthly_revenue_ngn (proxy)
        g("debt_to_revenue_ratio", 0.0),                           # debt_to_revenue_ratio
        g("payment_history_score", 650.0),                         # payment_history_score
        g("whatsapp_order_count_30d", tx_count_7d * 4.0 + tx_count_24h),  # whatsapp_order_count_30d
        g("avg_order_value_ngn", avg_amount),                      # avg_order_value_ngn
        g("customer_return_rate", 0.5),                            # customer_return_rate
        g("inventory_turnover_days", 30.0),                        # inventory_turnover_days
        g("bank_account_age_months", max(days_account / 30.0, 0.0)),  # bank_account_age_months
        g("num_product_categories", 1.0),                          # num_product_categories
        g("has_physical_store", 0.0),                              # has_physical_store
        g("has_cac_registration", 0.0),                            # has_cac_registration
        g("social_media_followers", 0.0),                          # social_media_followers
        g("whatsapp_response_time_min", 30.0),                     # whatsapp_response_time_min
        g("refund_rate", 0.0),                                     # refund_rate
    ]


# ── Inference ─────────────────────────────────────────────────────────────────


def predict_fraud_proba(bundle: dict, features: list[float]) -> float:
    """Run the loaded fraud model on CPU. Returns probability in [0, 1]."""
    import numpy as np
    scaled = np.array(apply_scaler(bundle, features), dtype=np.float32)
    if bundle["kind"] == "onnx":
        sess = bundle["session"]
        x = np.tile(scaled, (1, FRAUD_SEQ_LEN, 1))  # (1, seq_len, input_dim)
        out = sess.run(None, {sess.get_inputs()[0].name: x})
        logit = float(np.asarray(out[0]).reshape(-1)[0])
        return float(1.0 / (1.0 + np.exp(-logit)))
    torch = get_torch()
    with torch.no_grad():
        # Batch=2 (row duplicated) so the model takes its BatchNorm branch,
        # matching training-time / ONNX-exported behavior; take row 0.
        x = torch.tensor(scaled).unsqueeze(0).unsqueeze(0).repeat(2, FRAUD_SEQ_LEN, 1)
        logit = bundle["model"](x)[0]
        return float(torch.sigmoid(logit).item())


def predict_default_proba(bundle: dict, features: list[float]) -> float:
    """Run the loaded credit model on CPU. Returns default probability in [0, 1]."""
    import numpy as np
    scaled = np.array(apply_scaler(bundle, features), dtype=np.float32)
    if bundle["kind"] == "onnx":
        sess = bundle["session"]
        out = sess.run(None, {sess.get_inputs()[0].name: scaled.reshape(1, -1)})
        logit = float(np.asarray(out[0]).reshape(-1)[0])
        return float(1.0 / (1.0 + np.exp(-logit)))
    torch = get_torch()
    with torch.no_grad():
        logits, _ = bundle["model"](torch.tensor(scaled).unsqueeze(0))
        logit = logits.reshape(-1)[0]
        return float(torch.sigmoid(logit).item())


def risk_level(prob: float) -> str:
    return "low" if prob < 0.3 else ("medium" if prob < 0.6 else "high")


def credit_score_from_default_prob(default_prob: float) -> tuple[int, str]:
    """Map default probability to a 300-850 credit score and letter grade."""
    score = max(300, min(850, int(round(850 - default_prob * 550))))
    grade = "A" if score >= 750 else ("B" if score >= 650 else ("C" if score >= 550 else "D"))
    return score, grade


# ── Deterministic heuristic fallbacks (labeled, no randomness) ────────────────


def heuristic_fraud_score(features: list[float]) -> tuple[float, str]:
    """Deterministic rule-based fraud scoring when no ML model is loadable."""
    amount = features[0]
    hour = features[1]
    is_new_device = features[4]
    is_vpn = features[5]
    is_tor = features[6]
    tx_count_1h = features[7]
    cart_abandon = features[17]
    days_account = features[18]

    score = 0.0
    if amount > 500_000 and (hour < 6 or hour > 22):
        score += 0.3
    if is_vpn > 0.5:
        score += 0.2
    if is_tor > 0.5:
        score += 0.4
    if is_new_device > 0.5 and days_account < 7:
        score += 0.25
    if tx_count_1h > 5:
        score += 0.2
    if amount > 2_000_000:
        score += 0.15
    if cart_abandon > 0.8:
        score += 0.05

    score = min(score, 1.0)
    return score, risk_level(score)


def heuristic_credit_score(features: list[float]) -> tuple[int, str]:
    """Deterministic rule-based credit score when no ML model is loadable."""
    amount = features[0]
    is_vpn = features[5]
    is_tor = features[6]
    tx_count_7d = features[9]
    days_account = features[18]
    device_age = features[19]

    base = 650.0
    base += min(days_account * 0.5, 100)
    base += min(tx_count_7d * 5, 50)
    base += min(device_age * 0.2, 30)
    base -= min(amount / 100_000, 50)
    if is_vpn > 0.5:
        base -= 30
    if is_tor > 0.5:
        base -= 80

    score = max(300, min(850, int(base)))
    grade = "A" if score >= 750 else ("B" if score >= 650 else ("C" if score >= 550 else "D"))
    return score, grade
