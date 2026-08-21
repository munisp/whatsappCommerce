/**
 * J148 — Group buying SUCCESS path: a merchant opens a deal (threshold 10
 * units, deadline +2h); customers join via WhatsApp ("join <ref> <qty>"),
 * each join is a held authorization; when the running total crosses the
 * threshold the deal CONFIRMS and every held participant flips to
 * 'confirmed'. Idempotent re-join does not double-count; the WhatsApp
 * replies carry the live progress bar.
 */
import { eq } from "drizzle-orm";
import { TENANT_ID, assert, assertIncludes, bodyText, type World } from "../world";
import type { Journey } from "../runner";
import { publicCaller } from "./helpers";

export const journey: Journey = {
  id: "J148",
  name: "group deal threshold success",
  feature: "groupBuy join → threshold confirm + progress bar",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const { createGroupDealTx, getGroupDealProgressTx } = await import("../../server/services/groupBuy");

    const deal = await createGroupDealTx(world.db, {
      tenantId: TENANT_ID,
      title: "Cooking Oil 25L — group price",
      unitPriceCents: 1_150_000, // ₦11,500.00 bulk
      retailPriceCents: 1_400_000,
      thresholdQty: 10,
      deadline: new Date(Date.now() + 2 * 3600_000),
    });
    const ref = deal.id.slice(0, 8);

    // ── 1. WhatsApp: "deals" lists the open deal with a progress bar ─────
    const alice = world.newPhone("ga");
    await world.grantConsent(alice);
    await world.text(alice, "deals");
    const listReply = bodyText(world.outbound.lastOfType("text", alice));
    assertIncludes(listReply, "Open group deals", "deal list header");
    assertIncludes(listReply, "Cooking Oil 25L", "deal listed");
    assertIncludes(listReply, "0/10 units", "empty progress shown");

    // ── 2. Alice joins for 4 units → held, progress 40% ──────────────────
    await world.text(alice, `join ${ref} 4`);
    const joinReply = bodyText(world.outbound.lastOfType("text", alice));
    assertIncludes(joinReply, "You're in", "join ack");
    assertIncludes(joinReply, "NGN 46,000.00", "hold amount (4 × ₦11,500)");
    assertIncludes(joinReply, "4/10 units", "progress after first join");

    // ── 3. Idempotent re-join via the public API does not double-count ───
    const pub = await publicCaller();
    const replay = await pub.groupBuy.joinDeal({ dealId: deal.id, customerPhone: alice, quantity: 4 });
    assert(replay.alreadyJoined === true, "re-join flagged as replay");
    const afterReplay = await getGroupDealProgressTx(world.db, deal.id);
    assert(afterReplay!.currentQty === 4, `replay does not double-count (got ${afterReplay!.currentQty})`);

    // ── 4. Bob joins for 6 units → threshold met → deal confirms ─────────
    const bob = world.newPhone("gb");
    await world.grantConsent(bob);
    await world.text(bob, `join ${ref} 6`);
    const bobReply = bodyText(world.outbound.lastOfType("text", bob));
    assertIncludes(bobReply, "10/10 units", "threshold reached");
    assertIncludes(bobReply, "UNLOCKED", "unlock announced over WhatsApp");

    const [fresh] = await world.db.select().from(schema.groupDeals).where(eq(schema.groupDeals.id, deal.id)).limit(1);
    assert(fresh.status === "confirmed", `deal confirmed (got ${fresh.status})`);
    assert(fresh.currentQty === 10, `current qty (got ${fresh.currentQty})`);

    const participants = await world.db
      .select()
      .from(schema.groupDealParticipants)
      .where(eq(schema.groupDealParticipants.dealId, deal.id));
    assert(participants.length === 2, `two participants (got ${participants.length})`);
    for (const p of participants) {
      assert(p.status === "confirmed", `participant confirmed (got ${p.status})`);
    }

    // ── 5. Late joins are refused on a confirmed deal ────────────────────
    const carol = world.newPhone("gc");
    await world.grantConsent(carol);
    await world.text(carol, `join ${ref} 1`);
    const lateReply = bodyText(world.outbound.lastOfType("text", carol));
    assertIncludes(lateReply, "no longer open", "late join refused");

    // ── 6. Progress endpoint is PII-scrubbed and live ────────────────────
    const view = await pub.groupBuy.getDealPublic({ dealId: deal.id });
    assert(view.status === "confirmed" && view.progress!.percent === 100, "public progress view");
    assert(!("tenantId" in view), "public view hides tenant internals");
  },
};
