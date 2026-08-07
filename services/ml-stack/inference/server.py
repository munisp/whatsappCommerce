#!/usr/bin/env python3
"""
ML Inference FastAPI Server — WhatsApp Commerce Platform
=========================================================
Serves CPU-optimized fraud detection, credit scoring, and NLP models.
All models run on CPU (no GPU required) using ONNX Runtime or PyTorch CPU.

Real trained weights are loaded from services/ml-stack/models/weights/
(fraud_gnn_lstm.pt / credit_tabnet.pt, or their .onnx siblings when present)
via the shared loader in services/ml-stack/model_io.py. When a model cannot
be loaded, a deterministic, clearly labeled heuristic fallback is used
(source="heuristic-fallback").

Endpoints:
  POST /predict           — fraud + credit score prediction
  POST /predict/fraud     — backward-compat alias of /predict
  POST /nlp/intent        — NLP intent classification
  POST /nlp/sentiment     — sentiment analysis
  POST /recommend         — product recommendations
  GET  /health            — health check with model status
  GET  /models            — list loaded models and versions
  POST /lakehouse/trigger — trigger a lakehouse pipeline run
"""

import asyncio
import json
import logging
import os
import sys
import time
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

import httpx
import psycopg2
import psycopg2.extras
import uvicorn
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

# ── Shared model loading (services/ml-stack/model_io.py) ─────────────────────
_ML_STACK_DIR = Path(__file__).resolve().parent.parent
if str(_ML_STACK_DIR) not in sys.path:
    sys.path.insert(0, str(_ML_STACK_DIR))

import model_io  # noqa: E402

# ── Logging ───────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format='{"ts":"%(asctime)s","level":"%(levelname)s","msg":"%(message)s"}',
    datefmt="%Y-%m-%dT%H:%M:%SZ",
)
log = logging.getLogger("ml-inference")

# ── Config ────────────────────────────────────────────────────────────────────
DATABASE_URL = os.getenv("DATABASE_URL", "postgresql://wc_user:wc_secret@localhost:5432/whatsapp_commerce")
PORT = int(os.getenv("PORT", "8099"))
MODEL_DIR = model_io.resolve_weights_dir()  # MODEL_DIR env override or committed repo weights
PLATFORM_API_URL = os.getenv("PLATFORM_API_URL", "http://localhost:3000")
PLATFORM_API_KEY = os.getenv("PLATFORM_API_KEY", "")
LAKEHOUSE_PIPELINE_URL = os.getenv("LAKEHOUSE_PIPELINE_URL", "")
PIPELINE_SCRIPT = _ML_STACK_DIR / "lakehouse" / "pipeline.py"

# ── Model registry ────────────────────────────────────────────────────────────
_models: dict[str, Any] = {}
_model_versions: dict[str, str] = {}


def load_models() -> None:
    """
    Load the committed trained weights (CPU only). Anything that fails to load
    leaves a clearly logged gap and the corresponding heuristic fallback stays
    active and is labeled "heuristic-fallback" in responses.
    """
    global _models, _model_versions

    model_io.get_torch()  # sets CPU thread count once

    fraud = model_io.load_fraud_bundle(MODEL_DIR)
    if fraud:
        _models["fraud"] = fraud
        _model_versions["fraud"] = fraud["version"]
        log.info("Fraud model ACTIVE: %s (%s backend)", fraud["version"], fraud["kind"])
    else:
        log.warning("Fraud model NOT loaded — deterministic heuristic fallback active")

    credit = model_io.load_credit_bundle(MODEL_DIR)
    if credit:
        _models["credit"] = credit
        _model_versions["credit"] = credit["version"]
        log.info("Credit model ACTIVE: %s (%s backend)", credit["version"], credit["kind"])
    else:
        log.warning("Credit model NOT loaded — deterministic heuristic fallback active")

    # NLP intent model (transformers or ONNX) — optional
    nlp_model_path = MODEL_DIR / "intent_model"
    if nlp_model_path.exists():
        try:
            from transformers import pipeline
            nlp_pipe = pipeline("text-classification", model=str(nlp_model_path),
                                device=-1)  # CPU
            _models["intent"] = nlp_pipe
            _model_versions["intent"] = "transformers_v1"
            log.info("Intent NLP model loaded")
        except Exception as e:
            log.warning("Failed to load intent model: %s — using keyword heuristic", e)

    log.info("Model loading complete. Loaded: %s", list(_models.keys()))


