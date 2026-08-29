#!/usr/bin/env python3
"""
Lakehouse Pipeline Runner — WhatsApp Commerce Platform
======================================================
Orchestrates the full data pipeline (CPU only):
  1. ETL: Extract from PostgreSQL, load to Parquet (Bronze layer)
  2. Feature Engineering: Transform to feature store (Silver layer)
  3. Model Training: Train/retrain ML models on latest features (Gold layer)
     - Fraud: FraudGNNLSTM (architecture shared with the inference server via
       services/ml-stack/model_defs.py), saved as a state_dict checkpoint
       compatible with training/train_all.py + exported to ONNX.
     - Credit: TabNet trained on per-tenant aggregates, saved the same way.
  4. Model Export: torch.onnx.export → CPU onnxruntime serving.

All pipeline runs are logged to lakehouse_pipeline_runs in PostgreSQL.
Triggered by:
  - POST /lakehouse/trigger on the ML inference server (runs this file as a
    subprocess)
  - Scheduled cron (via Temporal workflow or cron job)
  - Manual trigger from admin dashboard / CLI:
        python3 pipeline.py [etl|feature_engineering|model_training|full] [tenant_id]
"""

import json
import logging
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import psycopg2
import psycopg2.extras

# Shared model architectures / feature orders (services/ml-stack/model_defs.py)
_ML_STACK_DIR = Path(__file__).resolve().parent.parent
if str(_ML_STACK_DIR) not in sys.path:
    sys.path.insert(0, str(_ML_STACK_DIR))

import model_io  # noqa: E402  (FRAUD_FEATURES, CREDIT_FEATURES, FRAUD_SEQ_LEN)

# === W35 otel-ml-stack === lazy fail-open OTel (stdlib-safe import).
try:
    import telemetry as _ml_telemetry  # services/ml-stack/telemetry.py
except Exception:  # pragma: no cover - fail-open
    _ml_telemetry = None
# === END W35 otel-ml-stack ===

log = logging.getLogger("lakehouse-pipeline")
logging.basicConfig(level=logging.INFO,
                    format='{"ts":"%(asctime)s","level":"%(levelname)s","msg":"%(message)s"}')

DATABASE_URL = os.getenv("DATABASE_URL", "postgresql://wc_user:wc_secret@localhost:5432/whatsapp_commerce")
DATA_DIR = Path(os.getenv("DATA_DIR", str(_ML_STACK_DIR / "data" / "lakehouse")))
PLATFORM_API_URL = os.getenv("PLATFORM_API_URL", "http://localhost:3000")
PLATFORM_API_KEY = os.getenv("PLATFORM_API_KEY", "")

# Where trained weights are written. Default: the committed repo weights dir
# that the inference server loads from. Override with WEIGHTS_DIR (or MODEL_DIR).
WEIGHTS_DIR = Path(os.getenv("WEIGHTS_DIR") or os.getenv("MODEL_DIR")
                   or str(_ML_STACK_DIR / "models" / "weights"))

DATA_DIR.mkdir(parents=True, exist_ok=True)
WEIGHTS_DIR.mkdir(parents=True, exist_ok=True)

FRAUD_TRAIN_EPOCHS = int(os.getenv("FRAUD_TRAIN_EPOCHS", "15"))
CREDIT_TRAIN_EPOCHS = int(os.getenv("CREDIT_TRAIN_EPOCHS", "20"))
MIN_TRAIN_SAMPLES = int(os.getenv("MIN_TRAIN_SAMPLES", "100"))
MIN_CREDIT_TENANTS = int(os.getenv("MIN_CREDIT_TENANTS", "10"))

# Fraud-label proxy: a payment is labeled fraudulent when it failed, or when a
# chargeback/dispute signal is present in metadata or the failure reason.
# (payment_intents has no explicit is_fraud column — see drizzle/schema.ts;
# statuses are initiated/pending/completed/failed/cancelled/refunded.)
FRAUD_FAILURE_REASON_KEYWORDS = ("fraud", "chargeback", "dispute", "stolen")
FRAUD_METADATA_FLAGS = ("chargeback", "dispute", "is_fraud", "fraud")


