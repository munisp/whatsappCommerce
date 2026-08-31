"""=== W35 otel-ml-stack (Coder C) — fail-open OpenTelemetry for the ML stack ===

Mirrors the W34 python sidecar pattern (services/kyc-verifier/app/telemetry.py):
telemetry is FAIL-OPEN. A missing opentelemetry package, an unreachable
collector, or any init error must NEVER break inference/pipeline/monitoring —
the module reports its own status honestly instead.

Env:
  OTEL_ENABLED                 default "false" — dev/test behavior unchanged.
  OTEL_EXPORTER_OTLP_ENDPOINT  default "http://otel-collector:4318".

Import-safe with the STDLIB ALONE (all OTel imports are lazy, inside
init_telemetry / span helpers) so journeys (J226) can exercise traceparent
parsing + status reporting without any opentelemetry packages installed.
"""
import os
from contextlib import contextmanager

# ─── W3C traceparent parsing (pure stdlib) ────────────────────────────────────
def parse_traceparent(header):
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
    "enabled": False,
    "active": False,
    "exporter": None,
    "endpoint": None,
    "last_error": None,
    "service": None,
}


def otel_enabled() -> bool:
    return os.getenv("OTEL_ENABLED", "false").strip().lower() == "true"


def init_telemetry(app=None, service_name: str = "ml-stack") -> bool:
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
            "service.namespace": "whatsappcommerce",
            "deployment.environment": os.getenv("DEPLOYMENT_ENVIRONMENT", "production"),
        }))
        exporter = OTLPSpanExporter(endpoint=f"{endpoint}/v1/traces")
        provider.add_span_processor(BatchSpanProcessor(exporter))
        trace.set_tracer_provider(provider)
        fastapi_warning = None
        if app is not None:
            # FastAPI auto-instrumentation (optional dep): inbound
            # traceparent extraction + server spans per request.
            try:
                from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
                FastAPIInstrumentor.instrument_app(app)
            except Exception as exc:
                fastapi_warning = f"fastapi-instrumentation: {type(exc).__name__}: {exc}"
        _state["active"] = True
        _state["last_error"] = fastapi_warning
        return True
    except Exception as exc:  # fail-open: never raise into the request path
        _state["active"] = False
        _state["last_error"] = f"{type(exc).__name__}: {exc}"
        return False


def telemetry_status() -> dict:
    """Honest telemetry status for /health."""
    return {
        "enabled": _state["enabled"],
        "active": _state["active"],
        "exporter": _state["exporter"] if _state["enabled"] else None,
        "endpoint": _state["endpoint"] if _state["enabled"] else None,
        "last_error": _state["last_error"],
    }


def extract_trace_id(headers):
    """Extract the inbound trace id from request headers (any mapping with a
    case-insensitive-ish get). Returns the 32-hex trace id or None. Works
    with or without the OTel SDK (J226)."""
    if headers is None:
        return None
    getter = getattr(headers, "get", None)
    if getter is None:
        return None
    tp = getter("traceparent") or getter("Traceparent")
    parsed = parse_traceparent(tp) if tp else None
    return parsed["trace_id"] if parsed else None


@contextmanager
def ml_span(name, attributes=None, headers=None):
    """Fail-open span context manager. When OTel is disabled or unavailable,
    yields None and runs the body bare. When `headers` are given and the SDK
    is active, the inbound traceparent is extracted so the span CONTINUES the
    caller's trace (same trace_id).
    """
    if not _state.get("active"):
        yield None
        return
    try:
        from opentelemetry import trace
        from opentelemetry.trace import SpanKind
        ctx = None
        if headers is not None:
            getter = getattr(headers, "get", None)
            if getter is not None:
                tp = getter("traceparent") or getter("Traceparent")
                parsed = parse_traceparent(tp) if tp else None
                if parsed:
                    from opentelemetry.trace import NonRecordingSpan, SpanContext, TraceFlags
                    from opentelemetry.trace import set_span_in_context
                    parent = SpanContext(
                        trace_id=int(parsed["trace_id"], 16),
                        span_id=int(parsed["parent_id"], 16),
                        is_remote=True,
                        trace_flags=TraceFlags(0x01 if parsed["sampled"] else 0x00),
                    )
                    ctx = set_span_in_context(NonRecordingSpan(parent))
        tracer = trace.get_tracer("whatsapp-commerce-ml-stack")
        with tracer.start_as_current_span(
            name, kind=SpanKind.INTERNAL, attributes=attributes or {}, context=ctx
        ) as span:
            yield span
    except Exception as exc:
        _state["last_error"] = f"span {name}: {type(exc).__name__}: {exc}"
        yield None
