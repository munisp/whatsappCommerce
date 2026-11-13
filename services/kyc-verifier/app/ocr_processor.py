"""
PaddleOCR-based document text extraction.
Returns structured text with bounding boxes and confidence scores.
"""
import asyncio
from concurrent.futures import ThreadPoolExecutor
import base64
import io
import structlog
from typing import Any

from .vlm_processor import VerificationUnavailable, mock_mode

log = structlog.get_logger()

class OCRProcessor:
    def __init__(self):
        self._ocr = None
        self._initialized = False
        # Paddle (oneDNN) must set up and run on ONE thread: on another pool thread the classifier fails with
        # "could not execute a primitive". It isn't thread-safe either, so this also serialises inference.
        self._thread = ThreadPoolExecutor(max_workers=1, thread_name_prefix="paddleocr")

    def _init_ocr(self):
        """Lazy-init PaddleOCR to avoid slow startup."""
        if not self._initialized:
            try:
                # cv2 must be loaded before paddle: `import paddleocr` first segfaults in this image (opencv /
                # paddle shared-library clash). The service happened to import cv2 earlier; don't rely on that.
                import cv2  # noqa: F401
                from paddleocr import PaddleOCR
                self._ocr = PaddleOCR(
                    use_angle_cls=True,
                    lang="en",
                    use_gpu=False,
                    show_log=False,
                    enable_mkldnn=False,
                )
                self._initialized = True
                log.info("paddleocr.initialized")
            except ImportError:
                if not mock_mode():
                    raise VerificationUnavailable("OCR is not installed")
                log.warning("paddleocr.not_installed", fallback="mock_mode")
                self._initialized = True  # Use mock mode (VLM_MOCK_MODE=true only)

    async def process(self, content: bytes, mime_type: str) -> dict[str, Any]:
        """Run OCR on document bytes. Returns text, confidence, and bounding boxes."""
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(self._thread, self._process_sync, content, mime_type)

    def _process_sync(self, content: bytes, mime_type: str) -> dict[str, Any]:
        self._init_ocr()
        if self._ocr is None:
            # Mock mode for development/testing
            return self._mock_result()

        try:
            import numpy as np
            from PIL import Image
            img = Image.open(io.BytesIO(content)).convert("RGB")
            img_array = np.array(img)
            result = self._ocr.ocr(img_array, cls=True)

            lines = []
            total_conf = 0.0
            count = 0
            full_text = []

            if result and result[0]:
                for line in result[0]:
                    bbox, (text, conf) = line
                    lines.append({"text": text, "confidence": conf, "bbox": bbox})
                    full_text.append(text)
                    total_conf += conf
                    count += 1

            return {
                "text": "\n".join(full_text),
                "confidence": total_conf / count if count > 0 else 0.0,
                "lines": lines,
                "line_count": count,
            }
        except Exception as e:
            log.error("paddleocr.error", error=str(e))
            if mock_mode():
                return self._mock_result()
            raise VerificationUnavailable("OCR failed") from e

    def _mock_result(self) -> dict[str, Any]:
        return {
            "text": "[OCR Mock] Document text extracted successfully",
            "confidence": 0.92,
            "lines": [{"text": "Mock OCR line", "confidence": 0.92, "bbox": [[0,0],[100,0],[100,20],[0,20]]}],
            "line_count": 1,
        }