def get_db():
    try:
        return psycopg2.connect(DATABASE_URL, cursor_factory=psycopg2.extras.RealDictCursor)
    except Exception as e:
        log.warning("DB connection failed: %s", e)
        return None


def log_run_start(pipeline_type: str, stage: str) -> Optional[str]:
    conn = get_db()
    if not conn:
        return None
    try:
        cur = conn.cursor()
        cur.execute(
            """INSERT INTO lakehouse_pipeline_runs
               (id, pipeline_type, stage, status, started_at)
               VALUES (gen_random_uuid(), %s, %s, 'running', NOW())
               RETURNING id::text""",
            (pipeline_type, stage)
        )
        row = cur.fetchone()
        conn.commit()
        return row["id"] if row else None
    finally:
        conn.close()


def log_run_complete(run_id: str, status: str, records_extracted: int = 0,
                     records_loaded: int = 0, features_written: int = 0,
                     model_version: str = None, duration_ms: int = None,
                     error_msg: str = None, metadata: dict = None):
    conn = get_db()
    if not conn:
        return
    try:
        cur = conn.cursor()
        cur.execute(
            """UPDATE lakehouse_pipeline_runs SET
               status = %s, records_extracted = %s, records_loaded = %s,
               features_written = %s, model_version = %s, duration_ms = %s,
               error_msg = %s, metadata = %s, completed_at = NOW()
               WHERE id = %s::uuid""",
            (status, records_extracted, records_loaded, features_written,
             model_version, duration_ms, error_msg,
             json.dumps(metadata) if metadata else None, run_id)
        )
        conn.commit()
    finally:
        conn.close()


def _parse_ts(value) -> Optional[datetime]:
    """Parse a createdAt value coming from psycopg2 (datetime) or JSON (str)."""
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if value:
        try:
            ts = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
            return ts if ts.tzinfo else ts.replace(tzinfo=timezone.utc)
        except (ValueError, TypeError):
            return None
    return None


def _fraud_label(row: dict) -> int:
    """
    Defensible fraud proxy label for payment_intents:
      1 if the payment failed, or a chargeback/dispute/fraud flag is present
      in the metadata JSON or the provider failure reason; else 0.
    """
    if str(row.get("status", "")).lower() == "failed":
        return 1
    metadata = row.get("metadata")
    if isinstance(metadata, str):
        try:
            metadata = json.loads(metadata)
        except json.JSONDecodeError:
            metadata = None
    if isinstance(metadata, dict):
        for flag in FRAUD_METADATA_FLAGS:
            val = metadata.get(flag)
            if val is True or str(val).lower() in ("true", "1", "yes"):
                return 1
    reason = str(row.get("failureReason") or "").lower()
    if any(kw in reason for kw in FRAUD_FAILURE_REASON_KEYWORDS):
        return 1
    return 0


# ── ETL Stage: Extract from PostgreSQL → Parquet ──────────────────────────────

def run_etl(tenant_id: Optional[str] = None) -> dict:
    """Extract payment_intents and orders from PostgreSQL, save as Parquet."""
    t0 = time.time()
    run_id = log_run_start("etl", "extract")
    conn = get_db()
    records = 0

    if not conn:
        if run_id:
            log_run_complete(run_id, "failed", error_msg="no_db_connection")
        return {"status": "failed", "error": "no_db_connection"}

    try:
        cur = conn.cursor()
        # Extract payment intents (incl. fields needed for the fraud-label proxy)
        query = """
            SELECT pi.id, pi."tenantId", pi."orderId", pi."customerId",
                   pi.amount, pi.currency, pi.status, pi.provider,
                   pi."failureReason", pi.metadata, pi."createdAt",
                   o."totalAmount"
            FROM payment_intents pi
            LEFT JOIN orders o ON o.id = pi."orderId"
            WHERE pi."createdAt" > NOW() - INTERVAL '30 days'
        """
        params = []
        if tenant_id:
            query += ' AND pi."tenantId" = %s'
            params.append(tenant_id)
        query += " LIMIT 100000"

        cur.execute(query, params)
        rows = cur.fetchall()
        records = len(rows)

        # Save to Parquet (using pandas if available, else JSON)
        try:
            import pandas as pd
            df = pd.DataFrame([dict(r) for r in rows])
            parquet_path = DATA_DIR / "bronze" / "payment_intents.parquet"
            parquet_path.parent.mkdir(parents=True, exist_ok=True)
            df.to_parquet(str(parquet_path), index=False)
            log.info("ETL: saved %d records to %s", records, parquet_path)
        except ImportError:
            # Fallback to JSON
            json_path = DATA_DIR / "bronze" / "payment_intents.json"
            json_path.parent.mkdir(parents=True, exist_ok=True)
            with open(json_path, "w") as f:
                json.dump([dict(r) for r in rows], f, default=str)
            log.info("ETL: saved %d records to %s (JSON fallback)", records, json_path)

    except Exception as e:
        log.error("ETL extract failed: %s", e)
        if run_id:
            log_run_complete(run_id, "failed", error_msg=str(e))
        return {"status": "failed", "error": str(e)}
    finally:
        conn.close()

    duration_ms = int((time.time() - t0) * 1000)
    if run_id:
        log_run_complete(run_id, "completed", records_extracted=records,
                         records_loaded=records, duration_ms=duration_ms)
    return {"status": "completed", "records": records, "duration_ms": duration_ms}


