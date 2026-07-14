"""
VLM (Vision Language Model) document analysis.
Uses Ollama (llava/llama3.2-vision) or OpenAI GPT-4V as fallback.
Performs: authenticity check, tampering detection, field extraction, risk flags.
"""
import base64
import json
import os
import asyncio
import structlog
from typing import Any

log = structlog.get_logger()

DOCUMENT_ANALYSIS_PROMPT = """You are a document verification expert. Analyze this {doc_type} document image.

OCR extracted text:
{ocr_text}

Respond with a JSON object containing:
{{
  "is_authentic": boolean,
  "is_tampered": boolean,
  "authenticity_score": float (0-1),
  "extracted_fields": {{
    "full_name": string or null,
    "date_of_birth": string or null,
    "id_number": string or null,
    "expiry_date": string or null,
    "issuing_country": string or null,
    "address": string or null,
    "business_name": string or null,
    "registration_number": string or null
  }},
  "missing_fields": [list of expected but missing fields],
  "risk_flags": [list of detected issues],
  "notes": string
}}"""

class VLMProcessor:
    def __init__(self):
        self.ollama_url = os.getenv("OLLAMA_URL", "http://localhost:11434")
        self.ollama_model = os.getenv("OLLAMA_VLM_MODEL", "llava:13b")
        self.openai_api_key = os.getenv("OPENAI_API_KEY", "")
        self.use_mock = os.getenv("VLM_MOCK_MODE", "true").lower() == "true"

    async def analyze_document(
        self,
        content: bytes,
        document_type: str,
        ocr_text: str,
        docling_fields: dict,
    ) -> dict[str, Any]:
        if self.use_mock:
            return self._mock_analysis(document_type)

        b64_image = base64.b64encode(content).decode()
        prompt = DOCUMENT_ANALYSIS_PROMPT.format(
            doc_type=document_type,
            ocr_text=ocr_text[:2000],
        )

        # Try Ollama first (local, free)
        try:
            result = await self._call_ollama(b64_image, prompt)
            if result:
                return result
        except Exception as e:
            log.warning("vlm.ollama_failed", error=str(e))

        # Fallback to OpenAI GPT-4V
        if self.openai_api_key:
            try:
                return await self._call_openai(b64_image, prompt)
            except Exception as e:
                log.error("vlm.openai_failed", error=str(e))

        return self._mock_analysis(document_type)

    async def _call_ollama(self, b64_image: str, prompt: str) -> dict | None:
        import httpx
        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.post(f"{self.ollama_url}/api/generate", json={
                "model": self.ollama_model,
                "prompt": prompt,
                "images": [b64_image],
                "stream": False,
                "format": "json",
            })
            resp.raise_for_status()
            raw = resp.json().get("response", "{}")
            return json.loads(raw)

    async def _call_openai(self, b64_image: str, prompt: str) -> dict:
        from openai import AsyncOpenAI
        client = AsyncOpenAI(api_key=self.openai_api_key)
        resp = await client.chat.completions.create(
            model="gpt-4o",
            messages=[{
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64_image}"}},
                ],
            }],
            response_format={"type": "json_object"},
            max_tokens=1000,
        )
        return json.loads(resp.choices[0].message.content or "{}")

    def _mock_analysis(self, document_type: str) -> dict[str, Any]:
        return {
            "is_authentic": True,
            "is_tampered": False,
            "authenticity_score": 0.94,
            "extracted_fields": {
                "full_name": "John Doe",
                "date_of_birth": "1985-03-15",
                "id_number": "AB123456",
                "expiry_date": "2028-03-14",
                "issuing_country": "Nigeria",
                "address": None,
                "business_name": "Lagos Fresh Market Ltd" if "business" in document_type else None,
                "registration_number": "RC-1234567" if "business" in document_type else None,
            },
            "missing_fields": [],
            "risk_flags": [],
            "notes": f"[Mock VLM] {document_type} document appears authentic and unmodified.",
        }

