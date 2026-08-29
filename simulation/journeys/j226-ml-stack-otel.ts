/**
 * === W35 node-python-otel (Coder C) ===
 * J226 — ml-stack python telemetry: module import + fail-open + source wiring.
 *
 * Mirrors W34's python journey (J220): services/ml-stack/telemetry.py is
 * import-safe WITHOUT any opentelemetry packages (lazy imports, fail-open).
 * The real python3 interpreter asserts:
 *
 *   1. traceparent parsing (trace continuation contract).
 *   2. OTEL disabled by default (enabled=false/active=false).
 *   3. Fail-open honesty with OTEL_ENABLED=true and no SDK installed:
 *      init returns False, status reports enabled=true/active=false with an
 *      honest last_error instead of throwing.
 *   4. ml_span() is a bare no-op context manager when inactive.
 *
 * Then STATIC-SOURCE assertions verify the five instrumented files wire the
 * module (banner + span names) — the heavy files (torch/duckdb/fastapi) are
 * not importable here, exactly like W34's python journeys.
 */
import { execFile } from "child_process";
import path from "path";
import { promisify } from "util";
import { assert, type World } from "../world";
import type { Journey } from "../runner";

const execFileP = promisify(execFile);
const TRACEPARENT = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";

const PY_SNIPPET = `
import importlib.util, json, os, sys
path = sys.argv[1]
spec = importlib.util.spec_from_file_location("ml_telemetry", path)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

out = {}
# 1. traceparent parsing (continuation contract)
tp = m.parse_traceparent(${JSON.stringify(TRACEPARENT)})
out["trace_id"] = tp["trace_id"]
out["sampled"] = tp["sampled"]
out["echo"] = m.extract_trace_id({"traceparent": ${JSON.stringify(TRACEPARENT)}})
out["bad_traceparent"] = m.parse_traceparent("00-nothex-xyz-01")

# 2. disabled by default
os.environ.pop("OTEL_ENABLED", None)
st = m.telemetry_status()
out["default_enabled"] = st["enabled"]
out["default_active"] = st["active"]
out["init_default"] = m.init_telemetry()

# 4. ml_span bare no-op while inactive
with m.ml_span("ml.inference") as span:
    out["span_when_inactive"] = span

# 3. fail-open when enabled but SDK missing
os.environ["OTEL_ENABLED"] = "true"
out["init_enabled"] = m.init_telemetry()
st = m.telemetry_status()
out["enabled_enabled"] = st["enabled"]
out["enabled_active"] = st["active"]
out["enabled_last_error"] = st["last_error"]
with m.ml_span("ml.drift.check") as span:
    out["span_after_failed_init"] = span
os.environ.pop("OTEL_ENABLED", None)
print("J226JSON:" + json.dumps(out))
`;

export const journey: Journey = {
  id: "J226",
  name: "ml-stack python telemetry imports, parses traceparent, fails open honestly",
  feature: "W35 node-python-otel: ml-stack fail-open OTel",
  async run(_world: World) {
    const modulePath = path.resolve(process.cwd(), "services/ml-stack/telemetry.py");
    const { stdout } = await execFileP("python3", ["-c", PY_SNIPPET, modulePath], {
      cwd: path.resolve(process.cwd()),
      env: { ...process.env, OTEL_ENABLED: undefined } as any,
    });
    const line = stdout.trim().split("\n").find((l) => l.startsWith("J226JSON:"));
    assert(line, `python probe produced no J226JSON line (got: ${stdout.slice(0, 300)})`);
    const out = JSON.parse(line!.slice("J226JSON:".length));

    // 1. trace continuation
    assert(out.trace_id === TRACE_ID, `traceparent trace id parsed (${out.trace_id})`);
    assert(out.echo === TRACE_ID, "trace id echoed for continuation");
    assert(out.sampled === true, "sampled flag parsed");
    assert(out.bad_traceparent === null, "invalid traceparent rejected honestly");
    // 2. disabled by default
    assert(out.default_enabled === false && out.default_active === false,
      "OTEL disabled by default");
    assert(out.init_default === false, "init is a no-op when disabled");
    // 4. ml_span no-op while inactive
    assert(out.span_when_inactive === null, "ml_span yields None (bare) while inactive");
    // 3. fail-open when enabled without the SDK
    assert(out.enabled_enabled === true, "enabled flag honored");
    assert(out.init_enabled === false && out.enabled_active === false,
      "init failed OPEN (no SDK here) — pipeline never blocked");
    assert(typeof out.enabled_last_error === "string" && out.enabled_last_error.length > 0,
      `last_error reported honestly (${out.enabled_last_error})`);
    assert(out.span_after_failed_init === null, "ml_span still bare after failed init");

    // 5. static-source wiring assertions (heavy deps not importable here).
    const fs = await import("fs");
    const read = (p: string) => fs.readFileSync(path.resolve(process.cwd(), p), "utf8");

    const lakehouseRunner = read("services/ml-stack/lakehouse/pipeline.py");
    assert(lakehouseRunner.includes("# === W35 otel-ml-stack ==="), "lakehouse/pipeline.py banner");
    assert(lakehouseRunner.includes('"lakehouse.pipeline.run"'), "lakehouse.pipeline.run span");
    assert(lakehouseRunner.includes("import telemetry as _ml_telemetry"), "lakehouse/pipeline.py lazy import");

    const lakehouseLib = read("services/ml-stack/pipeline/lakehouse.py");
    assert(lakehouseLib.includes("# === W35 otel-ml-stack ==="), "pipeline/lakehouse.py banner");
    assert(lakehouseLib.includes('"lakehouse.pipeline.run"'), "pipeline/lakehouse.py span");

    const inference = read("services/ml-stack/inference/server.py");
    assert(inference.includes("# === W35 otel-ml-stack ==="), "inference/server.py banner");
    assert(inference.includes('"ml.inference"'), "ml.inference span");
    assert(inference.includes("init_telemetry(app=app"), "inference server init wires FastAPI app");
    assert(inference.includes("headers=request.headers"), "inference server extracts inbound traceparent");
    assert(inference.includes("_ml_telemetry.telemetry_status()"), "inference /health echoes telemetry status");

    const drift = read("services/ml-stack/monitoring/drift_detector.py");
    assert(drift.includes("# === W35 otel-ml-stack ==="), "drift_detector.py banner");
    assert(drift.includes('"ml.drift.check"'), "ml.drift.check span");

    const ab = read("services/ml-stack/monitoring/ab_testing.py");
    assert(ab.includes("# === W35 otel-ml-stack ==="), "ab_testing.py banner");
    assert(ab.includes('"ml.ab.evaluate"'), "ml.ab.evaluate span");

    const reqs = read("services/ml-stack/requirements.txt");
    assert(reqs.includes("opentelemetry-sdk==1.37.0"), "ml-stack requirements pins opentelemetry-sdk");
    assert(reqs.includes("opentelemetry-exporter-otlp-proto-http==1.37.0"),
      "ml-stack requirements pins the OTLP HTTP exporter");
  },
};
