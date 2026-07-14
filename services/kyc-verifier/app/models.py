"""Pydantic models for KYC/KYB verification service."""
from pydantic import BaseModel
from typing import Any, Optional

class DocumentVerificationRequest(BaseModel):
    application_id: str
    tenant_id: str
    document_type: str

class DocumentVerificationResult(BaseModel):
    application_id: str
    document_type: str
    ocr_confidence: float
    ocr_raw_text: str
    extracted_data: dict[str, Any]
    vlm_analysis: dict[str, Any]
    docling_structure: dict[str, Any]
    is_authentic: bool
    is_tampered: bool
    authenticity_score: float
    risk_score: float
    verification_notes: str

class LivenessSessionRequest(BaseModel):
    application_id: str
    tenant_id: str
    reference_image_key: Optional[str] = None

class LivenessFrameRequest(BaseModel):
    session_id: str
    frame_index: int = 0

class LivenessResult(BaseModel):
    session_id: str
    status: str
    liveness_score: float
    face_match_score: float
    spoofing_detected: bool
    challenge_completed: bool
    frame_count: int
    analysis: dict[str, Any]

