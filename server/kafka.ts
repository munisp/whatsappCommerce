/**
 * server/kafka.ts — KafkaJS producer/consumer module
 *
 * Topics used by the platform:
 *   wacommerce.orders        — new order events
 *   wacommerce.payments      — payment state transitions
 *   wacommerce.conversations — conversation lifecycle events
 *   wacommerce.inventory     — stock change events
 *   wacommerce.hermes.po     — Hermes PO draft events
 *
 * Falls back gracefully when KAFKA_BROKERS is not configured.
 */
import { ENV } from "./_core/env";

// === W35 kafka-otel ===
// Manual Kafka tracing on top of the (W35-registered) kafkajs auto-
// instrumentation: producer/consumer spans + W3C `traceparent` propagation in
// message headers (lowercase key `traceparent` — BINDING contract with the
// Rust fluvio-consumer, which continues these traces). Fail-open: telemetry
// faults never block a publish/consume.
import { trace, context, propagation, SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { isTelemetryActive, noteTelemetryError } from "./_core/telemetry";

/** Kafka header bag: kafkajs values may be Buffer or string. */
export type KafkaHeaders = Record<string, string | Buffer | undefined>;

/** Inject the active W3C trace context into Kafka message headers. */
export function injectKafkaTraceHeaders(headers: KafkaHeaders = {}): KafkaHeaders {
  if (!isTelemetryActive()) return headers;
  try {
    propagation.inject(context.active(), headers, {
      set: (carrier, key, value) => {
        (carrier as Record<string, string>)[key.toLowerCase()] = value;
      },
    });
  } catch (err) {
    noteTelemetryError("kafka-inject", err);
  }
  return headers;
}

/** Extract the raw `traceparent` header value (string) from Kafka headers. */
export function extractKafkaTraceparent(headers: KafkaHeaders | undefined | null): string | null {
  if (!headers) return null;
  try {
    const raw = headers["traceparent"];
    if (raw == null) return null;
    const value = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
    return /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/.test(value) ? value : null;
  } catch {
    return null;
  }
}

/** Build a parent context from inbound Kafka message headers (fail-open). */
export function extractKafkaContext(headers: KafkaHeaders | undefined | null) {
  if (!isTelemetryActive()) return context.active();
  try {
    const carrier: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers ?? {})) {
      if (v == null) continue;
      carrier[k.toLowerCase()] = Buffer.isBuffer(v) ? v.toString("utf8") : String(v);
    }
    return propagation.extract(context.active(), carrier);
  } catch (err) {
    noteTelemetryError("kafka-extract", err);
    return context.active();
  }
}

interface KafkaSpanOptions {
  kind: "producer" | "consumer";
  topic: string;
  tenantId?: string | null;
  parent?: ReturnType<typeof context.active>;
}

async function withKafkaSpan<T>(opts: KafkaSpanOptions, fn: () => Promise<T>): Promise<T> {
  if (!isTelemetryActive()) return fn();
  try {
    const tracer = trace.getTracer("whatsapp-commerce-kafka");
    const spanName = opts.kind === "producer" ? "kafka.produce" : "kafka.consume";
    const attrs: Record<string, string> = {
      "messaging.system": "kafka",
      "messaging.destination": opts.topic,
    };
    if (opts.tenantId) attrs["tenant.id"] = opts.tenantId;
    const ctx = opts.parent ?? context.active();
    return await tracer.startActiveSpan(
      spanName,
      { kind: opts.kind === "producer" ? SpanKind.PRODUCER : SpanKind.CONSUMER, attributes: attrs },
      ctx,
      async (span) => {
        try {
          const result = await fn();
          span.setStatus({ code: SpanStatusCode.OK });
          return result;
        } catch (err) {
          span.recordException(err as Error);
          span.setStatus({ code: SpanStatusCode.ERROR });
          (err as { __w35KafkaHandlerError?: boolean }).__w35KafkaHandlerError = true;
          throw err;
        } finally {
          span.end();
        }
      },
    );
  } catch (err) {
    if (err && (err as { __w35KafkaHandlerError?: boolean }).__w35KafkaHandlerError) throw err;
    // Telemetry machinery itself failed — fail OPEN: run bare. Real fn()
    // errors were already rethrown inside the span callback above; reaching
    // here means tracer/startActiveSpan broke.
    noteTelemetryError("kafka-span", err);
    return fn();
  }
}

/**
 * Consumer-side helper: start a `kafka.consume` span whose parent is the
 * producer's traceparent header, then run the handler. Used by any Node
 * consumer; the Rust fluvio-consumer performs the same extraction natively.
 */
export async function withKafkaConsumeSpan<T>(
  topic: string,
  headers: KafkaHeaders | undefined | null,
  tenantId: string | null | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const parent = extractKafkaContext(headers);
  return withKafkaSpan({ kind: "consumer", topic, tenantId, parent }, fn);
}
// === END W35 kafka-otel ===

