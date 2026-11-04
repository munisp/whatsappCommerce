/**
 * J617 — buying debits inventory, on every path, and only gives stock back
 * when the sale really didn't happen (user request 2026-11-04).
 *
 *   online order placed     → stock down at once (reserved)
 *   paid                    → stays down, also after the 15-minute expiry sweep
 *   unpaid, expired         → stock back (the sale didn't happen)
 *   cash on delivery        → stays down after the expiry sweep (the order stands
 *                             until the rider collects; it used to be handed back
 *                             after 15 minutes, so the item could be sold twice)
 *   paid order cancelled    → stock back
 */
import { and, eq } from "drizzle-orm";
import { TENANT_ID, assert, type World } from "../world";
import type { Journey } from "../runner";
import { createChatOrderViaNlp, nlpAddToCart, nlpConfirm, paystackChargeSuccess, replyCount } from "./helpers";

const HOUR = 60 * 60 * 1000;

export const journey: Journey = {
  id: "J617",
  name: "buying debits inventory",
  feature: "reserve on order, commit on payment / COD, release only when the sale didn't happen",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const { releaseExpiredReservations } = await import("../../server/services/inventory");
    const { cancelOrder } = await import("../../server/services/orderCancel");
    const stock = async (id: string) =>
      Number((await world.db.select({ q: schema.products.stockQuantity }).from(schema.products).where(eq(schema.products.id, id)).limit(1))[0]?.q);
    const reservations = async (orderId: string) =>
      (await world.db.select({ status: schema.inventoryReservations.status, qty: schema.inventoryReservations.qty })
        .from(schema.inventoryReservations).where(eq(schema.inventoryReservations.orderId, orderId))).map((r) => r.status).sort().join(",");
    const sweepLater = () => releaseExpiredReservations(world.db, new Date(Date.now() + 2 * HOUR));

    // Unpaid orders left by earlier journeys would be released by our sweeps
    // too; clear them first so every stock count below is this journey's own.
    await sweepLater();

    // ── 1. Online order, paid ───────────────────────────────────────────
    const jollof0 = await stock("p-jollof");
    const buyerA = world.newPhone("inv-a");
    await world.grantConsent(buyerA);
    const paid = await createChatOrderViaNlp(world, buyerA, { items: [{ product: "Jollof Rice", quantity: 2 }] });
    assert((await stock("p-jollof")) === jollof0 - 2, `ordering 2 jollof debits 2 at once (${jollof0} → ${await stock("p-jollof")})`);
    assert((await reservations(paid.orderId)) === "reserved", "the order holds a reservation");
    assert(paid.paymentRef, "the order has a payment reference");
    await paystackChargeSuccess(world, { reference: paid.paymentRef!, amountMajor: paid.total });
    await world.waitFor(async () => (await reservations(paid.orderId)) === "committed", 15000, "payment commits the reservation");
    await sweepLater();
    assert((await stock("p-jollof")) === jollof0 - 2, `a paid order keeps its stock after the expiry sweep (got ${await stock("p-jollof")})`);

    // ── 2. Online order never paid ──────────────────────────────────────
    const chicken0 = await stock("p-chicken");
    const buyerB = world.newPhone("inv-b");
    await world.grantConsent(buyerB);
    const unpaid = await createChatOrderViaNlp(world, buyerB, { items: [{ product: "Grilled Chicken", quantity: 1 }] });
    assert((await stock("p-chicken")) === chicken0 - 1, "an unpaid order still holds its item while the customer pays");
    await sweepLater();
    assert((await stock("p-chicken")) === chicken0, `an order left unpaid gives its item back (got ${await stock("p-chicken")})`);
    assert((await reservations(unpaid.orderId)) === "released", "its reservation is released");

    // ── 3. Cash on delivery ─────────────────────────────────────────────
    const ankara0 = await stock("p-ankara");
    const buyerC = world.newPhone("inv-c");
    await world.grantConsent(buyerC);
    const tag = crypto.randomUUID().slice(0, 8);
    await nlpAddToCart(world, buyerC, `i want these [${tag}]`, [{ product: "Ankara Fabric", quantity: 1 }]);
    await nlpConfirm(world, buyerC, `confirm please [${tag}]`);
    let before = replyCount(world, buyerC);
    await world.text(buyerC, "2 cash on delivery");
    await world.waitFor(() => replyCount(world, buyerC) > before, 15000, "delivery chosen");
    before = replyCount(world, buyerC);
    await world.text(buyerC, "5 J617 Street, Ikeja, Lagos");
    await world.waitFor(() => replyCount(world, buyerC) > before, 15000, "COD order placed");
    const [cod] = await world.db.select().from(schema.orders)
      .where(and(eq(schema.orders.tenantId, TENANT_ID), eq(schema.orders.customerId, buyerC))).limit(1);
    assert(cod && (cod as any).codState === "cod_pending", `a cash-on-delivery order was placed (got ${(cod as any)?.codState})`);
    assert((await stock("p-ankara")) === ankara0 - 1, "a COD order debits its item");
    await sweepLater();
    assert((await stock("p-ankara")) === ankara0 - 1,
      `a COD order keeps its item after the expiry sweep, so it can't be sold twice (got ${await stock("p-ankara")}, started ${ankara0})`);

    // ── 4. Paid order cancelled ─────────────────────────────────────────
    const [paidRow] = await world.db.select().from(schema.orders).where(eq(schema.orders.id, paid.orderId)).limit(1);
    await cancelOrder(world.db as any, { id: paidRow.id, tenantId: paidRow.tenantId, status: paidRow.status as any }, { reason: "J617" });
    assert((await stock("p-jollof")) === jollof0, `cancelling the paid order puts its 2 back (got ${await stock("p-jollof")})`);
  },
};
