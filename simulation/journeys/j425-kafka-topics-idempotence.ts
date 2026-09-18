// === W46 platform-p2 ===
/**
 * J425 — PLT-24: auto-topic-creation disabled on BOTH producers (KafkaJS +
 * kafka-go webhook-ingestor), idempotent producer enabled where the client
 * supports it, and the pre-provisioned topics list documented.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { assert, assertIncludes } from "../world";
import type { Journey } from "../runner";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

export const journey: Journey = {
  id: "J425",
  name: "Kafka producers: no auto-topic-creation + idempotence + topic doc",
  feature: "platform-p2: PLT-24 kafka producers",
  async run() {
    // ── KafkaJS producer (server/kafka.ts) ───────────────────────────────
    const ts = await readFile(`${repoRoot}/server/kafka.ts`, "utf8");
    assert(!/allowAutoTopicCreation:\s*true/.test(ts), "KafkaJS auto-topic-creation disabled");
    assertIncludes(ts, "allowAutoTopicCreation: false", "KafkaJS explicit false");
    assertIncludes(ts, "idempotent: true", "KafkaJS idempotent producer (enable.idempotence)");

    // ── kafka-go writer (webhook-ingestor) ───────────────────────────────
    const go = await readFile(`${repoRoot}/services/webhook-ingestor/internal/kafka/producer.go`, "utf8");
    assert(!/AllowAutoTopicCreation:\s*true/.test(go), "kafka-go auto-topic-creation disabled");
    assertIncludes(go, "AllowAutoTopicCreation: false", "kafka-go explicit false");
    assertIncludes(go, "RequireAll", "kafka-go keeps acks=all (W42)");
    assertIncludes(go, "MaxAttempts", "kafka-go bounded retries (no idempotence knob — documented)");

    // ── pre-provisioned topics list/doc ──────────────────────────────────
    const doc = await readFile(`${repoRoot}/docs/KAFKA_TOPICS.md`, "utf8");
    for (const topic of [
      "wacommerce.orders", "wacommerce.payments", "wacommerce.conversations",
      "wacommerce.inventory", "wacommerce.hermes.po", "webhooks.inbound", "mp.dlq.events",
    ]) {
      assertIncludes(doc, topic, `topic ${topic} pre-provisioned in doc`);
    }
    assertIncludes(doc, "kafka-topics.sh", "doc includes the provisioning command");
  },
};
