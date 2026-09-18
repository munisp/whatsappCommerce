// === W44 preorders-offers (Coder B) ===
/**
 * J343 — Pre-availability cancel = FULL refund: cancelPreorder flips the
 * order through the existing cancel path (stock+status claim-first), refunds
 * the held escrow in full via refundEscrowAtomic + the provider refund leg,
 * and notifies the customer. Double cancel is refused; once availableAt has
 * passed the preorder cancel path refuses (normal cancel rules apply).
 */
import { eq } from "drizzle-orm";
import { assert, assertIncludes, bodyText, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";
import { seedPreorderOrder } from "./w44-preorder-offer-seed";

export const journey: Journey = {
  id: "J343",
  name: "preorder cancel before availability = full refund",
  feature: "cancelPreorder + escrow refund + notify + guards",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const { cancelPreorder } = await import("../../server/services/preorders");
    const phone = world.newPhone("j343");
    await world.grantConsent(phone);
    const seed = await seedPreorderOrder(world, "j343", phone);

    const res = await cancelPreorder(world.db, {
      tenantId: TENANT_ID,
      orderId: seed.orderId,
      reason: "changed my mind",
    });
    assert(res.refunded === true, "escrow refunded in full");
    assert(res.refundCents === 500000, `full refund 500000 kobo (got ${res.refundCents})`);

    const [ord] = await world.db.select().from(schema.orders).where(eq(schema.orders.id, seed.orderId));
    assert(ord.status === "cancelled", `order cancelled (got ${ord.status})`);
    const [esc] = await world.db.select().from(schema.escrowTransactions).where(eq(schema.escrowTransactions.id, seed.escrowId));
    assert(!["escrow_held", "payment_received"].includes(esc.state), `escrow refunded (state ${esc.state})`);

    await world.waitFor(() => {
      const t = world.outbound.lastOfType("text", phone);
      return !!t && bodyText(t).includes("cancelled before availability");
    }, 10000, "customer cancel notification");
    const notif = bodyText(world.outbound.lastOfType("text", phone));
    assertIncludes(notif, "refunded in full", "notification confirms full refund");

    // Double cancel refused (terminal-state guard).
    let threw = false;
    try {
      await cancelPreorder(world.db, { tenantId: TENANT_ID, orderId: seed.orderId });
    } catch { threw = true; }
    assert(threw, "double cancel refused");

    // After availability: the preorder cancel path refuses (normal rules).
    const phone2 = world.newPhone("j343b");
    await world.grantConsent(phone2);
    const seed2 = await seedPreorderOrder(world, "j343b", phone2);
    await world.backdate(
      `UPDATE products SET "preorderAvailableAt" = now() - interval '1 minute' WHERE id = $1`,
      [seed2.productId],
    );
    let refused = false;
    try {
      await cancelPreorder(world.db, { tenantId: TENANT_ID, orderId: seed2.orderId });
    } catch (e: any) {
      refused = true;
      assertIncludes(e?.message ?? "", "already available", "post-availability refusal is honest");
    }
    assert(refused, "cancelPreorder refuses after availability");
  },
};
