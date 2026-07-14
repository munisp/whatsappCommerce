"""
KYC/KYB Verification Service
Stack: FastAPI + PaddleOCR + Docling + VLM (Ollama/OpenAI) + MediaPipe Liveness
Integrations: Kafka (events), Redis (session cache), PostgreSQL (results)
"""
import os
import uuid
import asyncio
import structlog
from contextlib import asynccontextmanager
from fastapi import FastAPI, UploadFile, File, HTTPException, Depends, Header
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from typing import Optional

from .ocr_processor import OCRProcessor
from .vlm_processor import VLMProcessor
from .liveness_processor import LivenessProcessor
from .docling_processor import DoclingProcessor
from .kafka_client import KafkaEventClient
from .redis_client import RedisSessionClient
from .models import (
    DocumentVerificationRequest, DocumentVerificationResult,
    LivenessSessionRequest, LivenessFrameRequest, LivenessResult,
    KYCApplicationSummary,
)

log = structlog.get_logger()

# ─── Lifespan ────────────────────────────────────────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    log.info("kyc_service.startup", version="1.0.0")
    app.state.ocr = OCRProcessor()
    app.state.vlm = VLMProcessor()
    app.state.liveness = LivenessProcessor()
    app.state.docling = DoclingProcessor()
    app.state.kafka = KafkaEventClient(
        brokers=os.getenv("KAFKA_BROKERS", "localhost:9092"),
        topic=os.getenv("KAFKA_KYC_TOPIC", "kyc.events"),
    )
    app.state.redis = RedisSessionClient(
        url=os.getenv("REDIS_URL", "redis://localhost:6379/2"),
    )
    await app.state.kafka.start()
    await app.state.redis.connect()
    yield
    await app.state.kafka.stop()
    await app.state.redis.disconnect()
    log.info("kyc_service.shutdown")

