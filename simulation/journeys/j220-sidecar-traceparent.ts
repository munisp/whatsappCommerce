/**
 * J220 — W34 otel-sidecars: python sidecar traceparent extraction.
 *
 * The kyc-verifier / ai-agent telemetry modules are import-safe WITHOUT any
 * opentelemetry or FastAPI packages (lazy imports, fail-open). This journey
 * drives them with the real python3 interpreter and asserts:
 *
 * 1. Trace continuation: a W3C `traceparent` header is parsed and its
 *    trace id is the id the sidecar echoes/continues (same trace_id).
 * 2. OTEL is disabled by default: telemetry_status() reports
 *    enabled=false/active=false with no env set.
 * 3. Fail-open honesty: with OTEL_ENABLED=true but the SDK unavailable in
 *    this environment, init fails OPEN — status reports enabled=true,
 *    active=false, and an honest last_error instead of throwing.
 * 4. /health telemetry status: the exact block /health returns comes from
 *    telemetry_status() (verified against the source wiring).
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
spec = importlib.util.spec_from_file_location("sidecar_telemetry", path)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

out = {}
# 1. traceparent extraction (trace continuation)
tp = m.parse_traceparent(${JSON.stringify(TRACEPARENT)})
out["trace_id"] = tp["trace_id"]
out["sampled"] = tp["sampled"]
out["echo"] = m.extract_trace_id({"traceparent": ${JSON.stringify(TRACEPARENT)}})
out["bad_traceparent"] = m.parse_traceparent("00-nothex-xyz-01")

# 2. OTEL disabled by default
os.environ.pop("OTEL_ENABLED", None)
st = m.telemetry_status()
out["default_enabled"] = st["enabled"]
out["default_active"] = st["active"]
out["default_has_error"] = st["last_error"] is not None
out["init_default"] = m.init_telemetry()

# 3. fail-open when enabled but SDK missing (CI has no opentelemetry installed)
os.environ["OTEL_ENABLED"] = "true"
out["init_enabled"] = m.init_telemetry()
st = m.telemetry_status()
out["enabled_enabled"] = st["enabled"]
out["enabled_active"] = st["active"]
out["enabled_last_error"] = st["last_error"]
os.environ.pop("OTEL_ENABLED", None)
print("J220JSON:" + json.dumps(out))
`;

async function probeSidecar(modulePath: string) {
  const { stdout } = await execFileP("python3", ["-c", PY_SNIPPET, modulePath], {
    cwd: path.resolve(process.cwd()),
    env: { ...process.env, OTEL_ENABLED: undefined } as any,
  });
  const line = stdout.trim().split("\n").find((l) => l.startsWith("J220JSON:"));
  assert(line, `python probe produced no J220JSON line (got: ${stdout.slice(0, 300)})`);
  return JSON.parse(line!.slice("J220JSON:".length));
}

function assertSidecar(name: string, out: any) {
  // 1. trace continuation: the sidecar's extracted trace id IS the inbound
  //    traceparent's trace id — same trace, not a new root.
  assert(out.trace_id === TRACE_ID, `${name}: traceparent trace id parsed (${out.trace_id})`);
  assert(out.echo === TRACE_ID, `${name}: trace id echoed for continuation (${out.echo})`);
  assert(out.sampled === true, `${name}: sampled flag parsed`);
  assert(out.bad_traceparent === null, `${name}: invalid traceparent rejected honestly`);
  // 2. disabled by default
  assert(out.default_enabled === false && out.default_active === false,
    `${name}: OTEL disabled by default (enabled=${out.default_enabled} active=${out.default_active})`);
  assert(out.init_default === false, `${name}: init is a no-op when disabled`);
  // 3. fail-open honesty when enabled without the SDK
  assert(out.enabled_enabled === true, `${name}: enabled flag honored`);
  assert(out.init_enabled === false && out.enabled_active === false,
    `${name}: init failed OPEN (no SDK here) — requests never blocked`);
  assert(typeof out.enabled_last_error === "string" && out.enabled_last_error.length > 0,
    `${name}: last_error reported honestly (${out.enabled_last_error})`);
}

export const journey: Journey = {
  id: "J220",
  name: "python sidecars extract traceparent, fail-open OTel, honest /health telemetry status",
  feature: "W34 otel-sidecars: kyc-verifier / ai-agent OpenTelemetry",
  async run(_world: World) {
    const kyc = await probeSidecar(path.resolve(process.cwd(), "services/kyc-verifier/app/telemetry.py"));
    assertSidecar("kyc-verifier", kyc);
    const ai = await probeSidecar(path.resolve(process.cwd(), "ai-agent/api/telemetry.py"));
    assertSidecar("ai-agent", ai);

    // 4. /health wires telemetry_status() into its payload (source wiring).
    const fs = await import("fs");
    const kycMain = fs.readFileSync(path.resolve(process.cwd(), "services/kyc-verifier/app/main.py"), "utf8");
    assert(kycMain.includes('"telemetry": telemetry_status()'),
      "kyc-verifier /health echoes telemetry status");
    const aiMain = fs.readFileSync(path.resolve(process.cwd(), "ai-agent/api/main.py"), "utf8");
    assert(aiMain.includes('"telemetry": telemetry_status()'),
      "ai-agent /health echoes telemetry status");
    assert(aiMain.includes("agent_handle_span(req.tenant_id"),
      "ai-agent wraps handlers with manual ai.agent.handle spans");
  },
};