# ── Feature Engineering Stage ─────────────────────────────────────────────────

def run_feature_engineering() -> dict:
    """Transform raw data into ML features (Silver layer)."""
    t0 = time.time()
    run_id = log_run_start("feature_engineering", "transform")
    features_written = 0

    try:
        bronze_path = DATA_DIR / "bronze" / "payment_intents.parquet"
        bronze_json = DATA_DIR / "bronze" / "payment_intents.json"

        rows = []
        if bronze_path.exists():
            try:
                import pandas as pd
                df = pd.read_parquet(str(bronze_path))
                rows = df.to_dict("records")
            except ImportError:
                pass

        if not rows and bronze_json.exists():
            with open(bronze_json) as f:
                rows = json.load(f)

        if not rows:
            log.warning("No bronze data found for feature engineering")
            if run_id:
                log_run_complete(run_id, "partial", error_msg="no_bronze_data")
            return {"status": "partial", "features_written": 0}

        # Build feature rows. Temporal features derive from the TRANSACTION's
        # own createdAt — never from datetime.now() at transform time.
        features = []
        for row in rows:
            amount = float(row.get("amount", 0) or 0)
            created_at = _parse_ts(row.get("createdAt"))
            features.append({
                "id": str(row.get("id", "")),
                "tenant_id": str(row.get("tenantId", "")),
                "customer_id": str(row.get("customerId", "")),
                "amount_ngn": amount,
                "created_at": created_at.isoformat() if created_at else None,
                "hour_of_day": created_at.hour if created_at else None,
                "day_of_week": created_at.weekday() if created_at else None,
                "is_weekend": (1 if created_at.weekday() >= 5 else 0) if created_at else None,
                "status": str(row.get("status", "")),
                "label": _fraud_label(row),
            })

        # Save feature store
        silver_path = DATA_DIR / "silver" / "features.json"
        silver_path.parent.mkdir(parents=True, exist_ok=True)
        with open(silver_path, "w") as f:
            json.dump(features, f, default=str)
        features_written = len(features)
        log.info("Feature engineering: %d features written (%d fraud-labeled)",
                 features_written, sum(f["label"] for f in features))

    except Exception as e:
        log.error("Feature engineering failed: %s", e)
        if run_id:
            log_run_complete(run_id, "failed", error_msg=str(e))
        return {"status": "failed", "error": str(e)}

    duration_ms = int((time.time() - t0) * 1000)
    if run_id:
        log_run_complete(run_id, "completed", features_written=features_written,
                         duration_ms=duration_ms)
    return {"status": "completed", "features_written": features_written, "duration_ms": duration_ms}


# ── Model export helper ───────────────────────────────────────────────────────

class _LogitsOnly:
    """Wrap models whose forward returns (logits, aux) so ONNX exports logits only."""

    @staticmethod
    def wrap(model):
        import torch.nn as nn

        class _Wrapper(nn.Module):
            def __init__(self, inner):
                super().__init__()
                self.inner = inner

            def forward(self, x):
                out = self.inner(x)
                return out[0] if isinstance(out, (tuple, list)) else out

        wrapped = _Wrapper(model)
        wrapped.eval()
        return wrapped


