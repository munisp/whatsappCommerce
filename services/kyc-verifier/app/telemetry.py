"""=== W34 otel-sidecars (Coder C) — fail-open OpenTelemetry bootstrap ===

Doctrine: telemetry is FAIL-OPEN. An unreachable collector, a missing
opentelemetry package, or any init error must NEVER break a request — the
service reports its own telemetry status honestly instead.

Env:
  OTEL_ENABLED                 default "false" — dev/test behavior unchanged.
  OTEL_EXPORTER_OTLP_ENDPOINT  default "http://otel-collector:4318".

This module is import-safe WITHOUT any opentelemetry packages installed (all
OTel imports are lazy, inside init_telemetry) and without FastAPI, so unit
tests (J220) can exercise traceparent parsing + status reporting with the
stdlib alone.
"""
import os
import time

# ─── W3C traceparent parsing (pure stdlib) ────────────────────────────────────
def parse_traceparent(header: str):
    """Parse a W3C `traceparent` header. Returns
    {"trace_id", "parent_id", "flags", "sampled"} or None when invalid.

    Format: 00-<32 hex trace id>-<16 hex parent id>-<2 hex flags>
    """
    if not header or not isinstance(header, str):
        return None
    parts = header.strip().split("-")
    if len(parts) != 4:
        return None
    version, trace_id, parent_id, flags = parts
    try:
        if len(trace_id) != 32 or int(trace_id, 16) == 0:
            return None
        if len(parent_id) != 16 or int(parent_id, 16) == 0:
            return None
        if len(flags) != 2:
            return None
        int(version, 16)
        int(flags, 16)
    except ValueError:
        return None
    return {
        "trace_id": trace_id.lower(),
        "parent_id": parent_id.lower(),
        "flags": flags.lower(),
        "sampled": bool(int(flags, 16) & 0x01),
    }


# ─── Telemetry state (honest reporting) ───────────────────────────────────────
_state = {
    "enabled": False,          # OTEL_ENABLED requested
    "active": False,           # SDK actually initialized
    "exporter": None,          # "otlp-http" when configured
    "endpoint": None,
    "last_error": None,        # last init/export error, reported honestly
    "service": None,
}


def otel_enabled() -> bool:
    return os.getenv("OTEL_ENABLED", "false").strip().lower() == "true"


def init_telemetry(app=None, service_name: str = "kyc-verifier") -> bool:
    """Initialize OTel tracing when OTEL_ENABLED=true. Fail-open: any error
    (missing package, bad endpoint) is recorded in _state.last_error and
    False is returned; the caller continues normally."""
    enabled = otel_enabled()
    _state["enabled"] = enabled
    _state["service"] = service_name
    if not enabled:
        return False
    endpoint = os.getenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://otel-collector:4318").rstrip("/")
    _state["endpoint"] = endpoint
    _state["exporter"] = "otlp-http"
    try:
        from opentelemetry import trace
        from opentelemetry.sdk.resources import Resource
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.sdk.trace.export import BatchSpanProcessor
        from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter

        provider = TracerProvider(resource=Resource.create({
            "service.name": service_name,
            "service.version": "1.0.0",
            "deployment.environment": os.getenv("DEPLOYMENT_ENVIRONMENT", "production"),
        }))
        exporter = OTLPSpanExporter(endpoint=f"{endpoint}/v1/traces")
        provider.add_span_processor(BatchSpanProcessor(exporter))
        trace.set_tracer_provider(provider)
        if app is not None:
            # FastAPI auto-instrumentation: inbound traceparent extraction
            # (continues A's platform trace) + server spans per request.
            from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
            FastAPIInstrumentor.instrument_app(app)
        _state["active"] = True
        _state["last_error"] = None
        return True
    except Exception as exc:  # fail-open: never raise into the request path
        _state["active"] = False
        _state["last_error"] = f"{type(exc).__name__}: {exc}"
        return False


def telemetry_status() -> dict:
    """Honest telemetry status for /health (W30 pattern)."""
    return {
        "enabled": _state["enabled"],
        "active": _state["active"],
        "exporter": _state["exporter"] if _state["enabled"] else None,
        "endpoint": _state["endpoint"] if _state["enabled"] else None,
        "last_error": _state["last_error"],
    }


def extract_trace_id(headers) -> str:
    """Extract the inbound trace id from request headers (any mapping with
    case-insensitive get). Returns the 32-hex trace id or None. Works with or
    without the OTel SDK — used for the debug echo header so callers can
    verify trace continuation (J220)."""
    if headers is None:
        return None
    getter = getattr(headers, "get", None)
    if getter is None:
        return None
    tp = getter("traceparent") or getter("Traceparent")
    parsed = parse_traceparent(tp) if tp else None
    return parsed["trace_id"] if parsed else None
