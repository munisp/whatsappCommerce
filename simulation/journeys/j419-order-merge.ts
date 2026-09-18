// === W46 orders-p2 (Coder G) ===
/**
 * J419 — ORD-23: merge two pre-ship, unpaid orders from the same customer to
 * the same address: secondary lines re-parent onto the primary, the total is
 * recomputed in integer cents, the secondary is cancelled with
 * metadata.mergedInto, and the buyer is notified. Refusals: different
 * address, different customer, shipped order, paid order. Splitting is the
 * W43 fulfillment-lines path (documented in orderMerge.ts).
 */
import { eq } from "drizzle-orm";
import { assert, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";
import { seedOrder } from "./w46-orders-seed";

export const journey: Journey = {
  id: "J419",
  name: "order merging same customer+address pre-ship",
  feature: "ORD-23 orderMerge.mergeOrders",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const { mergeOrders, canMergeOrders, normalizeAddress } = await import("../../server/services/orderMerge");

    const phone = world.newPhone("j419");
    const address = "12 Adeola Odeku St, Victoria Island";
    // 2 × ₦5,000 (primary) + 3 × ₦2,000 (secondary) = ₦16,000 = 1,600,000 cents.
    const primary = await seedOrder(world, "j419p", { phone, address, qty: 2, unitPrice: "5000.00" });
    const secondary = await seedOrder(world, "j419s", { phone, address, qty: 3, unitPrice: "2000.00" });

    // normalizeAddress sanity: whitespace/case-insensitive equality.
    assert(normalizeAddress({ raw: "12  Adeola Odeku St,\nVictoria Island" }) === normalizeAddress({ raw: address }),
      "address normalization is whitespace/case-insensitive");

    const res = await mergeOrders(world.db, {
      tenantId: TENANT_ID,
      primaryOrderId: primary.orderId,
      secondaryOrderId: secondary.orderId,
      actorId: "j419",
    });
    assert(res.movedItems === 1, "secondary line re-parented");
    assert(res.mergedTotalCents === 1_600_000, `merged total 1,600,000 cents (got ${res.mergedTotalCents})`);

    const [p] = await world.db.select().from(schema.orders).where(eq(schema.orders.id, primary.orderId));
    const [s] = await world.db.select().from(schema.orders).where(eq(schema.orders.id, secondary.orderId));
    assert(p.status === "pending", "primary keeps its status");
    assert(Number(p.totalAmount) === 16000, `primary total ₦16,000 (got ${p.totalAmount})`);
    assert((p.items as any[]).length === 2, "primary items json carries both lines");
    assert((p.metadata as any).mergedFrom?.includes(secondary.orderId), "primary metadata.mergedFrom records the secondary");
    assert(s.status === "cancelled", "secondary cancelled");
    assert((s.metadata as any).mergedInto === primary.orderId, "secondary metadata.mergedInto records the primary");
    const lines = await world.db.select().from(schema.orderItems).where(eq(schema.orderItems.orderId, primary.orderId));
    assert(lines.length === 2, "both order_items rows now on the primary");

    // Buyer merge notice sent.
    await world.waitFor(
      () => world.outbound.findByBody("combined into one delivery", phone).length > 0,
      5000,
      "merge notice",
    );

    // Exactly-once: re-merging the same pair fails (secondary already cancelled).
    let replay = false;
    try {
      await mergeOrders(world.db, { tenantId: TENANT_ID, primaryOrderId: primary.orderId, secondaryOrderId: secondary.orderId });
    } catch (e: any) {
      replay = e?.code === "CONFLICT";
    }
    assert(replay, "re-merge refused");

    // Refusal matrix.
    const diffAddr = await seedOrder(world, "j419x", { phone, address: "5 Other Road" });
    const mkOrder = (over: Record<string, unknown>) => ({
      id: crypto.randomUUID(), tenantId: TENANT_ID, customerId: phone,
      shippingAddress: { raw: address }, currency: "NGN", status: "pending", paymentStatus: "unpaid",
      ...over,
    });
    assert(canMergeOrders(mkOrder({ shippingAddress: { raw: "5 Other Road" } }) as any, mkOrder({}) as any).reason === "address_mismatch",
      "address mismatch refused by predicate");
    let addrBlocked = false;
    try {
      await mergeOrders(world.db, { tenantId: TENANT_ID, primaryOrderId: diffAddr.orderId, secondaryOrderId: (await seedOrder(world, "j419y", { phone, address })).orderId });
    } catch (e: any) {
      addrBlocked = e?.code === "CONFLICT";
    }
    assert(addrBlocked, "different-address merge refused");

    const otherCustomer = await seedOrder(world, "j419z", { address });
    let custBlocked = false;
    try {
      await mergeOrders(world.db, { tenantId: TENANT_ID, primaryOrderId: otherCustomer.orderId, secondaryOrderId: (await seedOrder(world, "j419w", { address })).orderId });
    } catch (e: any) {
      custBlocked = e?.code === "CONFLICT";
    }
    assert(custBlocked, "different-customer merge refused");

    const shipped = await seedOrder(world, "j419v", { phone, address, status: "shipped", paymentStatus: "completed" });
    let shipBlocked = false;
    try {
      await mergeOrders(world.db, { tenantId: TENANT_ID, primaryOrderId: primary.orderId, secondaryOrderId: shipped.orderId });
    } catch (e: any) {
      shipBlocked = e?.code === "CONFLICT";
    }
    assert(shipBlocked, "shipped/paid order merge refused (post-ship)");

    const paid = await seedOrder(world, "j419u", { phone, address, paymentStatus: "completed" });
    let paidBlocked = false;
    try {
      await mergeOrders(world.db, { tenantId: TENANT_ID, primaryOrderId: primary.orderId, secondaryOrderId: paid.orderId });
    } catch (e: any) {
      paidBlocked = e?.code === "CONFLICT";
    }
    assert(paidBlocked, "paid order merge refused honestly (no escrow corruption)");
  },
};
// === END W46 orders-p2 ===
