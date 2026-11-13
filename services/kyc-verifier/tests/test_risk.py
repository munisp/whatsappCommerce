"""Risk means risk: higher is worse (2026-11-09; a fake, tampered document used to score 0)."""
from app.main import _compute_document_risk


def test_a_clean_document_is_low_risk_and_a_fake_one_high():
    clean = _compute_document_risk({"confidence": 0.99}, {"is_authentic": True, "is_tampered": False, "missing_fields": []})
    fake = _compute_document_risk({"confidence": 0.99}, {"is_authentic": False, "is_tampered": True, "missing_fields": ["date"]})
    assert clean == 0.0
    assert fake >= 0.8 and fake > clean
    assert _compute_document_risk({"confidence": 0.1}, {"is_authentic": False, "is_tampered": True, "missing_fields": ["a"] * 9}) == 1.0
