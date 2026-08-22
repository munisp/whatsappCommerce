/**
 * J142 — Delivery aggregation end-to-end: a WhatsApp chat order with
 * delivery fulfillment gets an aggregated courier quote (fee added to the
 * order total in integer cents); the merchant books dispatch through the
 * courier adapter registry; status advances feed the EXISTING order/escrow
 * flow (delivered → escrow delivery_confirmed → SLA release) with
 * fee + net == gross conserved and escrow.ts untouched.
 */
import { eq } from "drizzle-orm";
import { TENANT_ID, assert, type World } from "../world";
import type { Journey } from "../runner";
import { createChatOrderViaNlp, paystackChargeSuccess, tenantCaller } from "./helpers";

export const journey: Journey = {
  id: "J142",
  name: "delivery quote → book → status → escrow release",
  feature: "courier adapter aggregation + escrow tie-in",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const phone = world.newPhone("dlv");
    await world.grantConsent(phone);

    // ── 1. Chat order with delivery fulfillment → aggregated quote ──────
    const order = await createChatOrderViaNlp(world, phone, {
      items: [{ product: "Jollof Rice", quantity: 1 }, { product: "Grilled Chicken", quantity: 1 }],
      fulfillment: "delivery",
      address: "12 Allen Avenue, Ikeja, Lagos",
    });
    const [row] = await world.db.select().from(schema.orders)
      .where(eq(schema.orders.id, order.orderId)).limit(1);
    const meta = (row.metadata as Record<string, unknown>) ?? {};
    const dq = meta.deliveryQuote as { courier: string; feeCents: number; quoteId: string } | undefined;
    assert(dq, "aggregated delivery quote snapshot stored on order metadata");
    assert(dq!.feeCents > 0, "delivery fee quoted in integer cents");
    assert(typeof dq!.courier === "string" && dq!.courier.length > 0, "winning courier recorded");
    // Total = subtotal + delivery fee, exactly (integer cents conserved).
    const subtotalCents = Math.round(parseFloat(String(meta.subtotal)) * 100);
    const totalCents = Math.round(parseFloat(row.totalAmount) * 100);
    assert(totalCents === subtotalCents + dq!.feeCents,
      `order total includes delivery fee (${subtotalCents} + ${dq!.feeCents} != ${totalCents})`);

    // ── 2. Pay (real paystack webhook) → escrow hold ────────────────────
    assert(order.paymentRef, "payment reference captured");
    const pay = await paystackChargeSuccess(world, { reference: order.paymentRef!, amountMajor: order.total });
    assert(pay.status === 200, `paystack webhook accepted (got ${pay.status})`);
    let escrow: any | null = null;
    await world.waitFor(async () => {
      const [e] = await world.db.select().from(schema.escrowTransactions)
        .where(eq(schema.escrowTransactions.orderId, order.orderId)).limit(1);
      escrow = e ?? null;
      return !!escrow && escrow.state === "escrow_held";
    }, 10000, "escrow hold created");

    // ── 3. Merchant books dispatch via the courier registry ─────────────
    const tenant = await tenantCaller(TENANT_ID);
    const booked = await tenant.deliveryAggregation.book({ tenantId: TENANT_ID, orderId: order.orderId });
    assert(booked.delivery.status === "booked", `delivery booked (got ${booked.delivery.status})`);
    assert(booked.delivery.courier === dq!.courier, "booked with the checkout-quote courier");
    assert(booked.delivery.feeCents === dq!.feeCents, "booking fee reconciles with the checkout quote");
    assert(booked.booking.externalId.length > 0, "courier returned an external dispatch id");

    // Idempotent re-book returns the same delivery, not a duplicate.
    const rebook = await tenant.deliveryAggregation.book({ tenantId: TENANT_ID, orderId: order.orderId });
    assert(rebook.delivery.id === booked.delivery.id, "re-book is idempotent");

    // ── 4. Status advances feed the existing order/escrow flow ──────────
    await tenant.deliveryAggregation.advance({ tenantId: TENANT_ID, deliveryId: booked.delivery.id, status: "picked_up" });
    await tenant.deliveryAggregation.advance({ tenantId: TENANT_ID, deliveryId: booked.delivery.id, status: "in_transit" });
    const adv = await tenant.deliveryAggregation.advance({ tenantId: TENANT_ID, deliveryId: booked.delivery.id, status: "delivered" });
    assert(adv.transitioned, "delivered transition applied");

    const [after] = await world.db.select().from(schema.orders)
      .where(eq(schema.orders.id, order.orderId)).limit(1);
    assert(after.status === "delivered", `order marked delivered (got ${after.status})`);
    const [escAfter] = await world.db.select().from(schema.escrowTransactions)
      .where(eq(schema.escrowTransactions.id, escrow.id)).limit(1);
    assert(escAfter.state === "delivery_confirmed",
      `escrow moved to delivery_confirmed by the delivery event (got ${escAfter.state})`);

    // Status history is append-only; a backward move is rejected.
    const back = await tenant.deliveryAggregation.advance({ tenantId: TENANT_ID, deliveryId: booked.delivery.id, status: "picked_up" });
    assert(!back.transitioned, "terminal delivery rejects backward moves");

    // ── 5. Existing SLA sweep releases the escrow (sweep, not escrow.ts) ──
    await world.db.update(schema.escrowConfig)
      .set({ custodyMode: "psp" })
      .where(eq(schema.escrowConfig.id, 1));
    try {
      await world.db.update(schema.escrowTransactions)
        .set({ buyerConfirmDeadline: new Date(Date.now() - 60_000) })
        .where(eq(schema.escrowTransactions.id, escrow.id));
      const { runSlaScan } = await import("../../server/routers/sla");
      const scan = await runSlaScan();
      assert(scan.settled >= 1, "SLA sweep settled the delivered order's escrow");
      const [final] = await world.db.select().from(schema.escrowTransactions)
        .where(eq(schema.escrowTransactions.id, escrow.id)).limit(1);
      assert(final.state === "settled", `escrow released after delivery confirmation (got ${final.state})`);
    } finally {
      await world.db.update(schema.escrowConfig)
        .set({ custodyMode: "pssp" })
        .where(eq(schema.escrowConfig.id, 1));
    }

    // Loyalty points vested on delivery (idempotent earn).
    const earn = await world.db.select().from(schema.loyaltyLedger)
      .where(eq(schema.loyaltyLedger.orderId, order.orderId));
    assert(earn.length === 1 && earn[0].entryType === "earn", "loyalty points vested exactly once on delivery");
  },
};
