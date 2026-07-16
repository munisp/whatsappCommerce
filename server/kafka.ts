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
    const byTopic = new Map<string, { key?: string; value: string }[]>();
    for (const e of events) {
      if (!byTopic.has(e.topic)) byTopic.set(e.topic, []);
      byTopic.get(e.topic)!.push({ key: e.key, value: JSON.stringify({ ...e.value, _ts: Date.now() }) });
    }
    await Promise.all(
      Array.from(byTopic.entries()).map(([topic, messages]) =>
        producer.send({ topic, messages })
      )
    );
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
