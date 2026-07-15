"""
Florence-2 Zero-Shot Object Detection Backend

Microsoft Florence-2 can detect and count objects using only text prompts —
no training data required. This makes it ideal for Nigerian FMCG products
before a fine-tuned YOLO model is available.

Supported tasks:
  - <OD>: Open-vocabulary object detection (bounding boxes + labels)
  - <CAPTION_TO_PHRASE_GROUNDING>: Ground text phrases to image regions
  - <DENSE_REGION_CAPTION>: Dense captioning of all detected regions
  - <REFERRING_EXPRESSION_SEGMENTATION>: Segment specific objects

Model variants:
  - microsoft/Florence-2-base (232M params, fast, good accuracy)
  - microsoft/Florence-2-large (771M params, slower, best accuracy)
  - microsoft/Florence-2-base-ft (fine-tuned on more tasks)

Usage via Ollama (if florence2 model is pulled):
  The service first tries Ollama, then falls back to HuggingFace transformers.
"""

import base64
import io
import json
import logging
import os
import re
from typing import Any, Optional

import httpx
from PIL import Image

logger = logging.getLogger(__name__)

OLLAMA_BASE_URL = os.getenv("OLLAMA_BASE_URL", "http://ollama:11434")
FLORENCE2_MODEL = os.getenv("FLORENCE2_MODEL", "florence2:base")  # ollama model tag
HF_FLORENCE2_MODEL = os.getenv("HF_FLORENCE2_MODEL", "microsoft/Florence-2-base")

# Nigerian FMCG product classes for grounding prompts
NIGERIAN_FMCG_CLASSES = [
    "Indomie noodles pack", "Maggi seasoning cube", "Knorr cube", "Royco cube",
    "Dano milk sachet", "Peak milk sachet", "Cowbell milk sachet",
    "Bigi Cola bottle", "Coca-Cola bottle", "Coca-Cola can",
    "Malta Guinness bottle", "Eva water bottle", "pure water sachet nylon bag",
    "Chivita juice pack", "Gino tomato paste sachet", "Tasty Tom tomato paste",
    "Mama Gold rice bag", "Caprice rice bag", "garri bag",
    "Devon King's vegetable oil bottle", "Mamador vegetable oil bottle",
    "Omo detergent sachet", "Ariel detergent sachet",
    "Key soap bar", "Dettol soap bar",
    "Vaseline petroleum jelly sachet", "Robb balm tin",
    "Cabin biscuit pack", "McVitie's digestive biscuit", "Dangote noodles pack",
]


def pil_to_base64(image: Image.Image, fmt: str = "JPEG") -> str:
    buf = io.BytesIO()
    image.save(buf, format=fmt)
    return base64.b64encode(buf.getvalue()).decode()


async def detect_with_florence2_ollama(
    image: Image.Image,
    product_hints: list[str],
    task: str = "<OD>",
) -> dict[str, Any]:
    """
    Call Florence-2 via Ollama's /api/generate endpoint.
    Ollama supports florence2 if the model is pulled:
      ollama pull florence2:base
    """
    img_b64 = pil_to_base64(image)

    # Build grounding prompt from product hints
    if product_hints:
        prompt_text = f"<CAPTION_TO_PHRASE_GROUNDING> Detect and locate: {', '.join(product_hints[:10])}"
    else:
        prompt_text = "<OD>"

    payload = {
        "model": FLORENCE2_MODEL,
        "prompt": prompt_text,
        "images": [img_b64],
        "stream": False,
        "options": {"temperature": 0.0},
    }

    async with httpx.AsyncClient(timeout=60.0) as client:
        resp = await client.post(f"{OLLAMA_BASE_URL}/api/generate", json=payload)
        resp.raise_for_status()
        result = resp.json()

    raw_response = result.get("response", "")
    return _parse_florence2_response(raw_response, image.size)


async def detect_with_florence2_hf(
    image: Image.Image,
    product_hints: list[str],
) -> dict[str, Any]:
    """
    Call Florence-2 via HuggingFace transformers (local model load).
    Falls back to this if Ollama is not available.
    Requires: pip install transformers torch einops timm
    """
    try:
        from transformers import AutoProcessor, AutoModelForCausalLM
        import torch
    except ImportError:
        return {"error": "transformers not installed. Run: pip install transformers torch einops timm"}

    logger.info(f"Loading Florence-2 from HuggingFace: {HF_FLORENCE2_MODEL}")
    device = "cuda" if torch.cuda.is_available() else "cpu"
    dtype = torch.float16 if device == "cuda" else torch.float32

    model = AutoModelForCausalLM.from_pretrained(
        HF_FLORENCE2_MODEL,
        torch_dtype=dtype,
        trust_remote_code=True,
    ).to(device)
    processor = AutoProcessor.from_pretrained(HF_FLORENCE2_MODEL, trust_remote_code=True)

    if product_hints:
        task_prompt = "<CAPTION_TO_PHRASE_GROUNDING>"
        text_input = f"Detect and locate: {', '.join(product_hints[:10])}"
    else:
        task_prompt = "<OD>"
        text_input = None

    inputs = processor(
        text=task_prompt + (text_input or ""),
        images=image,
        return_tensors="pt",
    ).to(device, dtype)

    with torch.no_grad():
        generated_ids = model.generate(
            input_ids=inputs["input_ids"],
            pixel_values=inputs["pixel_values"],
            max_new_tokens=1024,
            num_beams=3,
        )

    generated_text = processor.batch_decode(generated_ids, skip_special_tokens=False)[0]
    parsed = processor.post_process_generation(
        generated_text,
        task=task_prompt,
        image_size=(image.width, image.height),
    )

    return _format_florence2_detections(parsed, task_prompt, image.size)