app = FastAPI(
    title="KYC/KYB Verification Service",
    version="1.0.0",
    description="Document OCR, VLM analysis, liveness detection, and risk scoring for tenant onboarding.",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ─── Auth dependency ──────────────────────────────────────────────────────────
INTERNAL_API_KEY = os.getenv("KYC_INTERNAL_API_KEY", "dev-kyc-key-change-in-prod")

async def verify_api_key(x_api_key: str = Header(...)):
    if x_api_key != INTERNAL_API_KEY:
        raise HTTPException(status_code=401, detail="Invalid API key")
    return x_api_key

# ─── Health ───────────────────────────────────────────────────────────────────
@app.get("/health")
async def health():
    return {"status": "ok", "service": "kyc-verifier", "version": "1.0.0"}

# ─── Document Verification ────────────────────────────────────────────────────
@app.post("/verify/document", response_model=DocumentVerificationResult)
async def verify_document(
    file: UploadFile = File(...),
    application_id: str = Header(..., alias="X-Application-Id"),
    tenant_id: str = Header(..., alias="X-Tenant-Id"),
    document_type: str = Header(..., alias="X-Document-Type"),
    _: str = Depends(verify_api_key),
):
    """
    Full document verification pipeline:
    1. PaddleOCR → raw text + bounding boxes
    2. Docling → structured document parsing (tables, fields, layout)
    3. VLM (Ollama/GPT-4V) → authenticity, tampering, field extraction
    4. Risk scoring
    """
    content = await file.read()
    log.info("doc.verify.start", app_id=application_id, doc_type=document_type, size=len(content))

    # Step 1: OCR
    ocr_result = await app.state.ocr.process(content, file.content_type or "image/jpeg")

    # Step 2: Docling structured parsing
    docling_result = await app.state.docling.parse(content, file.content_type or "image/jpeg")

    # Step 3: VLM analysis
    vlm_result = await app.state.vlm.analyze_document(
        content=content,
        document_type=document_type,
        ocr_text=ocr_result.get("text", ""),
        docling_fields=docling_result.get("fields", {}),
    )

    # Step 4: Risk scoring
    risk_score = _compute_document_risk(ocr_result, vlm_result)

    result = DocumentVerificationResult(
        application_id=application_id,
        document_type=document_type,
        ocr_confidence=ocr_result.get("confidence", 0.0),
        ocr_raw_text=ocr_result.get("text", ""),
        extracted_data=vlm_result.get("extracted_fields", {}),
        vlm_analysis=vlm_result,
        docling_structure=docling_result,
        is_authentic=vlm_result.get("is_authentic", False),
        is_tampered=vlm_result.get("is_tampered", True),
        authenticity_score=vlm_result.get("authenticity_score", 0.0),
        risk_score=risk_score,
        verification_notes=vlm_result.get("notes", ""),
    )

    # Publish Kafka event
    await app.state.kafka.publish("document.verified", {
        "applicationId": application_id,
        "tenantId": tenant_id,
        "documentType": document_type,
        "isAuthentic": result.is_authentic,
        "riskScore": result.risk_score,
    })

    log.info("doc.verify.complete", app_id=application_id, authentic=result.is_authentic, risk=risk_score)
    return result

# ─── Liveness Detection ───────────────────────────────────────────────────────
@app.post("/liveness/session")
async def create_liveness_session(
    req: LivenessSessionRequest,
    _: str = Depends(verify_api_key),
):
    """Create a new liveness check session with a random challenge."""
    session_id = str(uuid.uuid4())
    challenge = app.state.liveness.generate_challenge()
    session_data = {
        "session_id": session_id,
        "application_id": req.application_id,
        "tenant_id": req.tenant_id,
        "challenge": challenge,
        "frames_received": 0,
        "status": "in_progress",
    }
    await app.state.redis.set(f"liveness:{session_id}", session_data, ttl=300)
    return {"session_id": session_id, "challenge": challenge, "expires_in": 300}

@app.post("/liveness/frame/{session_id}", response_model=LivenessResult)
async def process_liveness_frame(
    session_id: str,
    file: UploadFile = File(...),
    frame_index: int = Header(0, alias="X-Frame-Index"),
    _: str = Depends(verify_api_key),
):
    """Process a single liveness frame and return incremental result."""
    session = await app.state.redis.get(f"liveness:{session_id}")
    if not session:
        raise HTTPException(status_code=404, detail="Session not found or expired")

    content = await file.read()
    frame_result = await app.state.liveness.process_frame(
        frame_data=content,
        challenge=session["challenge"],
        frame_index=frame_index,
    )

    session["frames_received"] = frame_index + 1
    if frame_result.get("challenge_completed"):
        session["status"] = "passed" if frame_result.get("liveness_score", 0) > 0.75 else "failed"
        session["final_result"] = frame_result
        # Publish event
        await app.state.kafka.publish("liveness.completed", {
            "sessionId": session_id,
            "applicationId": session["application_id"],
            "tenantId": session["tenant_id"],
            "status": session["status"],
            "livenessScore": frame_result.get("liveness_score"),
        })

    await app.state.redis.set(f"liveness:{session_id}", session, ttl=300)

    return LivenessResult(
        session_id=session_id,
        status=session["status"],
        liveness_score=frame_result.get("liveness_score", 0.0),
        face_match_score=frame_result.get("face_match_score", 0.0),
        spoofing_detected=frame_result.get("spoofing_detected", False),
        challenge_completed=frame_result.get("challenge_completed", False),
        frame_count=session["frames_received"],
        analysis=frame_result,
    )

@app.get("/liveness/session/{session_id}")
async def get_liveness_session(session_id: str, _: str = Depends(verify_api_key)):
    session = await app.state.redis.get(f"liveness:{session_id}")
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    return session

# ─── Risk Scoring ─────────────────────────────────────────────────────────────
def _compute_document_risk(ocr_result: dict, vlm_result: dict) -> float:
    score = 1.0
    if ocr_result.get("confidence", 0) < 0.6:
        score -= 0.2
    if vlm_result.get("is_tampered"):
        score -= 0.5
    if not vlm_result.get("is_authentic"):
        score -= 0.3
    if vlm_result.get("missing_fields"):
        score -= 0.1 * len(vlm_result["missing_fields"])
    return max(0.0, round(score, 3))

