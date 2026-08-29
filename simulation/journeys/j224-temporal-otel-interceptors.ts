/**
 * === W35 node-python-otel (Coder C) ===
 * J224 — Temporal OTel interceptors: fail-open + span naming.
 *
 * The manual interceptors (services/temporal-workflows/otelInterceptors.ts —
 * manual because @temporalio/interceptors-opentelemetry is NOT sanctioned)
 * are exercised with MOCK workflow/activity contexts (no Temporal server):
 *
 *   1. Disabled by default: createOtelWorkerInterceptors() returns null, so
 *      the worker config is byte-identical to pre-W35.
 *   2. Enabled: workflow execution wraps `next()` in a REAL span named
 *      `temporal.workflow.<workflowType>` (SERVER kind) which CONTINUES the
 *      traceparent carried in the activation headers.
 *   3. Activity execution wraps `temporal.activity.<activityType>` the same.
 *   4. Fail-open: handler errors propagate unchanged (span records the error
 *      but never swallows it); malformed headers degrade to a root span.
 */
import { assert, type World } from "../world";
import type { Journey } from "../runner";

const TRACEPARENT = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const PARENT_SPAN = "00f067aa0ba902b7";

function temporalPayload(value: string) {
  return { data: new TextEncoder().encode(value) };
}

export const journey: Journey = {
  id: "J224",
  name: "temporal manual OTel interceptors: fail-open, span naming, header propagation",
  feature: "W35 node-python-otel: temporal-workflows manual interceptors",
  async run(_world: World) {
    const interceptors = await import("../../services/temporal-workflows/otelInterceptors");
    const telemetry = await import("../../server/_core/telemetry");

    // ── 1. disabled by default → no interceptors ─────────────────────────
    delete process.env.OTEL_ENABLED;
    await telemetry.initTelemetry();
    assert(interceptors.createOtelWorkerInterceptors() === null,
      "interceptors are null while OTEL_ENABLED is unset");
    // Even with classes used directly while disabled: pass-through bare.
    const bareWf = new interceptors.OtelWorkflowInboundInterceptor();
    let bareRan = false;
    await bareWf.execute({ info: { workflowType: "x" } }, async () => { bareRan = true; return "ok"; });
    assert(bareRan, "workflow interceptor passes through while disabled");

    // ── enable telemetry (in-memory exporter) ────────────────────────────
    process.env.OTEL_ENABLED = "true";
    process.env.OTEL_TRACES_EXPORTER = "inmemory";
    await telemetry.initTelemetry();
    assert(telemetry.isTelemetryActive(), "telemetry did not activate");
    telemetry.clearRecordedSpans();

    try {
      const built = interceptors.createOtelWorkerInterceptors();
      assert(built && built.activity.length === 1 && built.workflow.length === 1,
        "worker interceptors built when enabled");

      // ── 2. workflow span: naming + trace continuation ──────────────────
      const workflow = new interceptors.OtelWorkflowInboundInterceptor();
      const wfInput = {
        info: { workflowType: "orderFulfillment", namespace: "default", taskQueue: "whatsapp-commerce", workflowId: "wf-j224" },
        headers: { traceparent: temporalPayload(TRACEPARENT) },
      };
      const wfResult = await workflow.execute(wfInput, async () => "workflow-done");
      assert(wfResult === "workflow-done", "workflow next() result propagated");

      const wfSpan = telemetry.getRecordedSpans().find((s) => s.name === "temporal.workflow.orderFulfillment");
      assert(wfSpan, "temporal.workflow.<name> span recorded");
      assert(wfSpan!.traceId === TRACE_ID, "workflow span continues the header trace");
      assert(wfSpan!.parentSpanId === PARENT_SPAN, "workflow span parents to the header span id");
      assert(wfSpan!.attributes["temporal.workflow_type"] === "orderFulfillment",
        "workflow_type attribute recorded");

      // ── 3. activity span ───────────────────────────────────────────────
      const activityFactory = built!.activity[0];
      const activity = activityFactory({
        info: { activityType: "confirmPayment", workflowNamespace: "default", taskQueue: "whatsapp-commerce", workflowId: "wf-j224" },
        headers: { traceparent: temporalPayload(TRACEPARENT) },
      }).inbound;
      const actResult = await activity.execute({ args: ["order-1"] }, async () => true);
      assert(actResult === true, "activity next() result propagated");
      const actSpan = telemetry.getRecordedSpans().find((s) => s.name === "temporal.activity.confirmPayment");
      assert(actSpan, "temporal.activity.<name> span recorded");
      assert(actSpan!.traceId === TRACE_ID, "activity span continues the header trace");

      // ── 4. fail-open: handler errors propagate; bad headers → root span ─
      const boom = new Error("activity failed");
      let propagated: Error | null = null;
      try {
        await activity.execute({ args: [] }, async () => { throw boom; });
      } catch (err) {
        propagated = err as Error;
      }
      assert(propagated === boom, "handler error propagates unchanged (fail-open for the caller)");
      const errSpan = telemetry.getRecordedSpans()
        .filter((s) => s.name === "temporal.activity.confirmPayment")
        .pop();
      assert(errSpan && errSpan.statusCode === 2, "error span recorded with ERROR status");

      const malformed = new interceptors.OtelWorkflowInboundInterceptor();
      const res2 = await malformed.execute(
        { info: { workflowType: "syncInventory" }, headers: { traceparent: temporalPayload("not-a-traceparent") } },
        async () => "ok",
      );
      assert(res2 === "ok", "malformed headers never block execution");
      const rootSpan = telemetry.getRecordedSpans().find((s) => s.name === "temporal.workflow.syncInventory");
      assert(rootSpan && rootSpan.traceId !== TRACE_ID && rootSpan.parentSpanId === null,
        "malformed traceparent degrades to an honest root span");
    } finally {
      delete process.env.OTEL_ENABLED;
      delete process.env.OTEL_TRACES_EXPORTER;
      await telemetry.initTelemetry();
    }
  },
};
