"""
YOLO object detection using Ultralytics YOLO11.

Used for:
  1. Fast initial object detection + bounding boxes
  2. Item counting by class
  3. Confidence-filtered detections sent to Rust bbox post-processor

The YOLO results are merged with VLM semantic analysis for a richer inventory report.
"""
import io
import time
from typing import Any

import numpy as np
import structlog
from PIL import Image

from .config import settings

log = structlog.get_logger(__name__)

# Lazy-load YOLO to avoid import-time GPU init
_yolo_model = None


def _get_yolo():
    global _yolo_model
    if _yolo_model is None:
        try:
            from ultralytics import YOLO
            _yolo_model = YOLO(settings.yolo_model)
            log.info("yolo_model_loaded", model=settings.yolo_model)
        except Exception as exc:
            log.error("yolo_load_failed", error=str(exc))
            _yolo_model = None
    return _yolo_model


def run_yolo_detection(image_bytes: bytes) -> dict[str, Any]:
    """
    Run YOLO11 detection on image bytes.
    Returns detections with class labels, counts, confidence scores, and bounding boxes.
    """
    model = _get_yolo()
    if model is None:
        return {"detections": [], "counts": {}, "processing_ms": 0, "error": "YOLO unavailable"}

    start = time.perf_counter()
    try:
        img = Image.open(io.BytesIO(image_bytes)).convert("RGB")
        img_array = np.array(img)

        results = model.predict(
            source=img_array,
            conf=settings.yolo_conf_threshold,
            iou=settings.yolo_iou_threshold,
            max_det=settings.yolo_max_detections,
            verbose=False,
            device="cpu",  # CPU inference — GPU optional
        )

        detections = []
        counts: dict[str, int] = {}

        for result in results:
            boxes = result.boxes
            if boxes is None:
                continue
            for box in boxes:
                cls_id = int(box.cls[0].item())
                cls_name = result.names.get(cls_id, f"class_{cls_id}")
                conf = float(box.conf[0].item())
                x1, y1, x2, y2 = box.xyxy[0].tolist()

                detections.append({
                    "label": cls_name,
                    "confidence": round(conf, 4),
                    "bbox": {
                        "x1": round(x1, 1),
                        "y1": round(y1, 1),
                        "x2": round(x2, 1),
                        "y2": round(y2, 1),
                    },
                    "class_id": cls_id,
                })
                counts[cls_name] = counts.get(cls_name, 0) + 1

        elapsed_ms = int((time.perf_counter() - start) * 1000)
        log.info("yolo_detection_complete",
                 detections=len(detections),
                 elapsed_ms=elapsed_ms)

        return {
            "detections": detections,
            "counts": counts,
            "total_detected": len(detections),
            "processing_ms": elapsed_ms,
        }

    except Exception as exc:
        log.error("yolo_detection_failed", error=str(exc))
        return {"detections": [], "counts": {}, "processing_ms": 0, "error": str(exc)}
