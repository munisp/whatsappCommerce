/**
 * J472 — a payment that lands AFTER its order stopped holding stock must not
 * resurrect the order without stock (assurance finding AF-01).
 *
 * Before the fix, confirmProviderPayment set orders.status='confirmed' /
 * paymentStatus='completed' for ANY order whose payment was not yet
 * completed — including an order the merchant had CANCELLED (stock already
 * restocked) and an order whose reservation the expiry sweeper had RELEASED.
 * commitReservations then found nothing to commit, so the "confirmed" order
 * held no stock (oversell) and an escrow hold was opened for it.
 *
 * Through the REAL /api/webhooks/paystack handler:
 *   A. cancelled order paid late → order stays cancelled, stock untouched,
 *      no escrow hold, payment quarantined + auto-refunded in full; a
 *      replay never refunds twice or revives the order.
 *   B. reservation expired + released, stock still available → the stock is
 *      re-reserved and committed exactly once (stock goes back down), order
 *      confirmed.
 *   C. reservation expired + released, stock gone → order NOT confirmed,
 *      stock never negative, payment quarantined + auto-refunded.
 */
import { and, eq } from "drizzle-orm";
import { TENANT_ID, assert, type World } from "../world";
import type { Journey } from "../runner";
import { createChatOrderViaNlp, paystackChargeSuccess } from "./helpers";

const PRODUCT_ID = "p-jollof";

