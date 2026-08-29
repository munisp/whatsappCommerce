"""=== W34 otel-sidecars (Coder C) — fail-open OpenTelemetry for ai-agent ===

Same doctrine as kyc-verifier (services/kyc-verifier/app/telemetry.py):
telemetry FAILS OPEN — missing packages, a bad endpoint, or an unreachable
collector must never break a request; status is reported honestly via
/health.

Import-safe without opentelemetry or FastAPI installed (lazy imports only),
so J220-style tests can exercise it with the stdlib alone.

Env: OTEL_ENABLED (default "false"), OTEL_EXPORTER_OTLP_ENDPOINT
(default "http://otel-collector:4318").
"""
import os
from contextlib import contextmanager

# ─── W3C traceparent parsing (pure stdlib) ────────────────────────────────────
def parse_traceparent(header: str):
    """Parse a W3C `traceparent` header -> {"trace_id","parent_id","flags",
    "sampled"} or None when invalid."""
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


_state = {
    "enabled": False,
    "active": False,
    "exporter": None,
    "endpoint": None,
    "last_error": None,
    "service": None,
    # Honest depth note: manual spans (ai.agent.handle) + FastAPI
    # auto-instrumentation when the OTel SDK is present.
    "mode": "manual-spans+fastapi-auto",
}


def otel_enabled() -> bool:
    return os.getenv("OTEL_ENABLED", "false").strip().lower() == "true"


def init_telemetry(app=None, service_name: str = "ai-agent") -> bool:
    """Fail-open OTel init. Returns True only when the SDK initialized."""
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
            # FastAPI auto-instrumentation: inbound traceparent extraction.
            from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
            FastAPIInstrumentor.instrument_app(app)
        _state["active"] = True
        _state["last_error"] = None
        return True
    except Exception as exc:  # fail-open
        _state["active"] = False
        _state["last_error"] = f"{type(exc).__name__}: {exc}"
        return False


def telemetry_status() -> dict:
    return {
        "enabled": _state["enabled"],
        "active": _state["active"],
        "mode": _state["mode"] if _state["enabled"] else None,
        "exporter": _state["exporter"] if _state["enabled"] else None,
        "endpoint": _state["endpoint"] if _state["enabled"] else None,
        "last_error": _state["last_error"],
    }


def extract_trace_id(headers) -> str:
    """Inbound trace id from request headers (stdlib-only). None if absent/
    invalid. Used for the x-trace-id debug echo (trace continuation proof)."""
    if headers is None:
        return None
    getter = getattr(headers, "get", None)
    if getter is None:
        return None
    tp = getter("traceparent") or getter("Traceparent")
    parsed = parse_traceparent(tp) if tp else None
    return parsed["trace_id"] if parsed else None


@contextmanager
def agent_handle_span(tenant_id: str, operation: str = "intent"):
    """Manual span `ai.agent.handle` with tenant.id attr. When OTel is
    disabled (or SDK missing) this is an honest NO-OP — never faked depth."""
    if not _state["active"]:
        yield None
        return
    try:
        from opentelemetry import trace
        tracer = trace.get_tracer("ai-agent")
        with tracer.start_as_current_span(
            "ai.agent.handle",
            attributes={"tenant.id": tenant_id, "ai.operation": operation},
        ) as span:
            yield span
    except Exception:
        # Telemetry must never break request handling.
        yield None
