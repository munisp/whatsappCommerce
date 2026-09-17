/**
 * === W41 Coder A (UC-6) ===
 * J291 — One-tap reorder with a saved token:
 *   1. reorderWithToken clones the buyer's last paid order, charges the
 *      saved (fake) token off-session for the full total, and settles via
 *      the pinned confirm path (new order paid).
 *   2. A replay is refused honestly (reorder_already_charged) — never a
 *      double charge.
 *   3. Another buyer's order cannot be reordered (ownership check).
 */
import { eq } from "drizzle-orm";
import { TENANT_ID, assert, type World } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J291",
  name: "one-tap reorder charged to a saved token (UC-6)",
  feature: "buyerInstallments.reorderWithToken: clone + off-session charge + pinned settle; replay + ownership fail-closed",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const svc = await import("../../server/services/buyerInstallments");
    const tokensSvc = await import("../../server/services/customerPaymentTokens");
    const db = world.db;
    const buyer = "2348000000291";
    const srcId = `j291-src-${Date.now()}`;

    await db.insert(schema.orders).values({
      id: srcId, tenantId: TENANT_ID, customerId: buyer,
      orderNumber: `J291-${Date.now()}`, status: "delivered",
      totalAmount: "450.00", currency: "NGN", paymentStatus: "completed",
      items: [{ productId: "p-jollof", name: "Jollof Rice", qty: 1, price: "450.00" }],
      createdAt: new Date(), updatedAt: new Date(),
    });
    const token = await tokensSvc.saveCustomerToken(db, {
      tenantId: TENANT_ID, buyerPhone: buyer, provider: "fake",
      token: "fake-auth-j291", displayLabel: "Dev card •••• 0291",
      consentText: tokensSvc.tokenConsentPrompt("Dev card •••• 0291"),
    });

    // ── 1. One-tap reorder ───────────────────────────────────────────────
    const res = await svc.reorderWithToken(db, {
      tenantId: TENANT_ID, buyerPhone: buyer, tokenId: token.id, sourceOrderId: srcId,
    });
    assert(res.ok === true && res.status === "success", `reorder succeeded, got ${JSON.stringify(res)}`);
    assert(res.chargedCents === 450_00, `charged the full original total, got ${res.chargedCents}`);
    const [clone] = await db.select().from(schema.orders)
      .where(eq(schema.orders.id, res.orderId!)).limit(1);
    assert(clone, "cloned order exists");
    assert(clone!.totalAmount === "450.00", "total carried over (never re-floated)");
    assert((clone!.metadata as any)?.reorderOf === srcId, "clone references the source order");
    const [chargeRow] = await db.select().from(schema.buyerPlanCharges)
      .where(eq(schema.buyerPlanCharges.reference, svc.bipReorderRef(srcId))).limit(1);
    assert(chargeRow?.status === "success" && chargeRow?.kind === "reorder",
      `durable reorder charge row success, got ${chargeRow?.status}/${chargeRow?.kind}`);

    // ── 2. Replay refused (exactly-once) ─────────────────────────────────
    const replay = await svc.reorderWithToken(db, {
      tenantId: TENANT_ID, buyerPhone: buyer, tokenId: token.id, sourceOrderId: srcId,
    });
    assert(replay.ok === false && replay.error === "reorder_already_charged",
      `replay refused honestly, got ${JSON.stringify(replay)}`);

    // ── 3. Ownership check ───────────────────────────────────────────────
    const stranger = await svc.reorderWithToken(db, {
      tenantId: TENANT_ID, buyerPhone: "2348000000999", tokenId: token.id, sourceOrderId: srcId,
    });
    assert(stranger.ok === false && stranger.error === "order_not_yours", "another buyer's order cannot be reordered");
  },
};
