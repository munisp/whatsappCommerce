"""
Docling-based structured document parsing.
Extracts tables, form fields, layout structure from PDFs and images.
"""
import asyncio
import io
import structlog
from typing import Any

log = structlog.get_logger()

class DoclingProcessor:
    def __init__(self):
        self._initialized = False
        self._converter = None

    def _init_docling(self):
        if not self._initialized:
            try:
                from docling.document_converter import DocumentConverter
                self._converter = DocumentConverter()
                self._initialized = True
                log.info("docling.initialized")
            except ImportError:
                log.warning("docling.not_installed", fallback="mock_mode")
                self._initialized = True

    async def parse(self, content: bytes, mime_type: str) -> dict[str, Any]:
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(None, self._parse_sync, content, mime_type)

    def _parse_sync(self, content: bytes, mime_type: str) -> dict[str, Any]:
        self._init_docling()
        if self._converter is None:
            return self._mock_result()
        try:
            import tempfile, os
            ext = ".pdf" if "pdf" in mime_type else ".jpg"
            with tempfile.NamedTemporaryFile(suffix=ext, delete=False) as f:
                f.write(content)
                tmp_path = f.name
            result = self._converter.convert(tmp_path)
            os.unlink(tmp_path)
            doc = result.document
            return {
                "text": doc.export_to_markdown(),
                "tables": [t.export_to_dataframe().to_dict() for t in doc.tables] if doc.tables else [],
                "fields": {},
                "page_count": len(doc.pages) if doc.pages else 1,
                "structure_type": "docling",
            }
        except Exception as e:
            log.error("docling.parse_error", error=str(e))
            return self._mock_result()

    def _mock_result(self) -> dict[str, Any]:
        return {
            "text": "[Docling Mock] Structured document parsed",
            "tables": [],
            "fields": {"document_type": "identity", "issuer": "Government Authority"},
            "page_count": 1,
            "structure_type": "mock",
        }

