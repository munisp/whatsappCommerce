"""The service must start. main.py imported a KYCApplicationSummary that models.py never defined, so the app
couldn't be imported at all — which no test noticed, because none imported it (2026-11-09)."""


def test_the_app_imports_and_has_its_routes():
    from app.main import app
    paths = {r.path for r in app.routes}
    assert {"/health", "/verify/document"} <= paths