def _export_onnx(model, dummy_input, onnx_path: Path, input_name: str = "features") -> bool:
    """Export a torch model to ONNX for CPU onnxruntime serving. Best-effort."""
    try:
        import torch
        model.eval()
        torch.onnx.export(
            _LogitsOnly.wrap(model), dummy_input, str(onnx_path),
            input_names=[input_name], output_names=["logits"],
            dynamic_axes={input_name: {0: "batch"}, "logits": {0: "batch"}},
            opset_version=17,
            # Pin the legacy TorchScript exporter: torch>=2.9 defaults
            # dynamo=True, which emits graphs onnxruntime rejects (e.g.
            # Split with num_outputs attr at opset 17). dynamo=False is
            # supported since torch 2.5 (our pin), so this is safe there.
            dynamo=False,
        )
        log.info("ONNX export written to %s", onnx_path)
        return True
    except Exception as e:
        log.warning("ONNX export failed for %s: %s (torch .pt checkpoint still saved)", onnx_path, e)
        return False


# ── Model Training Stage ──────────────────────────────────────────────────────

def _fraud_feature_vector(f: dict) -> list[float]:
    """
    Build the 20-dim vector in exact FRAUD_FEATURES order (see
    training/train_all.py). Fields not available in the silver feature store
    use the same deterministic defaults as inference-time imputation.
    """
    amount = float(f.get("amount_ngn", 0) or 0)
    hour = f.get("hour_of_day")
    dow = f.get("day_of_week")
    weekend = f.get("is_weekend")
    return [
        amount,
        float(hour) if hour is not None else 12.0,
        float(dow) if dow is not None else 2.0,
        float(weekend) if weekend is not None else 0.0,
        0.0, 0.0, 0.0,                 # is_new_device, is_vpn, is_tor (unknown)
        1.0, 1.0, 1.0,                 # tx_count_1h, tx_count_24h, tx_count_7d
        amount, amount,                # tx_amount_1h, tx_amount_24h
        1.0,                           # unique_merchants_24h
        amount, amount,                # avg_amount_7d, max_amount_7d
        0.0, 1.0, 0.0,                 # time_on_site_sec, pages_visited, cart_abandon_rate
        30.0, 30.0,                    # days_since_account_creation, device_age_days
    ]