// Lazy-loaded KafkaJS instance
let _kafka: import("kafkajs").Kafka | null = null;
let _producer: import("kafkajs").Producer | null = null;
let _connectAttempted = false;

async function getKafka() {
  if (_kafka) return _kafka;
  if (_connectAttempted) return null;
  _connectAttempted = true;
  if (!ENV.kafkaBrokers || ENV.kafkaBrokers === "kafka:9092") {
    // Only attempt if explicitly configured beyond the default placeholder
    if (!process.env.KAFKA_BROKERS) {
      console.info("[Kafka] KAFKA_BROKERS not set — Kafka features disabled");
      return null;
    }
  }
  try {
    const { Kafka } = await import("kafkajs");
    _kafka = new Kafka({
      clientId: ENV.kafkaClientId,
      brokers: ENV.kafkaBrokers.split(","),
      connectionTimeout: 5000,
      requestTimeout: 10000,
      retry: { retries: 3, initialRetryTime: 300 },
    });
    return _kafka;
  } catch (err: any) {
    console.warn("[Kafka] Failed to initialise:", err.message);
    return null;
  }
}

async function getProducer() {
  if (_producer) return _producer;
  const kafka = await getKafka();
  if (!kafka) return null;
  try {
    _producer = kafka.producer({ allowAutoTopicCreation: true });
    await _producer.connect();
    console.info("[Kafka] Producer connected");
    return _producer;
  } catch (err: any) {
    console.warn("[Kafka] Producer connect failed:", err.message);
    _producer = null;
    return null;
  }
}

export interface KafkaEvent {
  topic: string;
  key?: string;
  value: Record<string, unknown>;
}

/** Publish one or more events to Kafka. Best-effort — never throws. */
export async function publishEvents(events: KafkaEvent[]): Promise<void> {
  const producer = await getProducer();
  if (!producer) return;
  try {
    // === W35 kafka-otel ===
    // Per-topic `kafka.produce` span + traceparent header injection (INSIDE
    // the span, so headers carry the produce span's context) — the Rust
    // fluvio-consumer (and any Node consumer via withKafkaConsumeSpan)
    // continues this trace. tenant.id from the payload when present.
    const byTopic = new Map<string, KafkaEvent[]>();
    for (const e of events) {
      if (!byTopic.has(e.topic)) byTopic.set(e.topic, []);
      byTopic.get(e.topic)!.push(e);
    }
    await Promise.all(
      Array.from(byTopic.entries()).map(([topic, topicEvents]) => {
        const tenantId = topicEvents.find((e) => typeof e.value?.tenantId === "string")?.value?.tenantId as string | undefined;
        return withKafkaSpan(
          { kind: "producer", topic, tenantId: tenantId ?? null },
          () => producer.send({
            topic,
            messages: topicEvents.map((e) => ({
              key: e.key,
              value: JSON.stringify({ ...e.value, _ts: Date.now() }),
              headers: injectKafkaTraceHeaders({}),
            })),
          }),
        );
      })
    );
    // === END W35 kafka-otel ===
  } catch (err: any) {
    console.warn("[Kafka] publishEvents failed:", err.message);
  }
}

/** Publish a single typed platform event. */
export async function publishOrderEvent(orderId: string, tenantId: string, status: string, meta?: Record<string, unknown>) {
  await publishEvents([{ topic: "wacommerce.orders", key: orderId, value: { orderId, tenantId, status, ...meta } }]);
}

export async function publishPaymentEvent(paymentId: string, tenantId: string, status: string, meta?: Record<string, unknown>) {
  await publishEvents([{ topic: "wacommerce.payments", key: paymentId, value: { paymentId, tenantId, status, ...meta } }]);
}

export async function publishConversationEvent(conversationId: string, tenantId: string, eventType: string, meta?: Record<string, unknown>) {
  await publishEvents([{ topic: "wacommerce.conversations", key: conversationId, value: { conversationId, tenantId, eventType, ...meta } }]);
}

export async function publishInventoryEvent(productId: string, tenantId: string, delta: number, meta?: Record<string, unknown>) {
  await publishEvents([{ topic: "wacommerce.inventory", key: productId, value: { productId, tenantId, delta, ...meta } }]);
}

export async function publishHermesPOEvent(poId: string, tenantId: string, status: string, meta?: Record<string, unknown>) {
  await publishEvents([{ topic: "wacommerce.hermes.po", key: poId, value: { poId, tenantId, status, ...meta } }]);
}

/** Health check — returns latency in ms or error. */
export async function kafkaHealthCheck(): Promise<{ online: boolean; latencyMs?: number; error?: string }> {
  try {
    const kafka = await getKafka();
    if (!kafka) return { online: false, error: "not_configured" };
    const admin = kafka.admin();
    const t0 = Date.now();
    await admin.connect();
    await admin.listTopics();
    await admin.disconnect();
    return { online: true, latencyMs: Date.now() - t0 };
  } catch (err: any) {
    return { online: false, error: err.message };
  }
}