def get_db():
    """Get a PostgreSQL connection."""
    try:
        conn = psycopg2.connect(DATABASE_URL)
        return conn
    except Exception as e:
        log.warning("DB connection failed: %s", e)
        return None


async def persist_lakehouse_run(pipeline_type: str, stage: str, status: str,
                                 records_extracted: int = 0, records_loaded: int = 0,
                                 features_written: int = 0, model_version: str = None,
                                 duration_ms: int = None, error_msg: str = None,
                                 metadata: dict = None) -> Optional[str]:
    """Persist a lakehouse pipeline run to PostgreSQL."""
    conn = get_db()
    if not conn:
        return None
    try:
        cur = conn.cursor()
        cur.execute(
            """INSERT INTO lakehouse_pipeline_runs
               (id, pipeline_type, stage, status, records_extracted, records_loaded,
                features_written, model_version, duration_ms, error_msg, metadata,
                started_at, completed_at)
               VALUES (gen_random_uuid(), %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                       NOW(), CASE WHEN %s IN ('completed','failed','partial') THEN NOW() ELSE NULL END)
               RETURNING id::text""",
            (pipeline_type, stage, status, records_extracted, records_loaded,
             features_written, model_version, duration_ms, error_msg,
             json.dumps(metadata) if metadata else None, status)
        )
        row = cur.fetchone()
        conn.commit()
        return row[0] if row else None
    except Exception as e:
        log.warning("Failed to persist lakehouse run: %s", e)
        return None
    finally:
        conn.close()


async def update_lakehouse_run(run_id: str, status: str, duration_ms: int = None,
                                error_msg: str = None, metadata: dict = None) -> None:
    """Mark a previously created lakehouse run as completed/failed (honest lifecycle)."""
    conn = get_db()
    if not conn:
        return
    try:
        cur = conn.cursor()
        cur.execute(
            """UPDATE lakehouse_pipeline_runs SET
               status = %s, duration_ms = COALESCE(%s, duration_ms),
               error_msg = COALESCE(%s, error_msg),
               metadata = COALESCE(%s, metadata),
               completed_at = CASE WHEN %s IN ('completed','failed','partial') THEN NOW()
                                   ELSE completed_at END
               WHERE id = %s::uuid""",
            (status, duration_ms, error_msg,
             json.dumps(metadata) if metadata else None, status, run_id)
        )
        conn.commit()
    except Exception as e:
        log.warning("Failed to update lakehouse run %s: %s", run_id, e)
    finally:
        conn.close()


# ── Fraud / credit inference (real model first, labeled heuristic fallback) ──

def run_fraud_inference(features: list[float]) -> tuple[float, str, str]:
    """Run fraud inference. Returns (probability, risk_level, source)."""
    bundle = _models.get("fraud")
    if bundle:
        try:
            prob = model_io.predict_fraud_proba(bundle, features)
            return prob, model_io.risk_level(prob), "model"
        except Exception as e:
            log.warning("Model fraud inference failed: %s — falling back to heuristic", e)

    prob, risk = model_io.heuristic_fraud_score(features)
    return prob, risk, "heuristic-fallback"


def compute_credit_score(payload: dict, fraud_features: list[float]) -> tuple[int, str, str]:
    """Compute a credit score (300-850 range). Returns (score, grade, source)."""
    bundle = _models.get("credit")
    if bundle:
        try:
            credit_features = model_io.build_credit_features(payload)
            default_prob = model_io.predict_default_proba(bundle, credit_features)
            score, grade = model_io.credit_score_from_default_prob(default_prob)
            return score, grade, "model"
        except Exception as e:
            log.warning("Model credit inference failed: %s — falling back to heuristic", e)

    score, grade = model_io.heuristic_credit_score(fraud_features)
    return score, grade, "heuristic-fallback"