export const journey: Journey = {
  id: "J472",
  name: "late payment on a dead order (AF-01)",
  feature: "confirmProviderPayment refuses to revive cancelled / stock-released orders",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const { cancelOrder } = await import("../../server/services/orderCancel");
    const inv = await import("../../server/services/inventory");
    const { upsertTenantProviderConfig } = await import("../../server/services/payments/providers/registry");
    await upsertTenantProviderConfig({
      tenantId: TENANT_ID,
      provider: "paystack",
      creds: { secretKey: "sk_sim_j472" },
      priority: 10,
    });
    await world.db.update(schema.products).set({ stockQuantity: 40 }).where(eq(schema.products.id, PRODUCT_ID));

    const stock = async () => {
      const [p] = await world.db.select({ q: schema.products.stockQuantity }).from(schema.products)
        .where(eq(schema.products.id, PRODUCT_ID)).limit(1);
      return p.q;
    };
    const orderRow = async (id: string) => {
      const [o] = await world.db.select().from(schema.orders).where(eq(schema.orders.id, id)).limit(1);
      return o;
    };
    const escrowRows = (orderId: string) =>
      world.db.select().from(schema.escrowTransactions).where(eq(schema.escrowTransactions.orderId, orderId));
    const quarantine = (ref: string) =>
      world.db.select().from(schema.paymentMismatchQuarantine).where(eq(schema.paymentMismatchQuarantine.reference, ref));
    const refundAttempts = (orderId: string) =>
      world.db.select().from(schema.refundAttempts).where(eq(schema.refundAttempts.orderId, orderId));
    const reservations = (orderId: string) =>
      world.db.select().from(schema.inventoryReservations).where(eq(schema.inventoryReservations.orderId, orderId));
    const expireAndSweep = async (orderId: string) => {
      await world.db.execute(
        `UPDATE inventory_reservations SET "expiresAt" = NOW() - INTERVAL '1 minute' WHERE "orderId" = '${orderId}'`,
      );
      await inv.releaseExpiredReservations(world.db);
      const rows = await reservations(orderId);
      assert(rows.length > 0 && rows.every((r) => r.status === "released"), `precondition: sweeper released ${orderId}'s reservation`);
    };

    // ── A. merchant cancelled the order, buyer pays the old link anyway ──
    {
      const phone = world.newPhone("af01a");
      await world.grantConsent(phone);
      const order = await createChatOrderViaNlp(world, phone, { items: [{ product: "Jollof Rice", quantity: 1 }] });
      assert(order.paymentRef, "A: order has a payment reference");
      const reserved = await reservations(order.orderId);
      assert(reserved.length === 1 && reserved[0].status === "reserved", "A: precondition — chat order reserved stock");
      const o = await orderRow(order.orderId);
      await cancelOrder(world.db as any, { id: o.id, tenantId: o.tenantId, status: o.status as any }, { reason: "merchant cancelled" });
      const stockAfterCancel = await stock();

      const res = await paystackChargeSuccess(world, { reference: order.paymentRef!, amountMajor: order.total });
      assert(res.status === 200, `A: webhook acked (got ${res.status})`);
      const after = await orderRow(order.orderId);
      assert(after.status === "cancelled", `A: cancelled order stays cancelled (got ${after.status})`);
      assert(after.paymentStatus !== "completed", `A: cancelled order not marked paid (got ${after.paymentStatus})`);
      assert((await stock()) === stockAfterCancel, `A: stock untouched by the late payment (got ${await stock()}, want ${stockAfterCancel})`);
      assert((await escrowRows(order.orderId)).length === 0, "A: no escrow hold opened for a cancelled order");
      const q = await quarantine(order.paymentRef!);
      assert(q.length === 1, "A: late payment quarantined");
      assert(q[0].actualAmountMinor === Math.round(order.total * 100), `A: quarantine records the collected amount (got ${q[0].actualAmountMinor})`);
      const attempts = await refundAttempts(order.orderId);
      assert(attempts.some((a) => a.amountCents === Math.round(order.total * 100)), "A: full auto-refund journaled");

      // Replay: no second refund, order still dead.
      await paystackChargeSuccess(world, { reference: order.paymentRef!, amountMajor: order.total });
      assert((await refundAttempts(order.orderId)).length === attempts.length, "A: replay did not refund twice");
      assert((await orderRow(order.orderId)).status === "cancelled", "A: replay did not revive the order");
      assert((await quarantine(order.paymentRef!)).length === 1, "A: replay did not double-quarantine");
    }

    // ── B. reservation expired and released, stock still available ────────
    {
      const phone = world.newPhone("af01b");
      await world.grantConsent(phone);
      const order = await createChatOrderViaNlp(world, phone, { items: [{ product: "Jollof Rice", quantity: 2 }] });
      assert(order.paymentRef, "B: order has a payment reference");
      await expireAndSweep(order.orderId);
      const stockAfterRelease = await stock();

      const res = await paystackChargeSuccess(world, { reference: order.paymentRef!, amountMajor: order.total });
      assert(res.status === 200, `B: webhook acked (got ${res.status})`);
      const after = await orderRow(order.orderId);
      assert(after.paymentStatus === "completed" && after.status === "confirmed", `B: order confirmed (got ${after.status}/${after.paymentStatus})`);
      assert((await stock()) === stockAfterRelease - 2, `B: stock re-reserved for the paid order (got ${await stock()}, want ${stockAfterRelease - 2})`);
      const committed = (await reservations(order.orderId)).filter((r) => r.status === "committed");
      assert(committed.length === 1 && committed[0].qty === 2, `B: exactly one committed reservation for qty 2 (got ${committed.length})`);
      assert((await quarantine(order.paymentRef!)).length === 0, "B: a payable order is not quarantined");

      await paystackChargeSuccess(world, { reference: order.paymentRef!, amountMajor: order.total });
      assert((await stock()) === stockAfterRelease - 2, "B: replay did not re-reserve twice");
    }

    // ── C. reservation expired and released, stock sold out meanwhile ─────
    {
      const phone = world.newPhone("af01c");
      await world.grantConsent(phone);
      const order = await createChatOrderViaNlp(world, phone, { items: [{ product: "Jollof Rice", quantity: 1 }] });
      assert(order.paymentRef, "C: order has a payment reference");
      await expireAndSweep(order.orderId);
      await world.db.update(schema.products).set({ stockQuantity: 0 })
        .where(and(eq(schema.products.id, PRODUCT_ID), eq(schema.products.tenantId, TENANT_ID)));

      const res = await paystackChargeSuccess(world, { reference: order.paymentRef!, amountMajor: order.total });
      assert(res.status === 200, `C: webhook acked (got ${res.status})`);
      const after = await orderRow(order.orderId);
      assert(after.paymentStatus !== "completed" && after.status !== "confirmed", `C: out-of-stock order not confirmed (got ${after.status}/${after.paymentStatus})`);
      assert((await stock()) === 0, `C: stock never driven negative (got ${await stock()})`);
      assert((await escrowRows(order.orderId)).length === 0, "C: no escrow hold for an unfulfillable order");
      assert((await quarantine(order.paymentRef!)).length === 1, "C: payment quarantined");
      assert((await refundAttempts(order.orderId)).some((a) => a.amountCents === Math.round(order.total * 100)), "C: full auto-refund journaled");
    }

  },
};
