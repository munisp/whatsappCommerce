"""
Ollama VLM client.

Supports vision models:
  - qwen2.5vl:7b / qwen2.5vl:3b   (Qwen2.5-VL — best for structured JSON + counting)
  - minicpm-v:8b                    (MiniCPM-V — lightweight, fast)
  - gemma3:12b / gemma3:4b          (Gemma 3 — strong reasoning)
  - llava:13b / llava:7b            (LLaVA — fallback)

All models are called via Ollama's /api/chat endpoint with base64-encoded images.
"""
import base64
import json
import httpx
import structlog
from pathlib import Path
from typing import Any

from .config import settings

log = structlog.get_logger(__name__)


async def probe_available_model() -> str:
    """Query Ollama /api/tags and return the first available VLM from priority list."""
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(f"{settings.ollama_base_url}/api/tags")
            if resp.status_code != 200:
                return settings.vlm_model_priority[-1]
            data = resp.json()
            available = {m["name"] for m in data.get("models", [])}
            for model in settings.vlm_model_priority:
                if model in available:
                    log.info("ollama_model_selected", model=model)
                    return model
    except Exception as exc:
        log.warning("ollama_probe_failed", error=str(exc))
    return settings.vlm_model_priority[0]  # optimistic default


def _encode_image(image_bytes: bytes) -> str:
    return base64.b64encode(image_bytes).decode("utf-8")


INVENTORY_SYSTEM_PROMPT = """You are an expert retail inventory analyst with computer vision capabilities.
Your task is to analyse shelf/storage images and count products with precision.

RULES:
1. Count EVERY visible distinct product/item type separately.
2. Estimate quantities even when items are partially obscured.
3. Group identical items together (same packaging, label, colour).
4. Return ONLY valid JSON — no markdown fences, no prose.
5. Confidence: 0.0-1.0 (1.0 = certain count, 0.5 = rough estimate).

OUTPUT FORMAT (strict JSON):
{
  "scene_description": "Brief description of the storage/shelf scene",
  "total_unique_products": <integer>,
  "total_items_counted": <integer>,
  "items": [
    {
      "label": "Product name or description",
      "count": <integer>,
      "confidence": <float 0-1>,
      "location": "shelf position e.g. top-left, bottom-right",
      "notes": "any relevant notes e.g. partially hidden, stacked"
    }
  ],
  "inventory_notes": "Overall notes about stock condition, organisation, visible issues"
}"""


async def analyse_image_with_vlm(
    image_bytes: bytes,
    product_hints: list[str] | None = None,
    model: str | None = None,
) -> dict[str, Any]:
    """
    Send image to Ollama VLM for inventory analysis.
    Returns parsed JSON inventory result.
    """
    model = model or settings.active_vlm_model
    encoded = _encode_image(image_bytes)

    hint_text = ""
    if product_hints:
        hint_text = f"\n\nKnown products in this inventory: {', '.join(product_hints)}. Match detected items to these names where possible."

    user_prompt = f"Analyse this inventory image and count all visible products.{hint_text}\n\nReturn the JSON inventory report."

    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": INVENTORY_SYSTEM_PROMPT},
            {
                "role": "user",
                "content": user_prompt,
                "images": [encoded],
            },
        ],
        "stream": False,
        "options": {
            "temperature": 0.1,   # low temp for deterministic counting
            "top_p": 0.9,
            "num_predict": 2048,
        },
        "format": "json",         # Ollama structured output
    }

    try:
        async with httpx.AsyncClient(timeout=120) as client:
            resp = await client.post(
                f"{settings.ollama_base_url}/api/chat",
                json=payload,
            )
            resp.raise_for_status()
            data = resp.json()
            content = data.get("message", {}).get("content", "{}")
            # Parse JSON response
            result = json.loads(content) if isinstance(content, str) else content
            result["model_used"] = model
            return result
    except json.JSONDecodeError as exc:
        log.error("vlm_json_parse_error", error=str(exc))
        return {
            "scene_description": "Parse error",
            "total_unique_products": 0,
            "total_items_counted": 0,
            "items": [],
            "inventory_notes": f"VLM returned non-JSON response: {str(exc)}",
            "model_used": model,
            "error": str(exc),
        }
    except Exception as exc:
        log.error("vlm_call_failed", error=str(exc), model=model)
        return {
            "scene_description": "VLM unavailable",
            "total_unique_products": 0,
            "total_items_counted": 0,
            "items": [],
            "inventory_notes": f"Ollama error: {str(exc)}",
            "model_used": model,
            "error": str(exc),
        }
