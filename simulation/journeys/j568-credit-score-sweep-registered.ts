// === W56 credit ===
/**
 * J568 — Scheduled credit-score-refresh sweep is registered (J178-safe):
 * the route exists in server/_core/index.ts AND the scheduler.mjs SCHEDULE
 * allowlist, and the sweep recomputes stale rows deterministically.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { assert, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export const journey: Journey = {
  id: "J568",
  name: "credit-score-refresh sweep route registered + stale recompute",
  feature: "W56 creditScoring: scheduled sweep (J178 contract)",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const scoring = await import("../../server/services/creditScoring");

    // ── 1. J178 contract: route in index.ts AND scheduler allowlist ──────
    const indexSrc = fs.readFileSync(path.join(ROOT, "server/_core/index.ts"), "utf-8");
    assert(indexSrc.includes('app.post("/api/scheduled/credit-score-refresh"'), "credit-score-refresh route registered in index.ts");
    assert(indexSrc.includes('app.post("/api/scheduled/bureau-report"'), "bureau-report route registered in index.ts");
    const scheduler = await import("../../services/scheduler/scheduler.mjs");
    const paths = new Set(scheduler.SCHEDULE.map((r: { path: string }) => r.path));
    assert(paths.has("/api/scheduled/credit-score-refresh"), "scheduler allowlist has credit-score-refresh");
    assert(paths.has("/api/scheduled/bureau-report"), "scheduler allowlist has bureau-report");

    // ── 2. Sweep recomputes stale rows ───────────────────────────────────
    const phone = world.newPhone("568");
    const customerId = `cust-j568-${phone.slice(-6)}`;
    await world.db.insert(schema.customers).values({
      id: customerId, tenantId: TENANT_ID, whatsappPhone: phone, name: "J568 Buyer",
    }).onConflictDoNothing();
    await world.db.insert(schema.orders).values({
      id: "ord-j568-0", tenantId: TENANT_ID, customerId,
      orderNumber: "J568-0", status: "delivered", totalAmount: "4000.00",
      currency: "NGN", paymentStatus: "completed", metadata: {},
    });
    const first = await scoring.computeAndStoreSubjectScore(world.db as any, TENANT_ID, "buyer", customerId);
    assert(first, "initial compute persisted");

    // Backdate the cache row beyond the 24h staleness horizon.
    await world.backdate(
      `UPDATE credit_scores SET "computedAt" = now() - interval '48 hours' WHERE "subjectId" = $1`,
      [customerId],
    );

    const run = await scoring.runCreditScoreRefreshSweep(world.db as any, { now: new Date() });
    assert(run.recomputed >= 1, `sweep recomputed the stale row (${JSON.stringify(run)})`);

    const after = await world.db
      .select()
      .from(schema.creditScores)
      .where(eq(schema.creditScores.subjectId, customerId));
    assert(after.length === 1, "still exactly one cache row (upsert, not insert)");
    assert(new Date(after[0].computedAt).getTime() > Date.now() - 60_000, "computedAt refreshed by the sweep");
    assert(after[0].score === first!.score, "sweep recompute is deterministic — same history, same score");

    // ── 3. Immediate re-sweep is a no-op (nothing stale) ─────────────────
    const again = await scoring.runCreditScoreRefreshSweep(world.db as any, { now: new Date() });
    assert(again.recomputed === 0, `fresh rows are not recomputed (${JSON.stringify(again)})`);
  },
};
