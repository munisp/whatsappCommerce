/**
 * === W40 MSG-3 ===
 * J285 — Documented resume procedure for a circuit-breaker-paused campaign:
 *   1. broadcast.resume returns a paused campaign to 'draft' and clears the
 *      pause metadata (the merchant re-sends explicitly afterwards).
 *   2. Resume refuses non-paused campaigns (honest PRECONDITION_FAILED) —
 *      resume is never an implicit side effect of another mutation.
 */
import { eq } from "drizzle-orm";
import { TENANT_ID, assert, assertIncludes, type World } from "../world";
import type { Journey } from "../runner";
import { adminCaller } from "./helpers";

export const journey: Journey = {
  id: "J285",
  name: "paused campaign resume procedure (MSG-3)",
  feature: "broadcast.resume: paused -> draft, pause metadata cleared; refuses others",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const caller = await adminCaller();

    // Seed a circuit-breaker-paused campaign (post-J284 state).
    const { id: campaignId } = await caller.broadcast.create({
      tenantId: TENANT_ID,
      name: "J285 Resume Campaign",
    });
    await world.db.update(schema.broadcastCampaigns).set({
      status: "paused",
      pausedReason: "circuit_breaker: 25/25 sends failed (100% > 20% threshold)",
      pausedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(schema.broadcastCampaigns.id, campaignId));

    // ── 1. Resume: paused -> draft, metadata cleared ─────────────────────
    const resumed = await caller.broadcast.resume({ campaignId });
    assert(resumed.success === true && resumed.status === "draft", `resume returns draft, got ${JSON.stringify(resumed)}`);
    const [after] = await world.db.select().from(schema.broadcastCampaigns)
      .where(eq(schema.broadcastCampaigns.id, campaignId)).limit(1);
    assert(after?.status === "draft", `campaign back to draft, got ${after?.status}`);
    assert(after?.pausedReason === null, "pausedReason cleared on resume");
    assert(after?.pausedAt === null, "pausedAt cleared on resume");

    // ── 2. Resume refuses a non-paused campaign ──────────────────────────
    let refused: any = null;
    try {
      await caller.broadcast.resume({ campaignId }); // now draft
    } catch (e: any) {
      refused = e;
    }
    assert(refused, "resume on a non-paused campaign must throw");
    assertIncludes(String(refused?.message ?? refused), "paused", "honest refuse message");

    const [still] = await world.db.select().from(schema.broadcastCampaigns)
      .where(eq(schema.broadcastCampaigns.id, campaignId)).limit(1);
    assert(still?.status === "draft", "refused resume leaves the campaign untouched");
  },
};
