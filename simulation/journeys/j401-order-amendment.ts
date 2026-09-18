// === W46 uc-money (Coder C) ===
/**
 * J401 — UC-26 pre-confirmation order amendment: integer-cents recompute via
 * shared/escrowAmounts, append-only order_amendments audit trail, paid-order
 * delta link (up) / refund leg (down), terminal-state refusal.
 */
import { asc, eq } from "drizzle-orm";
import { assert, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";
import { seedOrderWithItem } from "./w45-orders-seed";

export const journey: Journey = {
  id: "J401",
  name: "order amendment: recompute, delta link, refund, audit",
  feature: "UC-26 order amendment",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const { amendOrder, AMENDABLE_STATUSES } = await import("../../server/services/orderAmendments");
    assert(AMENDABLE_STATUSES.includes("pending") && AMENDABLE_STATUSES.includes("confirmed"), "pre-confirmation states only");
    const phone = world.newPhone("j401");
    await world.grantConsent(phone);

    // ── Unpaid pending order: total just recomputes (integer cents) ──
    const o1 = await seedOrderWithItem(world, "j401a", phone, { status: "pending", paymentStatus: "unpaid", qty: 2, unitPrice: "1999.99" });
    const up1 = await amendOrder(world.db, {
      tenantId: TENANT_ID, orderId: o1.orderId,
      lines: [{ productId: o1.productId, qty: 3 }],
      actorId: phone, reason: "one more please",
    });
    // 2 × 1999.99 = 3999.98 → 399_998c; 3 × 199_999c = 599_997c
    assert(up1.amendment.prevTotalCents === 399_998, "prev total in integer cents");
    assert(up1.amendment.newTotalCents === 599_997, "new total recomputed in integer cents");
    assert(up1.amendment.deltaCents === 199_999, "delta = one more unit");
    assert(up1.amendment.status === "applied", "unpaid order: no delta leg needed");
    assert(up1.deltaPaymentUrl === null && up1.refundStatus === null, "no delta link / refund for unpaid orders");
    const [ord1] = await world.db.select().from(schema.orders).where(eq(schema.orders.id, o1.orderId));
    assert(Number(ord1.totalAmount) === 5999.97, "orders.totalAmount updated");
    const items1 = await world.db.select().from(schema.orderItems).where(eq(schema.orderItems.orderId, o1.orderId));
    assert(items1.length === 1 && items1[0].quantity === 3, "order_items replaced");

    // ── PAID order, upward delta → delta payment link + intent row ──
    const o2 = await seedOrderWithItem(world, "j401b", phone, { status: "confirmed", paymentStatus: "completed", qty: 1, unitPrice: "5000.00" });
    const up2 = await amendOrder(world.db, {
      tenantId: TENANT_ID, orderId: o2.orderId,
      lines: [{ productId: o2.productId, qty: 2 }],
      actorId: "merchant-1", reason: "upsell",
    });
    assert(up2.amendment.deltaCents === 500_000, "paid upward delta");
    assert(up2.amendment.status === "delta_link_sent", "delta link path taken");
    const deltaIntents = await world.db.select().from(schema.paymentIntents)
      .where(eq(schema.paymentIntents.idempotencyKey, `amend-delta:${up2.amendment.id}`));
    assert(deltaIntents.length === 1 && Number(deltaIntents[0].amount) === 5000, "delta intent minted once at delta amount");

    // ── PAID order, downward delta → refund leg with honest status ──
    const down2 = await amendOrder(world.db, {
      tenantId: TENANT_ID, orderId: o2.orderId,
      lines: [{ productId: o2.productId, qty: 1 }],
      actorId: "merchant-1", reason: "too many",
    });
    assert(down2.amendment.deltaCents === -500_000, "downward delta negative");
    assert(down2.refundStatus !== null, "refund leg attempted");
    // Sim has no provider payment → honest 'no_provider_refund' vocabulary.
    assert(["refund_initiated", "refund_failed"].includes(down2.amendment.status), "honest amendment refund status");

    // ── Audit trail: append-only rows accumulate ──
    const rows = await world.db.select().from(schema.orderAmendments)
      .where(eq(schema.orderAmendments.orderId, o2.orderId))
      .orderBy(asc(schema.orderAmendments.createdAt));
    assert(rows.length === 2, "two amendment rows for the paid order");
    assert(rows[0].prevTotalCents === 500_000 && rows[1].newTotalCents === 500_000, "amendment chain is consistent");

    // ── Terminal/shipped orders refuse amendment ──
    const o3 = await seedOrderWithItem(world, "j401c", phone, { status: "shipped", paymentStatus: "completed", qty: 1, unitPrice: "1000.00" });
    let shippedBlocked = false;
    try {
      await amendOrder(world.db, {
        tenantId: TENANT_ID, orderId: o3.orderId,
        lines: [{ productId: o3.productId, qty: 2 }],
        actorId: phone,
      });
    } catch (e: any) { shippedBlocked = e?.code === "CONFLICT"; }
    assert(shippedBlocked, "shipped order refuses amendment");

    // Unknown product in the line set is refused tenant-scoped.
    let badProduct = false;
    try {
      await amendOrder(world.db, {
        tenantId: TENANT_ID, orderId: o1.orderId,
        lines: [{ productId: "prod-does-not-exist", qty: 1 }],
        actorId: phone,
      });
    } catch (e: any) { badProduct = e?.code === "NOT_FOUND"; }
    assert(badProduct, "unknown product refused");
  },
};