def _parse_florence2_response(raw: str, image_size: tuple[int, int]) -> dict[str, Any]:
    """Parse Florence-2 Ollama response into standard detection format."""
    detections = []
    # Florence-2 returns JSON-like structure: {"<OD>": {"bboxes": [...], "labels": [...]}}
    try:
        data = json.loads(raw)
        task_key = list(data.keys())[0] if data else None
        if task_key and "bboxes" in data.get(task_key, {}):
            task_data = data[task_key]
            bboxes = task_data.get("bboxes", [])
            labels = task_data.get("labels", [])
            scores = task_data.get("scores", [1.0] * len(labels))
            w, h = image_size
            for bbox, label, score in zip(bboxes, labels, scores):
                x1, y1, x2, y2 = bbox
                detections.append({
                    "label": label,
                    "confidence": float(score),
                    "bbox": {
                        "x1": float(x1), "y1": float(y1),
                        "x2": float(x2), "y2": float(y2),
                        "x1_norm": x1 / w, "y1_norm": y1 / h,
                        "x2_norm": x2 / w, "y2_norm": y2 / h,
                    },
                })
    except (json.JSONDecodeError, KeyError, IndexError):
        # Try regex fallback for text-format responses
        pattern = r'"([^"]+)"\s*:\s*\[([^\]]+)\]'
        for match in re.finditer(pattern, raw):
            label = match.group(1)
            coords = [float(x) for x in match.group(2).split(",")]
            if len(coords) == 4:
                x1, y1, x2, y2 = coords
                w, h = image_size
                detections.append({
                    "label": label,
                    "confidence": 0.85,
                    "bbox": {
                        "x1": x1, "y1": y1, "x2": x2, "y2": y2,
                        "x1_norm": x1 / w, "y1_norm": y1 / h,
                        "x2_norm": x2 / w, "y2_norm": y2 / h,
                    },
                })

    return {"detections": detections, "backend": "florence2", "raw": raw[:500]}


def _format_florence2_detections(parsed: dict, task: str, image_size: tuple[int, int]) -> dict[str, Any]:
    """Format HuggingFace Florence-2 post-processed output into standard detection format."""
    detections = []
    task_data = parsed.get(task, {})
    bboxes = task_data.get("bboxes", [])
    labels = task_data.get("labels", [])
    scores = task_data.get("scores", [1.0] * len(labels))
    w, h = image_size

    for bbox, label, score in zip(bboxes, labels, scores):
        x1, y1, x2, y2 = bbox
        detections.append({
            "label": label,
            "confidence": float(score),
            "bbox": {
                "x1": float(x1), "y1": float(y1),
                "x2": float(x2), "y2": float(y2),
                "x1_norm": x1 / w, "y1_norm": y1 / h,
                "x2_norm": x2 / w, "y2_norm": y2 / h,
            },
        })

    return {"detections": detections, "backend": "florence2-hf"}


async def detect_products_florence2(
    image: Image.Image,
    product_hints: Optional[list[str]] = None,
    prefer_ollama: bool = True,
) -> dict[str, Any]:
    """
    Main entry point: detect Nigerian FMCG products using Florence-2.
    Tries Ollama first, falls back to HuggingFace transformers.
    """
    hints = product_hints or NIGERIAN_FMCG_CLASSES[:15]  # Use top 15 if no hints

    if prefer_ollama:
        try:
            # Check if Ollama has florence2 model
            async with httpx.AsyncClient(timeout=5.0) as client:
                check = await client.get(f"{OLLAMA_BASE_URL}/api/tags")
                models = [m["name"] for m in check.json().get("models", [])]

            if any("florence" in m.lower() for m in models):
                logger.info("Using Florence-2 via Ollama")
                return await detect_with_florence2_ollama(image, hints)
            else:
                logger.info(f"Florence-2 not in Ollama models ({models}), falling back to HF")
        except Exception as e:
            logger.warning(f"Ollama check failed: {e}, falling back to HF transformers")

    return await detect_with_florence2_hf(image, hints)


def aggregate_detections_to_counts(detections: list[dict]) -> dict[str, int]:
    """
    Convert raw bounding box detections to product counts.
    Groups by label (case-insensitive, normalised) and counts instances.
    """
    counts: dict[str, int] = {}
    for det in detections:
        label = det.get("label", "unknown").strip().lower()
        # Normalise common Nigerian FMCG label variants
        label = re.sub(r"\s+", " ", label)
        counts[label] = counts.get(label, 0) + 1
    return counts
