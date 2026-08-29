/**
 * === W35 node-python-otel (Coder C) ===
 * J223 — Kafka traceparent header injection/extraction round-trip.
 *
 * Unit-level via the exported helpers of server/kafka.ts (no broker needed —
 * the producer is mocked by exercising the helpers directly):
 *
 *   1. injectKafkaTraceHeaders writes a LOWERCASE `traceparent` key (binding
 *      contract with the Rust fluvio-consumer) carrying the active span's
 *      W3C context.
 *   2. extractKafkaTraceparent reads it back identically — including from a
 *      Buffer value, the shape kafkajs delivers on the consumer side.
 *   3. withKafkaConsumeSpan starts a REAL `kafka.consume` span whose traceId
 *      equals the injected trace and whose parent is the injected span —
 *      i.e. the consumer CONTINUES the producer's trace.
 *   4. Fail-open: with telemetry disabled, injection adds nothing and the
 *      helpers pass through bare; publishEvents with no broker never throws.
 */
import { assert, type World } from "../world";
import type { Journey } from "../runner";

const TRACEPARENT_RE = /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/;

export const journey: Journey = {
  id: "J223",
  name: "kafka traceparent inject/extract round-trip + consume span continuation",
  feature: "W35 node-python-otel: kafkajs spans + W3C traceparent headers",
  async run(_world: World) {
    const telemetry = await import("../../server/_core/telemetry");
    const kafka = await import("../../server/kafka");
    const api = await import("@opentelemetry/api");

    // ── 4a. fail-open while disabled: helpers pass through ───────────────
    delete process.env.OTEL_ENABLED;
    await telemetry.initTelemetry();
    const bare = kafka.injectKafkaTraceHeaders({});
    assert(Object.keys(bare).length === 0, "injection must be a no-op while telemetry is disabled");
    assert(kafka.extractKafkaTraceparent(null) === null, "extract on null headers → null");
    let consumeRan = false;
    await kafka.withKafkaConsumeSpan("wacommerce.orders", null, null, async () => { consumeRan = true; });
    assert(consumeRan, "consume helper runs bare while disabled");
    // publishEvents with no broker configured: best-effort, never throws.
    await kafka.publishEvents([{ topic: "wacommerce.orders", value: { orderId: "j223", tenantId: "j223-t" } }]);

    // ── enable telemetry (in-memory exporter) ────────────────────────────
    process.env.OTEL_ENABLED = "true";
    process.env.OTEL_TRACES_EXPORTER = "inmemory";
    await telemetry.initTelemetry();
    assert(telemetry.isTelemetryActive(), "telemetry did not activate");
    telemetry.clearRecordedSpans();

    try {
      const tracer = api.trace.getTracer("j223");
      // ── 1/2. inject inside an active producer span, extract back ──────
      let injectedTraceId = "";
      let injectedSpanId = "";
      await tracer.startActiveSpan("kafka.produce", { kind: api.SpanKind.PRODUCER }, async (producerSpan) => {
        const headers = kafka.injectKafkaTraceHeaders({});
        const tp = headers["traceparent"];
        assert(typeof tp === "string" && TRACEPARENT_RE.test(tp),
          `traceparent header injected (lowercase key), got: ${String(tp)}`);
        assert(!("traceParent" in headers) && !("Traceparent" in headers),
          "header key must be exactly lowercase `traceparent`");

        // Round-trip: string form AND Buffer form (kafkajs consumer shape).
        assert(kafka.extractKafkaTraceparent(headers) === tp, "string round-trip");
        const bufHeaders = { traceparent: Buffer.from(String(tp), "utf8") };
        assert(kafka.extractKafkaTraceparent(bufHeaders) === tp, "buffer round-trip");
        assert(kafka.extractKafkaTraceparent({ traceparent: "garbage" }) === null,
          "malformed traceparent rejected honestly");

        injectedTraceId = producerSpan.spanContext().traceId;
        injectedSpanId = producerSpan.spanContext().spanId;
        assert(tp!.includes(injectedTraceId), "header carries the producer span's trace id");

        // ── 3. consume span CONTINUES the producer trace ────────────────
        let handlerResult = "";
        await kafka.withKafkaConsumeSpan("wacommerce.orders", bufHeaders, "j223-t", async () => {
          const active = api.trace.getActiveSpan();
          assert(active?.spanContext().traceId === injectedTraceId,
            "consumer span shares the producer trace id");
          handlerResult = "handled";
        });
        assert(handlerResult === "handled", "consume handler executed");
        producerSpan.end();
      });

      const spans = telemetry.getRecordedSpans();
      const consumeSpan = spans.find((s) => s.name === "kafka.consume");
      assert(consumeSpan, "kafka.consume span recorded");
      assert(consumeSpan!.traceId === injectedTraceId, "consume span continues producer trace");
      assert(consumeSpan!.parentSpanId === injectedSpanId,
        `consume span parent is the producer span (got ${consumeSpan!.parentSpanId})`);
      assert(consumeSpan!.attributes["messaging.system"] === "kafka", "messaging.system=kafka");
      assert(consumeSpan!.attributes["messaging.destination"] === "wacommerce.orders",
        "messaging.destination recorded");
      assert(consumeSpan!.attributes["tenant.id"] === "j223-t", "tenant.id attribute recorded");
    } finally {
      // Cleanup: later journeys see the default (disabled) config.
      delete process.env.OTEL_ENABLED;
      delete process.env.OTEL_TRACES_EXPORTER;
      await telemetry.initTelemetry();
    }
  },
};
