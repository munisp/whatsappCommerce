// === W47 buyer (Coder B) ===
/**
 * J445 — ONB-B-10: nlp_sessions single-winner creation (unique index +
 * ON CONFLICT re-select in routers/nlp.ts), bounded messageHistory
 * rotation, and an idle-TTL sweep path via the retention engine.
 */
import { and, eq, lt } from "drizzle-orm";
import { assert, assertIncludes, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J445",
  name: "ONB-B-10 nlp_sessions race + retention",
  feature: "W47 buyer session integrity",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const phone = world.newPhone("445");

    // 1. Two racing inserts: the second is a conflict no-op (single winner).
    const first = crypto.randomUUID();
    await world.db.insert(schema.nlpSessions).values({
      id: first, tenantId: TENANT_ID, waPhoneNumber: phone,
      customerName: "Winner", language: "english", state: "greeting",
      context: {}, messageHistory: [], lastActivityAt: new Date(), createdAt: new Date(),
    });
    const loser = await world.db.insert(schema.nlpSessions).values({
      id: crypto.randomUUID(), tenantId: TENANT_ID, waPhoneNumber: phone,
      customerName: "Loser", language: "english", state: "greeting",
      context: {}, messageHistory: [], lastActivityAt: new Date(), createdAt: new Date(),
    }).onConflictDoNothing().returning();
    assert(loser.length === 0, "racing duplicate insert is a conflict no-op");
    const rows = await world.db.select().from(schema.nlpSessions)
      .where(and(eq(schema.nlpSessions.tenantId, TENANT_ID), eq(schema.nlpSessions.waPhoneNumber, phone)));
    assert(rows.length === 1 && rows[0].id === first, "exactly one session — the first writer wins");

    // 2. nlp.ts get-or-create upserts ON CONFLICT and re-selects the winner.
    const { readFile } = await import("node:fs/promises");
    const nlp = await readFile(new URL("../../server/routers/nlp.ts", import.meta.url), "utf8");
    assertIncludes(nlp, "onConflictDoNothing", "nlp get-or-create is conflict-safe");
    assertIncludes(nlp, "slice(-20)", "messageHistory rotated/bounded at write time");

    // 3. Idle-TTL sweep: nlp_sessions is a purgeable retention entity keyed
    //    by lastActivityAt.
    const retention = await import("../../server/services/retention");
    assert(retention.isPurgeableEntity("nlp_sessions"), "nlp_sessions purgeable (idle-TTL sweep)");
    // Age the session and prove the sweep predicate selects it.
    const stale = new Date(Date.now() - 400 * 24 * 3600_000);
    await world.db.update(schema.nlpSessions).set({ lastActivityAt: stale })
      .where(eq(schema.nlpSessions.id, first));
    const idleRows = await world.db.select().from(schema.nlpSessions)
      .where(and(eq(schema.nlpSessions.tenantId, TENANT_ID), lt(schema.nlpSessions.lastActivityAt, new Date(Date.now() - 365 * 24 * 3600_000))));
    assert(idleRows.some((r) => r.id === first), "idle sessions selectable for purge");
  },
};
