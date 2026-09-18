/**
 * === W41 (Coder B, UC-2) ===
 * J294 — Refund-to-wallet respects the W38 cumulative refund caps: the
 * wallet credit inserts a processed refunds row (metadata.method='wallet')
 * so it counts toward the order's refunded total; anything over the cap is
 * rejected and NO money moves. Full cumulative refund flips the order.
 */
import { eq, and } from "drizzle-orm";
import { TENANT_ID, assert, type World } from "../world";
import type { Journey } from "../runner";

async function mkOrder(world: World, id: string, totalMajor: string) {
  const schema = await import("../../drizzle/schema");
  await world.db.insert(schema.orders).values({
    id, tenantId: TENANT_ID, customerId: `cust-${id}`, orderNumber: `ORD-${id}`,
    status: "delivered", paymentStatus: "completed", totalAmount: totalMajor, currency: "NGN",
  }).onConflictDoNothing();
}

export const journey: Journey = {
  id: "J294",
  name: "refund-to-wallet honors cumulative caps; over-cap rejected",
  feature: "W41 UC-2 refund_to_wallet seam + W38 caps",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const wallet = await import("../../server/services/customerWallet");
    const phone = world.newPhone("w41b");
    const orderId = `j294-${Date.now()}`;
    await mkOrder(world, orderId, "1000.00"); // 100000 kobo

    // Partial refund-to-wallet: ₦600 → wallet credited, cap consumed.
    const r1 = await wallet.refundToWallet(TENANT_ID, phone, orderId, 60000, "admin:sim");
    assert(r1.ok === true, `partial wallet refund ok: ${r1.error}`);
    assert(r1.cumulativeRefundedCents === 60000, `cumulative 60000, got ${r1.cumulativeRefundedCents}`);
    assert((await wallet.walletBalance(TENANT_ID, phone)) === 60000, "wallet holds the refunded kobo");

    // The wallet refund counts toward the refunded total (refunds row, processed, method wallet).
    const refundRows = await world.db.select().from(schema.refunds)
      .where(and(eq(schema.refunds.orderId, orderId), eq(schema.refunds.tenantId, TENANT_ID)));
    assert(refundRows.length === 1 && refundRows[0].status === "processed", "processed refund row recorded");
    assert((refundRows[0].metadata as any)?.method === "wallet", "method=wallet metadata");

    // Over the cap (60000 + 50000 > 100000): rejected, NO money moves.
    const r2 = await wallet.refundToWallet(TENANT_ID, phone, orderId, 50000, "admin:sim");
    assert(r2.ok === false && r2.error === "refund_cap_exceeded", `cap enforced: ${JSON.stringify(r2)}`);
    assert((await wallet.walletBalance(TENANT_ID, phone)) === 60000, "no wallet credit on cap rejection");
    const refundRowsAfter = await world.db.select().from(schema.refunds)
      .where(eq(schema.refunds.orderId, orderId));
    assert(refundRowsAfter.length === 1, "no extra refund row on cap rejection");

    // Remaining ₦400 exactly hits the cap → order flips to refunded.
    const r3 = await wallet.refundToWallet(TENANT_ID, phone, orderId, 40000, "admin:sim");
    assert(r3.ok === true && r3.cumulativeRefundedCents === 100000, "full cumulative refund");
    const [ord] = await world.db.select().from(schema.orders).where(eq(schema.orders.id, orderId)).limit(1);
    assert(ord.paymentStatus === "refunded", `order refunded, got ${ord.paymentStatus}`);

    // Anything further is over the (now fully consumed) cap.
    const r4 = await wallet.refundToWallet(TENANT_ID, phone, orderId, 100, "admin:sim");
    assert(r4.ok === false && r4.error === "refund_cap_exceeded", "cap stays closed after full refund");
    assert((await wallet.walletBalance(TENANT_ID, phone)) === 100000, "wallet holds the full refund");
  },
};
