#!/usr/bin/env python3
"""
ML Inference FastAPI Server — WhatsApp Commerce Platform
=========================================================
Serves CPU-optimized fraud detection, credit scoring, and NLP models.
All models run on CPU (no GPU required) using ONNX Runtime or PyTorch CPU.

Endpoints:
  POST /predict           — fraud + credit score prediction
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
MODEL_DIR = Path(os.getenv("MODEL_DIR", "/app/models"))
PLATFORM_API_URL = os.getenv("PLATFORM_API_URL", "http://localhost:3000")
PLATFORM_API_KEY = os.getenv("PLATFORM_API_KEY", "")
LAKEHOUSE_PIPELINE_URL = os.getenv("LAKEHOUSE_PIPELINE_URL", "")

# ── Model registry ────────────────────────────────────────────────────────────
_models: dict[str, Any] = {}
_model_versions: dict[str, str] = {}

def load_models() -> None:
    """Load all models from disk. Falls back to lightweight heuristics if not found."""
    global _models, _model_versions

    # Try to load PyTorch fraud model
    fraud_model_path = MODEL_DIR / "fraud_model.pt"
    if fraud_model_path.exists():
        try:
            import torch
            torch.set_num_threads(int(os.getenv("TORCH_NUM_THREADS", "2")))
            model = torch.jit.load(str(fraud_model_path), map_location="cpu")
            model.eval()
            _models["fraud"] = model
            _model_versions["fraud"] = "pytorch_v1"
            log.info("Fraud model loaded from %s", fraud_model_path)
        except Exception as e:
            log.warning("Failed to load fraud model: %s — using heuristic", e)
    else:
        log.info("Fraud model not found at %s — using heuristic", fraud_model_path)

    # Try ONNX fraud model
    fraud_onnx_path = MODEL_DIR / "fraud_model.onnx"
    if fraud_onnx_path.exists() and "fraud" not in _models:
        try:
            import onnxruntime as ort
            sess_opts = ort.SessionOptions()
            sess_opts.intra_op_num_threads = 2
            sess_opts.inter_op_num_threads = 2
            sess = ort.InferenceSession(str(fraud_onnx_path), sess_opts=sess_opts,
                                         providers=["CPUExecutionProvider"])
            _models["fraud_onnx"] = sess
            _model_versions["fraud"] = "onnx_v1"
            log.info("Fraud ONNX model loaded")
        except Exception as e:
            log.warning("Failed to load ONNX fraud model: %s", e)

    # NLP intent model (transformers or ONNX)
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


# ── Feature engineering ───────────────────────────────────────────────────────

def build_fraud_features(payload: dict) -> list[float]:
    """Map prediction request to 20-dim fraud feature vector."""
    now = datetime.now(timezone.utc)
    amount = float(payload.get("amount", 0))
    num_items = int(payload.get("num_items", 0))
    has_phone = bool(payload.get("has_phone", True))
    has_customer = bool(payload.get("has_customer", True))
    tx_count_1h = int(payload.get("tx_count_1h", 1))
    tx_count_24h = int(payload.get("tx_count_24h", 1))
    tx_count_7d = int(payload.get("tx_count_7d", 1))
    is_new_device = float(payload.get("is_new_device", 0.0))
    is_vpn = float(payload.get("is_vpn", 0.0))
    is_tor = float(payload.get("is_tor", 0.0))
    return [
        amount,                                          # amount_ngn
        float(now.hour),                                 # hour_of_day
        float(now.weekday()),                            # day_of_week
        1.0 if now.weekday() >= 5 else 0.0,             # is_weekend
        is_new_device if not has_customer else 0.0,     # is_new_device
        is_vpn,                                          # is_vpn
        is_tor,                                          # is_tor
        float(tx_count_1h),                              # tx_count_1h
        float(tx_count_24h),                             # tx_count_24h
        float(tx_count_7d),                              # tx_count_7d
        amount * tx_count_1h,                            # tx_amount_1h
        amount * tx_count_24h,                           # tx_amount_24h
        float(payload.get("unique_merchants_24
h", 1)),          # unique_merchants_24h
        float(payload.get("avg_amount_7d", amount)),    # avg_amount_7d
        float(payload.get("max_amount_7d", amount)),    # max_amount_7d
        float(payload.get("time_on_site_sec", 0)),      # time_on_site_sec
        float(num_items),                                # pages_visited (proxy)
        0.0 if num_items > 0 else 1.0,                  # cart_abandon_rate
        30.0 if has_customer else 0.0,                  # days_since_account_creation
        float(payload.get("device_age_days", 30)),      # device_age_days
    ]


def heuristic_fraud_score(features: list[float]) -> tuple[float, str]:
    """Rule-based fraud scoring when ML model unavailable."""
    amount = features[0]
    hour = features[1]
    is_new_device = features[4]
    is_vpn = features[5]
    is_tor = features[6]
    tx_count_1h = features[7]
    cart_abandon = features[17]
    days_account = features[18]

    score = 0.0
    # High amount at odd hours
    if amount > 500_000 and (hour < 6 or hour > 22):
        score += 0.3
    # VPN/Tor usage
    if is_vpn > 0.5:
        score += 0.2
    if is_tor > 0.5:
        score += 0.4
    # New device + new account
    if is_new_device > 0.5 and days_account < 7:
        score += 0.25
    # High velocity
    if tx_count_1h > 5:
        score += 0.2
    # Very high amount
    if amount > 2_000_000:
        score += 0.15
    # Cart abandon
    if cart_abandon > 0.8:
        score += 0.05

    score = min(score, 1.0)
    risk = "low" if score < 0.3 else ("medium" if score < 0.6 else "high")
    return score, risk


def run_fraud_inference(features: list[float]) -> tuple[float, str, str]:
    """Run fraud inference. Returns (probability, risk_level, source)."""
    # Try PyTorch model
    if "fraud" in _models:
        try:
            import torch
            x = torch.tensor([features], dtype=torch.float32)
            with torch.no_grad():
                out = _models["fraud"](x)
                prob = float(torch.sigmoid(out[0][0]).item())
            risk = "low" if prob < 0.3 else ("medium" if prob < 0.6 else "high")
            return prob, risk, "pytorch_model"
        except Exception as e:
            log.warning("PyTorch inference failed: %s", e)

    # Try ONNX model
    if "fraud_onnx" in _models:
        try:
            import numpy as np
            sess = _models["fraud_onnx"]
            x = np.array([features], dtype=np.float32)
            out = sess.run(None, {sess.get_inputs()[0].name: x})
            prob = float(1 / (1 + np.exp(-out[0][0][0])))  # sigmoid
            risk = "low" if prob < 0.3 else ("medium" if prob < 0.6 else "high")
            return prob, risk, "onnx_model"
        except Exception as e:
            log.warning("ONNX inference failed: %s", e)

    # Heuristic fallback
    prob, risk = heuristic_fraud_score(features)
    return prob, risk, "heuristic"


def compute_credit_score(features: list[float]) -> tuple[int, str]:
    """Compute a credit score (300-850 range) from features."""
    amount = features[0]
    tx_count_7d = features[9]
    days_account = features[18]
    device_age = features[19]
    is_vpn = features[5]
    is_tor = features[6]

    base = 650.0
    # Positive signals
    base += min(days_account * 0.5, 100)
    base += min(tx_count_7d * 5, 50)
    base += min(device_age * 0.2, 30)
    # Negative signals
    base -= min(amount / 100_000, 50)
    if is_vpn > 0.5:
        base -= 30
    if is_tor > 0.5:
        base -= 80

    score = max(300, min(850, int(base)))
    grade = "A" if score >= 750 else ("B" if score >= 650 else ("C" if score >= 550 else "D"))
    return score, grade


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
    is_new_device: float = 0.0
    is_vpn: float = 0.0
    is_tor: float = 0.0
    avg_amount_7d: Optional[float] = None
    max_amount_7d: Optional[float] = None
    device_age_days: float = 30.0
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
            name: _model_versions.get(name, "unknown")
            for name in (["fraud", "intent"] + list(_models.keys()))
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


@app.post("/predict")
async def predict(req: PredictRequest):
    """Fraud detection + credit scoring."""
    t0 = time.time()
    payload = req.model_dump()
    features = build_fraud_features(payload)

    fraud_prob, risk_level, source = run_fraud_inference(features)
    credit_score, credit_grade = compute_credit_score(features)

    duration_ms = int((time.time() - t0) * 1000)

    result = {
        "fraud_probability": round(fraud_prob, 4),
        "risk_level": risk_level,
        "credit_score": credit_score,
        "credit_grade": credit_grade,
        "source": source,
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
        model_version=source,
        duration_ms=duration_ms,
        metadata={"risk_level": risk_level, "tenant_id": req.tenant_id},
    )

    return result


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


@app.post("/lakehouse/trigger")
async def trigger_lakehouse(req: LakehouseTriggerRequest):
    """Trigger a lakehouse pipeline run."""
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

    return {
        "run_id": run_id,
        "pipeline_type": req.pipeline_type,
        "status": "triggered",
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
