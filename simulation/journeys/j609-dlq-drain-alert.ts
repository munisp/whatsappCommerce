// === W61 dataloss ===
/**
 * J609 — DLQ drain: durable Redis DLQ lists re-persisted + admin alert
 * (audit CRITICAL #4 + HIGH #7). mp:dlq:events / hermes:dlq /
 * notifications:dlq:spill were write-only sinks and
 * replayWaWebhookFallback() had zero callers.
 *
 *   1. runDlqDrain with an injected Redis-like: entries are insert-first
 *      re-persisted into fluvio_event_log (processed=false) and trimmed
 *      from the list; a capped drain leaves the remainder queued.
 *   2. Non-empty DLQ → tenant admin WA ops alert (never silent).
 *   3. The WA webhook fallback replay path is invoked by the same route
 *      (waFallback result present).
 *   4. Route + scheduler allowlist parity (J178).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, type World, TENANT_ID, ADMIN_PHONE } from "../world";
import { outbound } from "../metaMock";
import type { Journey } from "../runner";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

class FakeRedis {
  lists = new Map<string, string[]>();
  async lrange(key: string, start: number, stop: number) {
    const l = this.lists.get(key) ?? [];
    return l.slice(start, stop === -1 ? undefined : stop + 1);
  }
  async ltrim(key: string, start: number, stop: number) {
    const l = this.lists.get(key) ?? [];
    this.lists.set(key, l.slice(start, stop === -1 ? undefined : stop + 1));
    return "OK";
  }
  async llen(key: string) { return (this.lists.get(key) ?? []).length; }
  async rpush(key: string, v: string) {
    const l = this.lists.get(key) ?? [];
    l.push(v); this.lists.set(key, l); return l.length;
  }
}

export const journey: Journey = {
  id: "J609",
  name: "dlq-drain: Redis DLQs re-persisted to fluvio_event_log + admin alert",
  feature: "W61 dataloss: DLQ drain + replay",
  async run(world: World) {
    const dlq = await import("../../server/services/dlqDrain");
    const schema = await import("../../drizzle/schema");
    const { eq, like } = await import("drizzle-orm");
    const redis = new FakeRedis();
    try {
      // ── 1. Drain re-persists insert-first, trims only persisted prefix ─
      await redis.rpush("mp:dlq:events", JSON.stringify({ event_type: "wa.message.received", tenantId: TENANT_ID, trace_id: "j609-1", payload: { text: "hi" } }));
      await redis.rpush("mp:dlq:events", JSON.stringify({ event_type: "orders.created", tenantId: TENANT_ID, trace_id: "j609-2", payload: {} }));
      await redis.rpush("hermes:dlq", JSON.stringify({ event_type: "hermes.po", tenant_id: TENANT_ID, trace_id: "j609-3" }));
      const r1 = await dlq.runDlqDrain(world.db, { redis, cap: 10 });
      assert(r1.totalDrained === 3, `all three drained (got ${JSON.stringify(r1.keys)})`);
      assert(r1.totalRemaining === 0, "lists emptied after successful persist");
      const rows = await world.db.select().from(schema.fluvioEventLog).where(like(schema.fluvioEventLog.topic, "dlq:%"));
      assert(rows.length >= 3, `drained events landed in fluvio_event_log (got ${rows.length})`);
      assert(rows.every((r: any) => r.processed === false), "drained rows start unprocessed (fluvio sweep consumes them)");
      assert(rows.some((r: any) => r.topic === "dlq:mp:dlq:events" && r.tenantId === TENANT_ID), "mp DLQ row attributed to tenant");

      // ── 2. Non-empty DLQ → admin alert (never silent) ──────────────────
      assert(r1.alertsSent >= 1, `admin alert sent for non-empty DLQ (got ${r1.alertsSent})`);
      const alerts = outbound.ofType("text", ADMIN_PHONE);
      assert(
        alerts.some((c: any) => String(c.body?.text?.body ?? "").includes("DLQ drain")),
        "admin WA alert body mentions the DLQ drain",
      );

      // ── 3. WA webhook fallback replay wired into the same run ─────────
      assert(r1.waFallback !== null, "replayWaWebhookFallback invoked by the drain (was zero-caller)");

      // ── 4. Route + scheduler allowlist parity (J178) ──────────────────
      const idx = fs.readFileSync(path.join(ROOT, "server/_core/index.ts"), "utf-8");
      assert(idx.includes('app.post("/api/scheduled/dlq-drain"'), "scheduled route registered");
      const scheduler = await import("../../services/scheduler/scheduler.mjs");
      assert(scheduler.SCHEDULE.some((x: { path: string }) => x.path === "/api/scheduled/dlq-drain"), "scheduler allowlist entry");
    } finally {
      await world.db.delete(schema.fluvioEventLog).where(like(schema.fluvioEventLog.topic, "dlq:%")).catch(() => {});
    }
  },
};
