"""PaddleOCR must always run on its own single thread (2026-11-09): run from a second pool thread, its classifier
failed with oneDNN "could not execute a primitive", which the fail-closed verifier then reported as unavailable."""
import asyncio
import threading

from app.ocr_processor import OCRProcessor


def test_every_call_runs_on_the_same_dedicated_thread(monkeypatch):
    ocr = OCRProcessor()
    seen = []
    monkeypatch.setattr(ocr, "_process_sync", lambda *_: seen.append(threading.get_ident()) or {"text": ""})
    for _ in range(3):  # separate event loops, as different requests / default executors would be
        asyncio.run(ocr.process(b"x", "image/png"))
    assert len(set(seen)) == 1 and seen[0] != threading.get_ident()
