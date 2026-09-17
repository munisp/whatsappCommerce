// === W45 go-rust-services ===
/**
 * J386 — notification-service is a real queue-backed pipeline (MSG-19): the
 * go.mod/go.sum-only stub now consumes notifications.dispatch from Kafka,
 * dedupes via Redis SETNX, dispatches to the platform notify endpoint with
 * retries, and dead-letters to notifications.dlq. Source-contract checks +
 * docs/status consistency; lazy only, no Go process booted.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { assert, assertIncludes } from "../world";
import type { Journey } from "../runner";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const svc = `${repoRoot}/services/notification-service`;

export const journey: Journey = {
  id: "J386",
  name: "notification-service queue-backed pipeline",
  feature: "go-rust services: MSG-19 notifications",
  async run() {
    const main = await readFile(`${svc}/cmd/main.go`, "utf8");
    const pipe = await readFile(`${svc}/internal/pipeline/pipeline.go`, "utf8");
    const gomod = await readFile(`${svc}/go.mod`, "utf8");
    const dockerfile = await readFile(`${svc}/Dockerfile`, "utf8");

    // ── Real Kafka consume → dispatch → DLQ pipeline ───────────────────────
    assertIncludes(pipe, "notifications.dispatch", "dispatch topic contract (default)");
    assertIncludes(pipe, "kafka.NewReader", "real kafka-go consumer");
    assertIncludes(pipe, "CommitInterval: 0", "manual offset commits");
    assertIncludes(pipe, 'SetNX(ctx, "ns:idem:"', "Redis idempotency gate");
    assertIncludes(pipe, "dispatchWithRetry", "retrying dispatch");
    assertIncludes(pipe, "notifications.dlq", "Kafka DLQ topic (default)");
    assertIncludes(pipe, "dlq.reason", "DLQ carries failure reason");
    assertIncludes(pipe, "NOTIFY_URL is required", "fail-closed without dispatch target");

    // ── Service entrypoint + build ─────────────────────────────────────────
    assertIncludes(main, "pipeline.New(cfg, logger)", "main wires the pipeline");
    assertIncludes(main, "p.Run(ctx)", "consumer loop started");
    assertIncludes(main, "/health", "health endpoint");
    assertIncludes(dockerfile, "go build", "Dockerfile builds the service");

    // ── Module declares its real direct deps ───────────────────────────────
    assertIncludes(gomod, "github.com/segmentio/kafka-go", "kafka-go direct dep");
    assertIncludes(gomod, "github.com/redis/go-redis/v9", "go-redis direct dep");
    assertIncludes(gomod, "github.com/gin-gonic/gin", "gin direct dep");

    // ── Workspace + status docs are honest ─────────────────────────────────
    const gowork = await readFile(`${repoRoot}/go.work`, "utf8");
    assertIncludes(gowork, "./services/notification-service", "go.work still lists the (now real) module");
    const status = await readFile(`${repoRoot}/IMPLEMENTATION_STATUS.md`, "utf8");
    assert(!status.includes("erp-adapter, notification-service declared in go.work, no code yet"),
      "status doc no longer calls notification-service empty");

    // ── TS-visible env docs ────────────────────────────────────────────────
    const envExample = await readFile(`${repoRoot}/env.example.txt`, "utf8");
    assertIncludes(envExample, "NOTIFY_URL", "env.example documents the dispatch target");
    assertIncludes(envExample, "KAFKA_TOPIC_DISPATCH", "env.example documents the consume topic");
  },
};