INTENT_KEYWORDS = {
    "browse_catalog": ["show", "list", "catalog", "products", "browse", "what do you have", "available"],
    "add_to_cart": ["add", "cart", "buy", "purchase", "want", "order", "get"],
    "checkout": ["checkout", "pay", "payment", "complete", "finish", "confirm"],
    "track_order": ["track", "where", "status", "delivery", "shipped", "order status"],
    "customer_support": ["help", "support", "problem", "issue", "complaint", "refund", "return"],
    "greeting": ["hi", "hello", "hey", "good morning", "good evening", "start"],
    "farewell": ["bye", "goodbye", "thanks", "thank you", "done"],
}


def classify_intent(text: str) -> tuple[str, float]:
    """Classify intent using NLP model or keyword heuristic."""
    if "intent" in _models:
        try:
            result = _models["intent"](text[:512])
            if result:
                return result[0]["label"], float(result[0]["score"])
        except Exception as e:
            log.warning("NLP intent inference failed: %s", e)

    # Keyword heuristic
    text_lower = text.lower()
    scores: dict[str, int] = {}
    for intent, keywords in INTENT_KEYWORDS.items():
        scores[intent] = sum(1 for kw in keywords if kw in text_lower)

    best_intent = max(scores, key=scores.get)
    best_score = scores[best_intent]
    if best_score == 0:
        return "unknown", 0.3
    confidence = min(0.5 + best_score * 0.15, 0.95)
    return best_intent, confidence


# ── Request/Response models ───────────────────────────────────────────────────

class PredictRequest(BaseModel):
    amount: float = Field(ge=0)
    num_items: int = Field(ge=0, default=0)
    has_phone: bool = True
    has_customer: bool = True
    tx_count_1h: int = 1
    tx_count_24h: int = 1
    tx_count_7d: int = 1
    is_new_device: Optional[float] = None
    is_vpn: float = 0.0
    is_tor: float = 0.0
    unique_merchants_24h: Optional[float] = None
    avg_amount_7d: Optional[float] = None
    max_amount_7d: Optional[float] = None
    time_on_site_sec: Optional[float] = None
    pages_visited: Optional[float] = None
    cart_abandon_rate: Optional[float] = None
    days_since_account_creation: Optional[float] = None
    device_age_days: Optional[float] = None
    timestamp: Optional[str] = None  # ISO-8601 transaction time (defaults to now)
    tenant_id: Optional[str] = None
    order_id: Optional[str] = None


class NLPRequest(BaseModel):
    text: str
    tenant_id: Optional[str] = None
    conversation_id: Optional[str] = None


class RecommendRequest(BaseModel):
    tenant_id: str
    customer_id: Optional[str] = None
    context: Optional[str] = None
    limit: int = Field(default=5, ge=1, le=20)


class LakehouseTriggerRequest(BaseModel):
    pipeline_type: str  # etl | feature_engineering | model_training | full
    tenant_id: Optional[str] = None
    force: bool = False


# ── FastAPI app ───────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    log.info("ML Inference Server starting (CPU mode)")
    load_models()
    yield
    log.info("ML Inference Server shutting down")


app = FastAPI(
    title="WhatsApp Commerce ML Inference",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "service": "ml-inference",
        "ts": datetime.now(timezone.utc).isoformat(),
        "models": {
            "fraud": _model_versions.get("fraud", "heuristic-fallback"),
            "credit": _model_versions.get("credit", "heuristic-fallback"),
            "intent": _model_versions.get("intent", "heuristic-fallback"),
        },
        "cpu_mode": True,
    }


@app.get("/models")
async def list_models():
    return {
        "loaded": list(_models.keys()),
        "versions": _model_versions,
        "model_dir": str(MODEL_DIR),
    }


