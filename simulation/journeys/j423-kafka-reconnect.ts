// === W46 platform-p2 ===
/**
 * J423 — PLT-18: Kafka client reconnect with backoff/jitter, latch reset on
 * disconnect, and /health/ready surfacing. Functional checks on the exported
 * state machine + source-contract on healthReady/index wiring.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { assert, assertIncludes } from "../world";
import type { Journey } from "../runner";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

export const journey: Journey = {
  id: "J423",
  name: "Kafka reconnect backoff + latch reset + readiness surface",
  feature: "platform-p2: PLT-18 kafka reconnect",
  async run() {
    const kafka = await import("../../server/kafka");

    // ── backoff: exponential with full jitter, capped ────────────────────
    assert(kafka.kafkaReconnectDelayMs(1, () => 0.9999) < 1000, "attempt 1 bounded by 1s base");
    assert(kafka.kafkaReconnectDelayMs(2, () => 0.9999) < 2000, "attempt 2 bounded by 2s");
    assert(kafka.kafkaReconnectDelayMs(5, () => 0.9999) < 16000, "attempt 5 bounded by 16s");
    assert(kafka.kafkaReconnectDelayMs(100, () => 0.9999) < 60_000, "cap at 60s");
    assert(kafka.kafkaReconnectDelayMs(3, () => 0) === 0, "full jitter can return 0 (no thundering herd)");

    // ── latch reset + connection-state surface ───────────────────────────
    kafka.resetKafkaReconnectLatch();
    const state = kafka.getKafkaConnectionState();
    assert(typeof state.configured === "boolean", "state.configured present");
    assert(state.connected === false, "no producer → not connected");
    assert(state.consecutiveFailures === 0, "latch reset zeroes failures");
    assert(state.retrying === false, "not retrying after reset");

    // ── source contract: no sticky latch remains ─────────────────────────
    const src = await readFile(`${repoRoot}/server/kafka.ts`, "utf8");
    assert(!src.includes("_connectAttempted"), "sticky _connectAttempted latch removed");
    assertIncludes(src, "kafkaReconnectDelayMs", "backoff helper");
    assertIncludes(src, "resetKafkaReconnectLatch", "latch reset helper");
    assertIncludes(src, '"producer.disconnect"', "disconnect resets the latch");
    assertIncludes(src, "getKafkaConnectionState", "state surface exported");

    // ── healthReady probe + /health/ready line ───────────────────────────
    const ready = await readFile(`${repoRoot}/server/services/healthReady.ts`, "utf8");
    assertIncludes(ready, "checkKafka", "kafka component probe");
    assertIncludes(ready, "kafka: ComponentCheck", "kafka in ReadinessReport");
    const idx = await readFile(`${repoRoot}/server/_core/index.ts`, "utf8");
    assertIncludes(idx, "getKafkaConnectionState()", "/health/ready surfaces kafka state");
  },
};
