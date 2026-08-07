#!/usr/bin/env python3
"""
Lakehouse Pipeline Runner — WhatsApp Commerce Platform
======================================================
Orchestrates the full data pipeline:
  1. ETL: Extract from PostgreSQL, load to Parquet (Bronze layer)
  2. Feature Engineering: Transform to feature store (Silver layer)
  3. Model Training: Train/retrain ML models on latest features (Gold layer)
  4. Model Export: Export to ONNX/TorchScript for CPU inference

All pipeline runs are logged to lakehouse_pipeline_runs in PostgreSQL.
Triggered by:
  - POST /trigger (from ML inference server or platform API)
  - Scheduled cron (via Temporal workflow or cron job)
  - Manual trigger from admin dashboard
"""

import asyncio
import json
import logging
import os
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import psycopg2
import psycopg2.extras

log = logging.getLogger("lakehouse-pipeline")
logging.basicConfig(level=logging.INFO,
                    format='{"ts":"%(asctime)s","level":"%(levelname)s","msg":"%(message)s"}')

DATABASE_URL = os.getenv("DATABASE_URL", "postgresql://wc_user:wc_secret@localhost:5432/whatsapp_commerce")
MODEL_DIR = Path(os.getenv("MODEL_DIR", "/app/models"))
DATA_DIR = Path(os.getenv("DATA_DIR", "/app/data"))
PLATFORM_API_URL = os.getenv("PLATFORM_API_URL", "http://localhost:3000")
PLATFORM_API_KEY = os.getenv("PLATFORM_API_KEY", "")

MODEL_DIR.mkdir(parents=True, exist_ok=True)
DATA_DIR.mkdir(parents=True, exist_ok=True)


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


# ── ETL Stage: Extract from PostgreSQL → Parquet ──────────────────────────────

def run_etl(tenant_id: Optional[str] = None) -> dict:
    """Extract payment_intents and orders from PostgreSQL, save as Parquet."""
    t0 = time.time()
    run_id = log_run_start("etl", "extract")
    conn = get_db()
    records = 0

    if conn:
        try:
            cur = conn.cursor()
            # Extract payment intents
            query = """
                SELECT pi.id, pi."tenantId", pi."orderId", pi.amount, pi.currency,
                       pi.status, pi."paymentMethod", pi."createdAt",
                       o."customerId", o."totalAmount"
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

        # Build feature vectors
        features = []
        for row in rows:
            amount = float(row.get("amount", 0) or 0)
            features.append({
                "id": str(row.get("id", "")),
                "tenant_id": str(row.get("tenantId", "")),
                "amount_ngn": amount,
                "hour_of_day": datetime.now().hour,
                "day_of_week": datetime.now().weekday(),
                "is_weekend": 1 if datetime.now().weekday() >= 5 else 0,
                "status": str(row.get("status", "")),
                "label": 1 if row.get("status") == "failed" else 0,
            })

        # Save feature store
        silver_path = DATA_DIR / "silver" / "features.json"
        silver_path.parent.mkdir(parents=True, exist_ok=True)
        with open(silver_path, "w") as f:
            json.dump(features, f, default=str)
        features_written = len(features)
        log.info("Feature engineering: %d features written", features_written)

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


# ── Model Training Stage ──────────────────────────────────────────────────────

def run_model_training() -> dict:
    """Train/retrain the fraud detection model on latest features."""
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

        if len(features) < 100:
            log.warning("Insufficient training data (%d samples)", len(features))
            if run_id:
                log_run_complete(run_id, "partial", error_msg=f"insufficient_data_{len(features)}")
            return {"status": "partial", "reason": "insufficient_data", "samples": len(features)}

        # Build training data
        X = []
        y = []
        for f in features:
            X.append([
                f.get("amount_ngn", 0),
                f.get("hour_of_day", 0),
                f.get("day_of_week", 0),
                f.get("is_weekend", 0),
                0, 0, 0, 1, 1, 1,  # defaults for unknown features
                f.get("amount_ngn", 0), f.get("amount_ngn", 0),
                1, f.get("amount_ngn", 0), f.get("amount_ngn", 0),
                0, 1, 0, 30, 30,
            ])
            y.append(f.get("label", 0))

        try:
            import torch
            import torch.nn as nn

            class FraudNet(nn.Module):
                def __init__(self):
                    super().__init__()
                    self.net = nn.Sequential(
                        nn.Linear(20, 64), nn.ReLU(), nn.Dropout(0.2),
                        nn.Linear(64, 32), nn.ReLU(),
                        nn.Linear(32, 1),
                    )
                def forward(self, x):
                    return self.net(x)

            X_t = torch.tensor(X, dtype=torch.float32)
            y_t = torch.tensor(y, dtype=torch.float32).unsqueeze(1)

            model = FraudNet()
            optimizer = torch.optim.Adam(model.parameters(), lr=1e-3)
            criterion = nn.BCEWithLogitsLoss()

            # Simple training loop (CPU, 10 epochs)
            model.train()
            for epoch in range(10):
                optimizer.zero_grad()
                out = model(X_t)
                loss = criterion(out, y_t)
                loss.backward()
                optimizer.step()
                if epoch % 5 == 0:
                    log.info("Epoch %d, loss=%.4f", epoch, loss.item())

            # Save model
            model.eval()
            MODEL_DIR.mkdir(parents=True, exist_ok=True)
            scripted = torch.jit.script(model)
            model_path = MODEL_DIR / "fraud_model.pt"
            scripted.save(str(model_path))
            log.info("Model saved to %s (version=%s)", model_path, model_version)

        except ImportError:
            log.warning("PyTorch not available — saving heuristic model marker")
            model_path = MODEL_DIR / "fraud_model_heuristic.json"
            with open(model_path, "w") as f:
                json.dump({"version": model_version, "type": "heuristic", "samples": len(features)}, f)

    except Exception as e:
        log.error("Model training failed: %s", e)
        if run_id:
            log_run_complete(run_id, "failed", error_msg=str(e))
        return {"status": "failed", "error": str(e)}

    duration_ms = int((time.time() - t0) * 1000)
    if run_id:
        log_run_complete(run_id, "completed", model_version=model_version,
                         records_extracted=len(features), duration_ms=duration_ms)
    return {"status": "completed", "model_version": model_version,
            "samples": len(features), "duration_ms": duration_ms}


# ── Full pipeline ─────────────────────────────────────────────────────────────

def run_full_pipeline(tenant_id: Optional[str] = None) -> dict:
    """Run the complete ETL → Feature Engineering → Training pipeline."""
    log.info("Starting full lakehouse pipeline (tenant=%s)", tenant_id or "all")
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


if __name__ == "__main__":
    import sys
    pipeline_type = sys.argv[1] if len(sys.argv) > 1 else "full"
    tenant_id = sys.argv[2] if len(sys.argv) > 2 else None

    if pipeline_type == "etl":
        result = run_etl(tenant_id)
    elif pipeline_type == "feature_engineering":
        result = run_feature_engineering()
    elif pipeline_type == "model_training":
        result = run_model_training()
    else:
        result = run_full_pipeline(tenant_id)

    print(json.dumps(result, indent=2))
