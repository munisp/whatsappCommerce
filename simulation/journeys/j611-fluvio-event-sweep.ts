// === W61 dataloss ===
/**
 * J611 — fluvio_event_log processor sweep (audit HIGH #6). The table was a
 * write-only landing pad: every wacommerce.* event landed processed=false
 * and nothing ever consumed it; recon.discrepancy events were never
 * surfaced.
 *
 *   1. Sweep claims unprocessed rows (claim-first guarded UPDATE) →
 *      processed=true; a second sweep claims nothing.
 *   2. recon.discrepancy rows trigger a tenant admin alert before being
 *      buried.
 *   3. Route + scheduler allowlist parity (J178).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, type World, TENANT_ID, ADMIN_PHONE } from "../world";
import { outbound } from "../metaMock";
import type { Journey } from "../runner";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export const journey: Journey = {
  id: "J611",
  name: "fluvio-event-sweep: consumes landing pad, surfaces recon discrepancies",
  feature: "W61 dataloss: fluvio_event_log processor",
  async run(world: World) {
    const sweep = await import("../../server/services/fluvioEventSweep");
    const schema = await import("../../drizzle/schema");
    const { eq, inArray } = await import("drizzle-orm");
    const ids: string[] = [];
    try {
      // ── Seed unprocessed events ───────────────────────────────────────
      const seed = await world.db.insert(schema.fluvioEventLog).values([
        { topic: "wacommerce.orders", offset: 9607001, partition: 0, tenantId: TENANT_ID, eventType: "order.created", payload: { j: 611 }, processed: false },
        { topic: "wacommerce.payments", offset: 9607002, partition: 0, tenantId: TENANT_ID, eventType: "payment.initiated", payload: { j: 611 }, processed: false },
        { topic: "recon.discrepancy", offset: 9607003, partition: 0, tenantId: TENANT_ID, eventType: "recon.discrepancy", payload: { diffCents: 500 }, processed: false },
      ]).returning({ id: schema.fluvioEventLog.id });
      for (const r of seed) ids.push(r.id);

      // ── 1. Claim-first consume ────────────────────────────────────────
      const r1 = await sweep.runFluvioEventSweep(world.db, { limit: 200 });
      assert(r1.claimed >= 3, `sweep claimed the seeded rows (got ${JSON.stringify(r1)})`);
      const after = await world.db.select().from(schema.fluvioEventLog).where(inArray(schema.fluvioEventLog.id, ids));
      assert(after.every((r: any) => r.processed === true && r.processedAt != null), "all seeded rows processed");
      const r2 = await sweep.runFluvioEventSweep(world.db, { limit: 200 });
      // Claim-first guard: the rows r1 claimed are never re-claimed — only
      // the pre-existing backlog remainder (if any) is consumed.
      assert(r2.claimed === Math.min(r1.backlog, 200), `second sweep claims only the leftover backlog (got ${r2.claimed}, backlog was ${r1.backlog})`);

      // ── 2. recon.discrepancy surfaced to the tenant admin ─────────────
      assert(r1.reconDiscrepancies >= 1, "recon discrepancy counted");
      const reconAlerts = outbound.ofType("text", ADMIN_PHONE)
        .filter((c: any) => String(c.body?.text?.body ?? "").includes("reconciliation discrepancy"));
      assert(reconAlerts.length >= 1, "tenant admin alerted about the recon discrepancy");

      // ── 3. Route + scheduler allowlist parity (J178) ──────────────────
      const idx = fs.readFileSync(path.join(ROOT, "server/_core/index.ts"), "utf-8");
      assert(idx.includes('app.post("/api/scheduled/fluvio-event-sweep"'), "scheduled route registered");
      const scheduler = await import("../../services/scheduler/scheduler.mjs");
      assert(scheduler.SCHEDULE.some((x: { path: string }) => x.path === "/api/scheduled/fluvio-event-sweep"), "scheduler allowlist entry");
    } finally {
      if (ids.length) await world.db.delete(schema.fluvioEventLog).where(inArray(schema.fluvioEventLog.id, ids)).catch(() => {});
    }
  },
};