def _train_fraud_model(features: list[dict], model_version: str) -> dict:
    """
    Train FraudGNNLSTM on silver features (CPU) and save a checkpoint that is
    byte-compatible with what the inference server loads (same format as
    training/train_all.py), plus an ONNX sibling for onnxruntime serving.
    """
    import numpy as np
    import torch
    import torch.nn as nn
    from sklearn.preprocessing import StandardScaler

    from model_defs import FraudGNNLSTM

    torch.set_num_threads(int(os.getenv("TORCH_NUM_THREADS", "2")))

    X = np.array([_fraud_feature_vector(f) for f in features], dtype=np.float32)
    y = np.array([int(f.get("label", 0)) for f in features], dtype=np.float32)

    fraud_rate = float(y.mean())
    if fraud_rate == 0.0 or fraud_rate == 1.0:
        return {"status": "partial", "reason": "single_class_labels",
                "fraud_rate": fraud_rate}

    scaler = StandardScaler()
    X_scaled = scaler.fit_transform(X).astype(np.float32)

    input_dim = X_scaled.shape[1]
    seq = torch.tensor(X_scaled).unsqueeze(1).repeat(1, model_io.FRAUD_SEQ_LEN, 1)
    labels = torch.tensor(y)
    model = FraudGNNLSTM(input_dim=input_dim)
    optimizer = torch.optim.AdamW(model.parameters(), lr=1e-3, weight_decay=1e-4)
    pos_weight = torch.tensor([(1.0 - fraud_rate) / fraud_rate])
    criterion = nn.BCEWithLogitsLoss(pos_weight=pos_weight)

    batch_size = 64
    n = seq.shape[0]
    model.train()
    for epoch in range(FRAUD_TRAIN_EPOCHS):
        perm = torch.randperm(n)
        epoch_loss = 0.0
        for i in range(0, n, batch_size):
            idx = perm[i:i + batch_size]
            if idx.numel() < 2:
                continue  # BatchNorm layers require batch > 1 in train mode
            optimizer.zero_grad()
            logits = model(seq[idx])
            loss = criterion(logits, labels[idx])
            loss.backward()
            nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            optimizer.step()
            epoch_loss += loss.item()
        if epoch % 5 == 0:
            log.info("Fraud training epoch %d/%d loss=%.4f", epoch, FRAUD_TRAIN_EPOCHS, epoch_loss)

    model.eval()
    weight_path = WEIGHTS_DIR / "fraud_gnn_lstm.pt"
    torch.save({
        "model_state_dict": model.state_dict(),
        "scaler_mean": scaler.mean_.tolist(),
        "scaler_scale": scaler.scale_.tolist(),
        "feature_names": list(model_io.FRAUD_FEATURES),
        "trained_on": "lakehouse_payment_intents",
        "label_proxy": "status==failed OR chargeback/dispute flags",
        "samples": int(n),
        "fraud_rate": fraud_rate,
        "model_version": model_version,
        "input_dim": int(input_dim),
    }, str(weight_path))
    log.info("Fraud model saved to %s (version=%s, samples=%d)", weight_path, model_version, n)

    # Batch=2 dummy so traced BatchNorm branch matches eval-time behavior
    dummy = torch.zeros(2, model_io.FRAUD_SEQ_LEN, input_dim)
    onnx_ok = _export_onnx(model, dummy, WEIGHTS_DIR / "fraud_gnn_lstm.onnx",
                           input_name="sequence")

    return {"status": "completed", "samples": int(n), "fraud_rate": fraud_rate,
            "weight_path": str(weight_path), "onnx": onnx_ok}


def _credit_aggregates(features: list[dict]) -> list[dict]:
    """
    Aggregate silver payment features into per-tenant credit features in exact
    CREDIT_FEATURES order. Label proxy for is_default_90d: tenants whose
    payment failure rate exceeds 50% or whose refund/dispute-like label rate
    exceeds 30% are treated as defaulting. Deterministic, documented proxy.
    """
    tenants: dict[str, list[dict]] = {}
    for f in features:
        tenants.setdefault(f.get("tenant_id") or "unknown", []).append(f)

    rows = []
    for tenant_id, txs in tenants.items():
        amounts = [float(t.get("amount_ngn", 0) or 0) for t in txs]
        n_tx = len(txs)
        completed = [t for t in txs if t.get("status") == "completed"]
        failed = [t for t in txs if t.get("status") == "failed"]
        fraud_labeled = [t for t in txs if int(t.get("label", 0)) == 1]
        customers = {t.get("customer_id") for t in txs if t.get("customer_id")}

        timestamps = [_parse_ts(t.get("created_at")) for t in txs]
        timestamps = [t for t in timestamps if t]
        now = datetime.now(timezone.utc)
        first_seen = min(timestamps) if timestamps else now
        age_months = max((now - first_seen).days / 30.0, 1.0)

        revenue = sum(float(t.get("amount_ngn", 0) or 0) for t in completed)
        fail_rate = len(failed) / n_tx if n_tx else 0.0
        fraud_rate = len(fraud_labeled) / n_tx if n_tx else 0.0

        rows.append({
            "tenant_id": tenant_id,
            "features": [
                age_months,                                   # business_age_months
                revenue / age_months,                         # monthly_revenue_ngn
                0.0,                                          # debt_to_revenue_ratio (unknown)
                300.0 + 550.0 * (1.0 - fail_rate),            # payment_history_score
                float(n_tx),                                  # whatsapp_order_count_30d
                (sum(amounts) / n_tx) if n_tx else 0.0,       # avg_order_value_ngn
                (len(customers) / n_tx) if n_tx else 0.0,     # customer_return_rate (proxy)
                30.0,                                         # inventory_turnover_days (default)
                age_months,                                   # bank_account_age_months (proxy)
                1.0,                                          # num_product_categories (default)
                0.0,                                          # has_physical_store (unknown)
                0.0,                                          # has_cac_registration (unknown)
                0.0,                                          # social_media_followers (unknown)
                30.0,                                         # whatsapp_response_time_min (default)
                fraud_rate,                                   # refund_rate (proxy: dispute-like rate)
            ],
            "label": 1 if (fail_rate > 0.5 or fraud_rate > 0.3) else 0,
        })
    return rows


