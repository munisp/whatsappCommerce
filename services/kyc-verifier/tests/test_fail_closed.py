"""The verifier never invents a verdict (2026-11-09).

It used to answer "authentic, John Doe, Lagos Fresh Market Ltd" for ANY document whenever the vision model was slow
or down (and the 60 s timeout made a CPU model always "down"), and mock OCR text whenever OCR failed. Outside
VLM_MOCK_MODE=true it must raise VerificationUnavailable, which /verify/document turns into a 503.
"""
import asyncio
import pytest

from app.vlm_processor import VLMProcessor, VerificationUnavailable


def test_unreachable_vision_model_is_not_a_verdict(monkeypatch):
    monkeypatch.setenv("VLM_MOCK_MODE", "false")
    monkeypatch.setenv("OLLAMA_URL", "http://127.0.0.1:9")  # nothing listens here
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    vlm = VLMProcessor()
    with pytest.raises(VerificationUnavailable):
        asyncio.run(vlm.analyze_document(b"\x89PNG", "business_registration", "text", {}))


def test_an_answer_without_a_verdict_is_not_a_verdict(monkeypatch):
    monkeypatch.setenv("VLM_MOCK_MODE", "false")
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    vlm = VLMProcessor()

    async def half_answer(*_):  # what _call_ollama returns for a reply missing is_authentic / is_tampered
        return None
    monkeypatch.setattr(vlm, "_call_ollama", half_answer)
    with pytest.raises(VerificationUnavailable):
        asyncio.run(vlm.analyze_document(b"\x89PNG", "business_registration", "text", {}))


def test_mock_mode_still_mocks_when_asked(monkeypatch):
    monkeypatch.setenv("VLM_MOCK_MODE", "true")
    vlm = VLMProcessor()
    assert asyncio.run(vlm.analyze_document(b"x", "business_registration", "", {}))["notes"].startswith("[Mock VLM]")