async def _run_prediction(req: PredictRequest) -> dict:
    """Shared fraud + credit prediction handler (POST /predict and /predict/fraud)."""
    t0 = time.time()
    # Drop unset (None) optional fields so feature builders apply their defaults
    payload = {k: v for k, v in req.model_dump().items() if v is not None}
    features = model_io.build_fraud_features(payload)

    fraud_prob, risk_level, fraud_source = run_fraud_inference(features)
    credit_score, credit_grade, credit_source = compute_credit_score(payload, features)

    duration_ms = int((time.time() - t0) * 1000)

    result = {
        "fraud_probability": round(fraud_prob, 4),
        "risk_level": risk_level,
        "credit_score": credit_score,
        "credit_grade": credit_grade,
        "source": fraud_source,
        "fraud_source": fraud_source,
        "credit_source": credit_source,
        "duration_ms": duration_ms,
        "tenant_id": req.tenant_id,
        "order_id": req.order_id,
    }

    # Log to lakehouse
    await persist_lakehouse_run(
        pipeline_type="inference",
        stage="fraud_detection",
        status="completed",
        records_extracted=1,
        records_loaded=1,
        model_version=fraud_source,
        duration_ms=duration_ms,
        metadata={"risk_level": risk_level, "tenant_id": req.tenant_id,
                  "credit_source": credit_source},
    )

    return result


@app.post("/predict")
async def predict(req: PredictRequest):
    """Fraud detection + credit scoring."""
    return await _run_prediction(req)


@app.post("/predict/fraud")
async def predict_fraud(req: PredictRequest):
    """Backward-compat alias of POST /predict."""
    return await _run_prediction(req)


@app.post("/nlp/intent")
async def nlp_intent(req: NLPRequest):
    """Intent classification for WhatsApp messages."""
    t0 = time.time()
    intent, confidence = classify_intent(req.text)
    duration_ms = int((time.time() - t0) * 1000)
    return {
        "intent": intent,
        "confidence": round(confidence, 4),
        "text": req.text[:100],
        "duration_ms": duration_ms,
        "source": "transformers" if "intent" in _models else "heuristic",
    }


@app.post("/nlp/sentiment")
async def nlp_sentiment(req: NLPRequest):
    """Sentiment analysis for customer messages."""
    text_lower = req.text.lower()
    positive_words = ["good", "great", "excellent", "happy", "love", "perfect", "thanks", "wonderful"]
    negative_words = ["bad", "terrible", "awful", "hate", "wrong", "broken", "failed", "disappointed"]
    pos = sum(1 for w in positive_words if w in text_lower)
    neg = sum(1 for w in negative_words if w in text_lower)
    if pos > neg:
        sentiment, score = "positive", min(0.5 + pos * 0.1, 0.95)
    elif neg > pos:
        sentiment, score = "negative", min(0.5 + neg * 0.1, 0.95)
    else:
        sentiment, score = "neutral", 0.5
    return {"sentiment": sentiment, "score": round(score, 4), "source": "heuristic"}


@app.post("/recommend")
async def recommend(req: RecommendRequest):
    """Product recommendations based on customer context."""
    async with httpx.AsyncClient(timeout=5.0) as client:
        try:
            resp = await client.get(
                f"{PLATFORM_API_URL}/api/trpc/products.list",
                params={"input": json.dumps({"tenantId": req.tenant_id, "limit": req.limit})},
                headers={"X-Internal-Token": PLATFORM_API_KEY},
            )
            if resp.status_code == 200:
                data = resp.json()
                products = data.get("result", {}).get("data", {}).get("products", [])
                return {
                    "tenant_id": req.tenant_id,
                    "recommendations": products[:req.limit],
                    "count": len(products[:req.limit]),
                    "source": "platform_api",
                }
        except Exception as e:
            log.warning("Product recommendation fetch failed: %s", e)
    return {"tenant_id": req.tenant_id, "recommendations": [], "count": 0, "source": "unavailable"}


# ── Lakehouse trigger: actually run the pipeline in a subprocess ──────────────

