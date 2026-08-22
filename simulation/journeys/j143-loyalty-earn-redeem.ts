/**
 * J143 — Loyalty points earn → redeem with caps: the merchant configures
 * earn/burn rules (1 pt per ₦100, 1 pt = ₦1, 20% redemption cap); a buyer's
 * delivered order vests points via the idempotent sweep; a second WhatsApp
 * checkout with "redeem points" burns them for a capped discount reflected
 * in the order total (integer cents), and the WhatsApp POINTS command reads
 * the balance. Over-redeem is impossible (balance + cap enforced).
 */
import { and, desc, eq } from "drizzle-orm";
import { TENANT_ID, assert, bodyText, type World } from "../world";
import type { Journey } from "../runner";
import { createChatOrderViaNlp, nlpConfirm, tenantCaller } from "./helpers";

export const journey: Journey = {
  id: "J143",
  name: "loyalty earn → redeem with caps",
  feature: "ledger-backed loyalty points",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const tenant = await tenantCaller(TENANT_ID);
    const phone = world.newPhone("loyal");
    await world.grantConsent(phone);

    // ── 1. Merchant rules: 1 pt / ₦100, 1 pt = ₦1, cap 20% ──────────────
    const rules = await tenant.loyalty.setRules({
      tenantId: TENANT_ID,
      enabled: true,
      pointsPerUnit: 1,
      unitValueCents: 10_000,
      pointsValueCents: 100,
      redemptionCapPercent: 20,
    });
    assert(rules.pointsPerUnit === 1 && rules.redemptionCapPercent === 20, "rules persisted");

    // ── 2. Delivered order vests points (direct delivery, then sweep) ───
    const order1 = await createChatOrderViaNlp(world, phone, {
      items: [{ product: "Jollof Rice", quantity: 2 }], // ₦5,000
      fulfillment: "pickup",
    });
    await world.db.update(schema.orders)
      .set({ status: "delivered", updatedAt: new Date() })
      .where(eq(schema.orders.id, order1.orderId));
    const total1Cents = Math.round(order1.total * 100);
    const expectedPoints = Math.floor(total1Cents / 10_000);

    const sweep1 = await tenant.loyalty.sweep({ tenantId: TENANT_ID }).catch(async () => {
      // internalProcedure via tenant caller may be rejected — use service.
      const { sweepAwardPointsForDeliveredOrders } = await import("../../server/services/loyalty");
      return sweepAwardPointsForDeliveredOrders(world.db as any, TENANT_ID);
    });
    assert(sweep1.awarded >= 1, "sweep awarded points for the delivered order");

    const bal = await tenant.loyalty.balance({ tenantId: TENANT_ID, customerPhone: phone });
    assert(bal.balance === expectedPoints,
      `balance == earned points (${bal.balance} != ${expectedPoints})`);

    // Sweep is idempotent — re-running awards nothing more.
    const { sweepAwardPointsForDeliveredOrders } = await import("../../server/services/loyalty");
    const sweep2 = await sweepAwardPointsForDeliveredOrders(world.db as any, TENANT_ID);
    const bal2 = await tenant.loyalty.balance({ tenantId: TENANT_ID, customerPhone: phone });
    assert(bal2.balance === expectedPoints, `second sweep does not double-award (sweep2 awarded ${sweep2.awarded})`);

    // ── 3. WhatsApp POINTS command reads the balance ────────────────────
    await world.text(phone, "POINTS");
    await world.waitFor(async () => {
      const t = bodyText(world.outbound.lastOfType("text", phone));
      return t.includes("loyalty points");
    }, 8000, "POINTS balance reply");
    const pointsReply = bodyText(world.outbound.lastOfType("text", phone));
    assert(pointsReply.includes(String(expectedPoints)), "POINTS reply shows the ledger balance");

    // ── 4. Second checkout with "redeem points" → capped discount ───────
    // Arm redemption via the standalone WhatsApp command (sticks to the
    // session like COD intent), then a fresh confirm re-uses the saved
    // pickup fulfillment and creates the order with the discount applied.
    await world.text(phone, "redeem points");
    await world.waitFor(async () => bodyText(world.outbound.lastOfType("text", phone)).includes("loyalty points"),
      8000, "redeem armed");
    const tag2 = crypto.randomUUID().slice(0, 8);
    await nlpConfirm(world, phone, `confirm again [${tag2}]`);
    let row2: any | null = null;
    await world.waitFor(async () => {
      const [o] = await world.db.select().from(schema.orders)
        .where(eq(schema.orders.customerId, phone))
        .orderBy(desc(schema.orders.createdAt)).limit(1);
      row2 = o ?? null;
      return !!row2 && row2.id !== order1.orderId;
    }, 10000, "second order created with redemption");
    const meta2 = (row2.metadata as Record<string, unknown>) ?? {};
    const redemption = meta2.loyaltyRedemption as { points: number; discountCents: number } | undefined;
    assert(redemption, "loyalty redemption snapshot stored on the order");

    // Cap: 20% of (subtotal + delivery) → min(cap, points value).
    const subtotal2Cents = Math.round(parseFloat(String(meta2.subtotal)) * 100);
    const capCents = Math.floor(subtotal2Cents * 20 / 100);
    const maxByPoints = expectedPoints * 100;
    const expectedDiscount = Math.min(capCents, maxByPoints);
    assert(redemption!.discountCents === expectedDiscount,
      `discount capped correctly (${redemption!.discountCents} != ${expectedDiscount})`);
    const total2Cents = Math.round(parseFloat(row2.totalAmount) * 100);
    assert(total2Cents === subtotal2Cents - expectedDiscount,
      `order total reflects the redemption discount (${subtotal2Cents} - ${expectedDiscount} != ${total2Cents})`);

    // Ledger: redeem row burned exactly the discounted points; balance now.
    const ledger = await world.db.select().from(schema.loyaltyLedger)
      .where(and(eq(schema.loyaltyLedger.tenantId, TENANT_ID), eq(schema.loyaltyLedger.customerPhone, phone)));
    const earnRows = ledger.filter((l) => l.entryType === "earn");
    const redeemRows = ledger.filter((l) => l.entryType === "redeem");
    assert(earnRows.length === 1, "exactly one earn row");
    assert(redeemRows.length === 1, "exactly one redeem row");
    assert(redeemRows[0].points * 100 === expectedDiscount, "burned points == discount value");
    const bal3 = await tenant.loyalty.balance({ tenantId: TENANT_ID, customerPhone: phone });
    assert(bal3.balance === expectedPoints - redeemRows[0].points, "balance debited after redemption");

    // Double-entry style: every row has balanced debit/credit accounts.
    for (const l of ledger) {
      assert(l.debitAccount.length > 0 && l.creditAccount.length > 0 && l.debitAccount !== l.creditAccount,
        "ledger rows are double-entry");
    }
  },
};