def _train_credit_model(features: list[dict], model_version: str) -> dict:
    """
    Train TabNet on per-tenant credit aggregates (CPU) and save a checkpoint
    in the exact format the inference server loads, plus an ONNX sibling.
    """
    import numpy as np
    import torch
    import torch.nn as nn
    from sklearn.preprocessing import StandardScaler

    from model_defs import TabNet

    torch.set_num_threads(int(os.getenv("TORCH_NUM_THREADS", "2")))

    rows = _credit_aggregates(features)
    if len(rows) < MIN_CREDIT_TENANTS:
        return {"status": "partial", "reason": "insufficient_tenants",
                "tenants": len(rows)}

    X = np.array([r["features"] for r in rows], dtype=np.float32)
    y = np.array([r["label"] for r in rows], dtype=np.float32)
    default_rate = float(y.mean())
    if default_rate == 0.0 or default_rate == 1.0:
        return {"status": "partial", "reason": "single_class_labels",
                "default_rate": default_rate}

    scaler = StandardScaler()
    X_scaled = scaler.fit_transform(X).astype(np.float32)

    input_dim = X_scaled.shape[1]
    X_t = torch.tensor(X_scaled)
    y_t = torch.tensor(y)

    model = TabNet(input_dim=input_dim)
    optimizer = torch.optim.Adam(model.parameters(), lr=2e-3)
    pos_weight = torch.tensor([(1.0 - default_rate) / default_rate])
    criterion = nn.BCEWithLogitsLoss(pos_weight=pos_weight)

    batch_size = min(32, len(rows))
    model.train()
    for epoch in range(CREDIT_TRAIN_EPOCHS):
        perm = torch.randperm(len(rows))
        for i in range(0, len(rows), batch_size):
            idx = perm[i:i + batch_size]
            if idx.numel() < 2:
                continue  # BatchNorm layers require batch > 1 in train mode
            optimizer.zero_grad()
            logits, entropy_loss = model(X_t[idx])
            loss = criterion(logits, y_t[idx]) + entropy_loss
            loss.backward()
            optimizer.step()
        if epoch % 10 == 0:
            log.info("Credit training epoch %d/%d", epoch, CREDIT_TRAIN_EPOCHS)

    model.eval()
    weight_path = WEIGHTS_DIR / "credit_tabnet.pt"
    torch.save({
        "model_state_dict": model.state_dict(),
        "scaler_mean": scaler.mean_.tolist(),
        "scaler_scale": scaler.scale_.tolist(),
        "feature_names": list(model_io.CREDIT_FEATURES),
        "trained_on": "lakehouse_tenant_aggregates",
        "label_proxy": "fail_rate>0.5 OR dispute_like_rate>0.3",
        "tenants": len(rows),
        "default_rate": default_rate,
        "model_version": model_version,
        "input_dim": int(input_dim),
    }, str(weight_path))
    log.info("Credit model saved to %s (version=%s, tenants=%d)", weight_path, model_version, len(rows))

    dummy = torch.zeros(2, input_dim)
    onnx_ok = _export_onnx(model, dummy, WEIGHTS_DIR / "credit_tabnet.onnx")

    return {"status": "completed", "tenants": len(rows), "default_rate": default_rate,
            "weight_path": str(weight_path), "onnx": onnx_ok}