async def _execute_pipeline(run_id: Optional[str], pipeline_type: str,
                            tenant_id: Optional[str]) -> None:
    """
    Run lakehouse/pipeline.py as a subprocess and honestly record the outcome:
    the run row moves started("running") → completed/failed with duration and,
    on failure, the subprocess stderr tail. Never leaves a phantom "running".
    """
    t0 = time.time()
    cmd = [sys.executable, str(PIPELINE_SCRIPT), pipeline_type]
    if tenant_id:
        cmd.append(tenant_id)
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env={**os.environ, "DATABASE_URL": DATABASE_URL},
        )
        stdout, stderr = await proc.communicate()
        duration_ms = int((time.time() - t0) * 1000)

        final_status = "completed"
        error_msg = None
        result: dict = {}
        out_text = stdout.decode().strip()
        if out_text:
            try:
                # pipeline.py prints one JSON result document on stdout
                parsed = json.loads(out_text)
                if isinstance(parsed, dict):
                    result = parsed
            except json.JSONDecodeError:
                # Fall back to the last JSON-looking line
                for line in reversed(out_text.splitlines()):
                    line = line.strip()
                    if line.startswith("{"):
                        try:
                            parsed = json.loads(line)
                            if isinstance(parsed, dict):
                                result = parsed
                                break
                        except json.JSONDecodeError:
                            continue
        final_status = result.get("status", "completed")
        if final_status not in ("completed", "partial", "failed"):
            final_status = "completed"
        if proc.returncode != 0:
            final_status = "failed"
            error_msg = (stderr.decode() or stdout.decode())[-2000:]

        log.info("Lakehouse pipeline %s finished: status=%s rc=%s duration=%dms",
                 pipeline_type, final_status, proc.returncode, duration_ms)
        if run_id:
            await update_lakehouse_run(
                run_id, final_status, duration_ms=duration_ms, error_msg=error_msg,
                metadata={"pipeline_type": pipeline_type, "tenant_id": tenant_id,
                          "returncode": proc.returncode, "result": result},
            )
    except Exception as e:
        duration_ms = int((time.time() - t0) * 1000)
        log.error("Lakehouse pipeline subprocess failed: %s", e)
        if run_id:
            await update_lakehouse_run(run_id, "failed", duration_ms=duration_ms,
                                       error_msg=str(e)[:2000])


@app.post("/lakehouse/trigger")
async def trigger_lakehouse(req: LakehouseTriggerRequest):
    """
    Trigger a lakehouse pipeline run. The pipeline executes in the background
    as a subprocess; its run row is created with status "running" and updated
    to completed/failed when the subprocess exits.
    """
    if req.pipeline_type not in ("etl", "feature_engineering", "model_training", "full"):
        raise HTTPException(status_code=400, detail=f"unknown pipeline_type: {req.pipeline_type}")

    run_id = await persist_lakehouse_run(
        pipeline_type=req.pipeline_type,
        stage="triggered",
        status="running",
        metadata={"tenant_id": req.tenant_id, "force": req.force},
    )

    # If external lakehouse pipeline URL is configured, forward the trigger
    if LAKEHOUSE_PIPELINE_URL:
        async with httpx.AsyncClient(timeout=10.0) as client:
            try:
                await client.post(
                    f"{LAKEHOUSE_PIPELINE_URL}/trigger",
                    json={"pipeline_type": req.pipeline_type, "tenant_id": req.tenant_id},
                )
            except Exception as e:
                log.warning("Lakehouse pipeline trigger failed: %s", e)

    asyncio.create_task(_execute_pipeline(run_id, req.pipeline_type, req.tenant_id))

    return {
        "run_id": run_id,
        "pipeline_type": req.pipeline_type,
        "status": "running",
        "ts": datetime.now(timezone.utc).isoformat(),
    }


if __name__ == "__main__":
    uvicorn.run(
        "server:app",
        host="0.0.0.0",
        port=PORT,
        reload=os.getenv("ENV") == "development",
        log_level="info",
        workers=int(os.getenv("ML_WORKERS", "1")),
    )
