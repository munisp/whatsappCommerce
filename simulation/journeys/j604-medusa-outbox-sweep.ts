// === W60 persistence ===
/**
 * J604 — W60-A CRITICAL #2: the Medusa promo retry queue is DURABLE
 * (medusa_promo_outbox + /api/scheduled/medusa-promo-outbox sweeper).
 *
 *   1. Medusa unreachable (500) → push fails, op lands in the outbox
 *      (restart-proof: the row — not process memory — carries the retry).
 *   2. Sweep with Medusa still down → attempt recorded, backoff applied;
 *      an immediate second sweep skips the row (bounded retry/backoff).
 *   3. Restart mid-queue loses nothing: the pending row is still claimed
 *      by a later sweep; once Medusa recovers the sweep delivers it
 *      (status 'sent', promo POST observed by the mock).
 *   4. The scheduled route exists and is in the scheduler allowlist
 *      (J178 parity).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq } from "drizzle-orm";
import { erp } from "../metaMock";
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { seedUcTenant } from "./w46-uc-docs-seed";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export const journey: Journey = {
  id: "J604",
  name: "Medusa promo outbox: durable enqueue, backoff sweep, restart-safe",
  feature: "W60 persistence: medusa_promo_outbox",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const sync = await import("../../server/services/medusaPromoSync");
    const { tenantId } = await seedUcTenant(world, "604", 6041);
    const HOST = "medusa-j604.example.com";
    let medusaDown = true;
    try {
      await world.db.insert(schema.tenantIntegrations).values({
        tenantId, integrationType: "medusa", status: "active",
        baseUrl: `http://${HOST}`, apiKey: "j604-admin-token",
      }).onConflictDoNothing();
      erp.script(HOST, (body) =>
        medusaDown ? { status: 500, json: { error: "boom" } } : { json: { promotion: { id: "prom_j604" } } });

      // ── 1. Failing push → durable outbox row ──────────────────────────
      const promo = { code: "J604CODE", type: "percent", value: 15 } as any;
      const r = await sync.pushPromoToMedusa(world.db, tenantId, promo, "upsert");
      assert(r.pending && r.mode === "queued", "failed push queued");
      let rows = await world.db.select().from(schema.medusaPromoOutbox)
        .where(and(eq(schema.medusaPromoOutbox.tenantId, tenantId), eq(schema.medusaPromoOutbox.promoCode, "J604CODE")));
      assert(rows.length === 1 && rows[0].status === "pending", "outbox row persisted (restart-proof)");
      assert(rows[0].attempts === 0, "no attempts yet");

      // ── 2. Sweep while down: attempt + backoff ────────────────────────
      const t0 = Date.now();
      const s1 = await sync.sweepMedusaPromoOutbox(world.db, null, { now: new Date(t0 + 60_000) });
      assert(s1.claimed === 1 && s1.retried === 1 && s1.sent === 0, `first sweep retries once (got ${JSON.stringify(s1)})`);
      rows = await world.db.select().from(schema.medusaPromoOutbox).where(eq(schema.medusaPromoOutbox.id, rows[0].id));
      assert(rows[0].status === "pending" && rows[0].attempts === 1, "attempt recorded, still pending");
      // Immediate re-sweep: backoff window (30s after attempt) not elapsed.
      const s2 = await sync.sweepMedusaPromoOutbox(world.db, null, { now: new Date(t0 + 60_500) });
      assert(s2.claimed === 0, "backoff skips a not-yet-due row");

      // ── 3. Restart mid-queue loses nothing; recovery delivers ─────────
      // (The row above is the post-restart state — no process memory.)
      medusaDown = false;
      const s3 = await sync.sweepMedusaPromoOutbox(world.db, null, { now: new Date(t0 + 120_000) });
      assert(s3.claimed === 1 && s3.sent === 1, `recovery sweep delivers (got ${JSON.stringify(s3)})`);
      rows = await world.db.select().from(schema.medusaPromoOutbox).where(eq(schema.medusaPromoOutbox.id, rows[0].id));
      assert(rows[0].status === "sent", "row marked sent");
      const posts = erp.calls.filter((c) => c.url.includes("/admin/promotions") && c.method === "POST" && c.body?.code === "J604CODE");
      assert(posts.length >= 1, "promo POST reached the Medusa mock");

      // ── 4. Route + scheduler allowlist parity (J178) ──────────────────
      const idx = fs.readFileSync(path.join(ROOT, "server/_core/index.ts"), "utf-8");
      assert(idx.includes('app.post("/api/scheduled/medusa-promo-outbox"'), "scheduled route registered");
      const scheduler = await import("../../services/scheduler/scheduler.mjs");
      assert(scheduler.SCHEDULE.some((x: { path: string }) => x.path === "/api/scheduled/medusa-promo-outbox"), "scheduler allowlist entry");
    } finally {
      erp.handlers.delete(HOST);
      await world.db.delete(schema.tenantIntegrations)
        .where(and(eq(schema.tenantIntegrations.tenantId, tenantId), eq(schema.tenantIntegrations.integrationType, "medusa")))
        .catch(() => {});
      await world.db.delete(schema.medusaPromoOutbox).where(eq(schema.medusaPromoOutbox.tenantId, tenantId)).catch(() => {});
    }
  },
};
