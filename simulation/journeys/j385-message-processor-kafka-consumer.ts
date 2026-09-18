// === W45 go-rust-services ===
/**
 * J385 — message-processor real Kafka consumer (MSG-18): the hard-coded
 * 4-event simulation is replaced by a real rdkafka StreamConsumer loop with
 * post-processing offset commits and a Kafka DLQ topic mirroring the Redis
 * DLQ (W42). Source-contract checks + env docs; lazy only, no cargo boot.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { assert, assertIncludes } from "../world";
import type { Journey } from "../runner";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const svc = `${repoRoot}/services/message-processor`;

export const journey: Journey = {
  id: "J385",
  name: "message-processor real rdkafka consumer + Kafka DLQ",
  feature: "go-rust services: MSG-18 rust consumer",
  async run() {
    const cargo = await readFile(`${svc}/Cargo.toml`, "utf8");
    const main = await readFile(`${svc}/src/main.rs`, "utf8");

    // ── rdkafka dependency enabled (was commented out) ─────────────────────
    assert(/^rdkafka\s*=/m.test(cargo), "rdkafka dependency uncommented in Cargo.toml");
    assertIncludes(cargo, "cmake-build", "vendored librdkafka build");

    // ── Real consumer loop; simulation removed ─────────────────────────────
    assert(!main.includes("In production, start rdkafka consumer loop here"), "simulation placeholder removed");
    assert(!main.includes("test_events"), "hard-coded test-event simulation removed");
    assertIncludes(main, "StreamConsumer", "real rdkafka stream consumer");
    assertIncludes(main, "#[tokio::main]", "async runtime entrypoint");
    assertIncludes(main, "consumer.subscribe(", "topic subscription");
    assertIncludes(main, "MP_KAFKA_TOPICS", "env-driven topic list");
    assertIncludes(main, '"enable.auto.commit", "false"', "manual commits");
    assertIncludes(main, "commit_message", "offsets committed after processing");

    // ── Kafka DLQ topic alongside the durable Redis DLQ ────────────────────
    assertIncludes(main, "MP_DLQ_TOPIC", "Kafka DLQ topic configurable");
    assertIncludes(main, "mp.dlq.events", "default DLQ topic");
    assertIncludes(main, "FutureProducer", "rdkafka DLQ producer");
    assertIncludes(main, "produce_dlq", "dead-letter produce path");
    assertIncludes(main, "ProcessOutcome::DeadLettered", "dead-letter outcome classification");
    // W42 Redis DLQ retained as system of record.
    assertIncludes(main, "mp:dlq:events", "Redis DLQ retained");

    // ── TS-visible docs ────────────────────────────────────────────────────
    const envExample = await readFile(`${repoRoot}/env.example.txt`, "utf8");
    assertIncludes(envExample, "MP_DLQ_TOPIC", "env.example documents Kafka DLQ topic");
  },
};