def run_model_training() -> dict:
    """Train/retrain the fraud + credit models on the latest silver features."""
    t0 = time.time()
    run_id = log_run_start("model_training", "train")
    model_version = f"v{int(time.time())}"

    try:
        silver_path = DATA_DIR / "silver" / "features.json"
        if not silver_path.exists():
            log.warning("No silver features found — skipping training")
            if run_id:
                log_run_complete(run_id, "partial", error_msg="no_features")
            return {"status": "partial", "reason": "no_features"}

        with open(silver_path) as f:
            features = json.load(f)

        if len(features) < MIN_TRAIN_SAMPLES:
            log.warning("Insufficient training data (%d samples)", len(features))
            if run_id:
                log_run_complete(run_id, "partial", error_msg=f"insufficient_data_{len(features)}")
            return {"status": "partial", "reason": "insufficient_data", "samples": len(features)}

        try:
            import torch  # noqa: F401
        except ImportError:
            log.warning("PyTorch not available — cannot train models")
            if run_id:
                log_run_complete(run_id, "failed", error_msg="torch_not_installed")
            return {"status": "failed", "error": "torch_not_installed"}

        fraud_result = _train_fraud_model(features, model_version)
        credit_result = _train_credit_model(features, model_version)

        statuses = {fraud_result["status"], credit_result["status"]}
        if statuses == {"completed"}:
            overall = "completed"
        elif "completed" in statuses:
            overall = "partial"
        elif "failed" in statuses:
            overall = "failed"
        else:
            overall = "partial"

    except Exception as e:
        log.error("Model training failed: %s", e)
        if run_id:
            log_run_complete(run_id, "failed", error_msg=str(e))
        return {"status": "failed", "error": str(e)}

    duration_ms = int((time.time() - t0) * 1000)
    if run_id:
        log_run_complete(run_id, overall, model_version=model_version,
                         records_extracted=len(features), duration_ms=duration_ms,
                         metadata={"fraud": fraud_result, "credit": credit_result})
    return {"status": overall, "model_version": model_version,
            "fraud": fraud_result, "credit": credit_result,
            "samples": len(features), "duration_ms": duration_ms}


# ── Full pipeline + trigger entry points ──────────────────────────────────────

def run_full_pipeline(tenant_id: Optional[str] = None) -> dict:
    """Run the complete ETL → Feature Engineering → Training pipeline."""
    log.info("Starting full lakehouse pipeline (tenant=%s)", tenant_id or "all")
    # === W35 otel-ml-stack === lakehouse.pipeline.run span (fail-open).
    if _ml_telemetry is not None:
        with _ml_telemetry.ml_span("lakehouse.pipeline.run",
                                   {"tenant.id": tenant_id or "all",
                                    "pipeline.type": "full"}):
            return _run_full_pipeline_body(tenant_id)
    return _run_full_pipeline_body(tenant_id)
    # === END W35 otel-ml-stack ===


def _run_full_pipeline_body(tenant_id: Optional[str] = None) -> dict:
    results = {}

    etl = run_etl(tenant_id)
    results["etl"] = etl
    if etl["status"] == "failed":
        return {"status": "failed", "stage": "etl", "results": results}

    fe = run_feature_engineering()
    results["feature_engineering"] = fe
    if fe["status"] == "failed":
        return {"status": "failed", "stage": "feature_engineering", "results": results}

    training = run_model_training()
    results["model_training"] = training

    overall = "completed" if training["status"] == "completed" else "partial"
    log.info("Full pipeline complete: %s", overall)
    return {"status": overall, "results": results}


def trigger_pipeline(pipeline_type: str = "full", tenant_id: Optional[str] = None) -> dict:
    """
    Programmatic trigger (also used by the inference server, which invokes
    this module as a subprocess). Returns the pipeline result dict.
    """
    if pipeline_type == "etl":
        return run_etl(tenant_id)
    if pipeline_type == "feature_engineering":
        return run_feature_engineering()
    if pipeline_type == "model_training":
        return run_model_training()
    return run_full_pipeline(tenant_id)


if __name__ == "__main__":
    # === W35 otel-ml-stack === init (no-op unless OTEL_ENABLED=true).
    if _ml_telemetry is not None:
        _ml_telemetry.init_telemetry(service_name="lakehouse-pipeline")
    # === END W35 otel-ml-stack ===
    pipeline_type = sys.argv[1] if len(sys.argv) > 1 else "full"
    tenant_id = sys.argv[2] if len(sys.argv) > 2 else None
    result = trigger_pipeline(pipeline_type, tenant_id)
    print(json.dumps(result, indent=2))
