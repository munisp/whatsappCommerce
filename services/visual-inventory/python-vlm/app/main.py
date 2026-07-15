"""
Visual Inventory Python VLM Service
=====================================
FastAPI service that:
  1. Receives images from the Go orchestrator
  2. Runs YOLO11 object detection (fast bounding-box pass)
  3. Calls Ollama VLM (Qwen2.5-VL / MiniCPM-V / Gemma3) for semantic counting
  4. Sends YOLO bboxes to Rust post-processor for NMS + confidence filtering
  5. Merges YOLO + VLM results into a unified inventory report
  6. Returns structured JSON to the Go orchestrator

Architecture:
  Mobile Camera → Go Orchestrator (image pre-proc, auth, rate-limit)
                → Python VLM Service (YOLO + Ollama VLM)
                  → Rust BBox Post-Processor (NMS, dedup, scoring)
                → TypeScript tRPC (DB write, WebSocket push)
"""
import asyncio
import time
from contextlib import asynccontextmanager
from typing import Annotated, Any

import httpx
import structlog
import uvicorn
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from .config import settings
from .image_utils import resize_for_vlm, get_image_dimensions
from .ollama_client import analyse_image_with_vlm, probe_available_model
from .yolo_detector import run_yolo_detection

log = structlog.get_logger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Probe Ollama at startup to select the best available model."""
    log.info("visual_inventory_service_starting")
    settings.active_vlm_model = await probe_available_model()
    log.info("active_vlm_model", model=settings.active_vlm_model)
    yield
    log.info("visual_inventory_service_stopping")


app = FastAPI(
    title="Visual Inventory VLM Service",
    description="Ollama-backed VLM + YOLO inventory counting microservice",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Request / Response models ─────────────────────────────────────────────────
class DetectedItem(BaseModel):
    label: str
    count: int
    confidence: float
    location: str = ""
    notes: str = ""
    bbox_count: int = 0  # from YOLO


class InventoryAnalysisResponse(BaseModel):
    session_id: str
    scene_description: str
    total_unique_products: int
    total_items_counted: int
    items: list[DetectedItem]
    yolo_detections: int
    vlm_model_used: str
    processing_ms: int
    image_width: int
    image_height: int
    inventory_notes: str
    confidence_score: float  # overall analysis confidence
    raw_vlm: dict[str, Any] = {}
    raw_yolo: dict[str, Any] = {}


# ── Rust bbox post-processor integration ─────────────────────────────────────
async def call_rust_bbox_processor(
    detections: list[dict],
    image_width: int,
    image_height: int,
) -> dict[str, Any]:
    """
    Call the Rust bounding-box post-processor for NMS + confidence re-scoring.
    Falls back to raw YOLO detections if Rust service is unavailable.
    """
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.post(
                f"{settings.rust_bbox_url}/process",
                json={
                    "detections": detections,
                    "image_width": image_width,
                    "image_height": image_height,
                    "nms_threshold": 0.45,
                    "min_confidence": settings.yolo_conf_threshold,
                },
            )
            if resp.status_code == 200:
                return resp.json()
    except Exception as exc:
        log.warning("rust_bbox_unavailable", error=str(exc))
    return {"detections": detections, "processed": False}


# ── Merge YOLO + VLM results ──────────────────────────────────────────────────
def merge_results(
    vlm_result: dict[str, Any],
    yolo_result: dict[str, Any],
    bbox_result: dict[str, Any],
) -> tuple[list[DetectedItem], float]:
    """
    Merge VLM semantic labels with YOLO bbox counts.
    VLM provides: product names, semantic grouping, contextual counts
    YOLO provides: precise bounding boxes, geometric counts
    Strategy: use VLM labels as primary, augment counts with YOLO where YOLO > VLM
    """
    vlm_items = vlm_result.get("items", [])
    yolo_counts = yolo_result.get("counts", {})
    bbox_detections = bbox_result.get("detections", yolo_result.get("detections", []))

    # Build merged item list from VLM
    merged: list[DetectedItem] = []
    used_yolo_labels: set[str] = set()

    for item in vlm_items:
        label = item.get("label", "Unknown")
        vlm_count = item.get("count", 0)
        vlm_conf = item.get("confidence", 0.7)

        # Find matching YOLO count (fuzzy label match)
        yolo_count = 0
        for yolo_label, cnt in yolo_counts.items():
            if (yolo_label.lower() in label.lower() or
                    label.lower() in yolo_label.lower()):
                yolo_count = cnt
                used_yolo_labels.add(yolo_label)
                break

        # Take the higher count (VLM tends to undercount, YOLO overcounts)
        final_count = max(vlm_count, yolo_count) if yolo_count > 0 else vlm_count
        # Boost confidence if YOLO agrees
        final_conf = min(1.0, vlm_conf + 0.1) if yolo_count > 0 else vlm_conf

        merged.append(DetectedItem(
            label=label,
            count=final_count,
            confidence=round(final_conf, 3),
            location=item.get("location", ""),
            notes=item.get("notes", ""),
            bbox_count=yolo_count,
        ))

    # Add YOLO-only detections not covered by VLM (generic objects)
    for yolo_label, cnt in yolo_counts.items():
        if yolo_label not in used_yolo_labels:
            merged.append(DetectedItem(
                label=yolo_label.replace("_", " ").title(),
                count=cnt,
                confidence=0.65,
                location="",
                notes="YOLO detection only — VLM did not identify this item",
                bbox_count=cnt,
            ))

    # Overall confidence: weighted average
    if merged:
        overall_conf = sum(i.confidence * i.count for i in merged) / max(
            sum(i.count for i in merged), 1
        )
    else:
        overall_conf = 0.0

    return merged, round(overall_conf, 3)


# ── Endpoints ─────────────────────────────────────────────────────────────────
@app.get("/health")
async def health():
    return {
        "status": "ok",
        "active_vlm_model": settings.active_vlm_model,
        "yolo_model": settings.yolo_model,
        "ollama_url": settings.ollama_base_url,
    }


@app.get("/models")
async def list_models():
    """List available Ollama models."""
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(f"{settings.ollama_base_url}/api/tags")
            return resp.json()
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"Ollama unavailable: {exc}")


@app.post("/analyse", response_model=InventoryAnalysisResponse)
async def analyse_inventory(
    image: Annotated[UploadFile, File(description="Shelf/storage photo from mobile camera")],
    session_id: Annotated[str, Form()] = "",
    product_hints: Annotated[str, Form(description="Comma-separated known product names")] = "",
    vlm_model: Annotated[str, Form(description="Override VLM model")] = "",
):
    """
    Main endpoint: analyse an inventory image.

    Pipeline:
    1. Resize image for VLM (max 1024px)
    2. Run YOLO11 detection (parallel with VLM call)
    3. Call Ollama VLM (Qwen2.5-VL / MiniCPM-V / Gemma3)
    4. Send YOLO bboxes to Rust post-processor
    5. Merge results and return unified inventory report
    """
    start_time = time.perf_counter()

    # Read and preprocess image
    image_bytes = await image.read()
    if len(image_bytes) == 0:
        raise HTTPException(status_code=400, detail="Empty image")

    resized_bytes = resize_for_vlm(image_bytes)
    img_w, img_h = get_image_dimensions(resized_bytes)

    hints = [h.strip() for h in product_hints.split(",") if h.strip()] if product_hints else []
    model = vlm_model or settings.active_vlm_model

    log.info("analyse_request",
             session_id=session_id,
             model=model,
             image_size=len(resized_bytes),
             hints=hints)

    # Run YOLO + VLM in parallel
    yolo_task = asyncio.get_event_loop().run_in_executor(
        None, run_yolo_detection, resized_bytes
    )
    vlm_task = analyse_image_with_vlm(resized_bytes, hints, model)

    yolo_result, vlm_result = await asyncio.gather(yolo_task, vlm_task)

    # Send YOLO bboxes to Rust post-processor
    bbox_result = await call_rust_bbox_processor(
        yolo_result.get("detections", []),
        img_w,
        img_h,
    )

    # Merge results
    merged_items, overall_confidence = merge_results(vlm_result, yolo_result, bbox_result)

    elapsed_ms = int((time.perf_counter() - start_time) * 1000)
    log.info("analyse_complete",
             session_id=session_id,
             items=len(merged_items),
             total_count=sum(i.count for i in merged_items),
             elapsed_ms=elapsed_ms)

    return InventoryAnalysisResponse(
        session_id=session_id or "unknown",
        scene_description=vlm_result.get("scene_description", ""),
        total_unique_products=len(merged_items),
        total_items_counted=sum(i.count for i in merged_items),
        items=merged_items,
        yolo_detections=yolo_result.get("total_detected", 0),
        vlm_model_used=vlm_result.get("model_used", model),
        processing_ms=elapsed_ms,
        image_width=img_w,
        image_height=img_h,
        inventory_notes=vlm_result.get("inventory_notes", ""),
        confidence_score=overall_confidence,
        raw_vlm=vlm_result,
        raw_yolo={"counts": yolo_result.get("counts", {}), "total": yolo_result.get("total_detected", 0)},
    )


@app.post("/analyse/batch")
async def analyse_batch(
    images: Annotated[list[UploadFile], File(description="Multiple shelf photos")],
    session_id: Annotated[str, Form()] = "",
    product_hints: Annotated[str, Form()] = "",
):
    """Analyse multiple images and aggregate counts (e.g. multiple shelf angles)."""
    results = []
    for img in images:
        img_bytes = await img.read()
        resized = resize_for_vlm(img_bytes)
        hints = [h.strip() for h in product_hints.split(",") if h.strip()]
        vlm = await analyse_image_with_vlm(resized, hints)
        yolo = run_yolo_detection(resized)
        bbox = await call_rust_bbox_processor(yolo.get("detections", []), *get_image_dimensions(resized))
        items, conf = merge_results(vlm, yolo, bbox)
        results.append({"items": [i.model_dump() for i in items], "confidence": conf})

    # Aggregate: sum counts across images for same label
    aggregated: dict[str, dict] = {}
    for r in results:
        for item in r["items"]:
            lbl = item["label"]
            if lbl not in aggregated:
                aggregated[lbl] = {**item}
            else:
                aggregated[lbl]["count"] += item["count"]
                aggregated[lbl]["confidence"] = max(aggregated[lbl]["confidence"], item["confidence"])

    return {
        "session_id": session_id,
        "images_processed": len(images),
        "aggregated_items": list(aggregated.values()),
        "total_items_counted": sum(v["count"] for v in aggregated.values()),
    }


if __name__ == "__main__":
    uvicorn.run(
        "app.main:app",
        host=settings.service_host,
        port=settings.service_port,
        reload=False,
        workers=2,
    )
