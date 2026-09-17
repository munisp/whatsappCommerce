/**
 * === W41 rma-fx (Coder C) ===
 * J306 — Honest doctrine: with dual display configured, the PSP charge stays
 * in NGN. The order total, the payment link amount and the payment row are
 * all NGN (kobo); only the message rendering shows the approximate USD.
 */
import { and, desc, eq } from "drizzle-orm";
import { TENANT_ID, assert, assertIncludes, bodyText, type World } from "../world";
import type { Journey } from "../runner";
import { createChatOrderViaNlp } from "./helpers";

export const journey: Journey = {
  id: "J306",
  name: "NGN charge unchanged under dual display",
  feature: "display-only FX: payment link + payment row stay NGN kobo",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    await world.db.update(schema.tenants).set({
      displayCurrency: "USD",
      displayFxRates: { USD: { rate: "0.00066", updatedAt: new Date().toISOString() } },
    }).where(eq(schema.tenants.id, TENANT_ID));

    const phone = world.newPhone("j306");
    await world.grantConsent(phone);
    const outcome = await createChatOrderViaNlp(world, phone, {
      items: [
        { product: "Jollof Rice", quantity: 2 },
        { product: "Grilled Chicken", quantity: 1 },
      ],
      addText: "2 jollof rice and 1 chicken j306",
      confirmText: "confirm my order j306",
      fulfillment: "pickup",
    });

    // Summary text: dual display + honest footer.
    assertIncludes(outcome.summaryText, "₦8,000.00", "NGN total shown");
    assertIncludes(outcome.summaryText, "(~$", "dual display shown");
    assertIncludes(outcome.summaryText, "charged in NGN", "honest footer");
    assertIncludes(outcome.summaryText, "https://checkout.paystack.com/sim/", "NGN payment link present");

    // The order itself: NGN, 8000 major units — no conversion.
    const [order] = await world.db.select().from(schema.orders)
      .where(and(eq(schema.orders.tenantId, TENANT_ID), eq(schema.orders.customerId, phone)))
      .orderBy(desc(schema.orders.createdAt)).limit(1);
    assert(order, "order created");
    assert(order.currency === "NGN", `order currency NGN (got ${order.currency})`);
    assert(Number(order.totalAmount) === 8000, `order total 8000 NGN (got ${order.totalAmount})`);

    // The payment transaction row: NGN, untouched by the display rate.
    const [tx] = await world.db.select().from(schema.paymentTransactions)
      .where(eq(schema.paymentTransactions.orderId, order.id)).limit(1);
    assert(tx, "payment transaction created");
    assert(tx.status === "initiated", `payment initiated (got ${tx.status})`);
    assert(tx.currency === "NGN", `payment currency NGN (got ${tx.currency})`);
    assert(Number(tx.amount) === 8000 || Number(tx.amount) === 800_000,
      `payment amount is the NGN figure, never the USD one (got ${tx.amount})`);

    await world.db.update(schema.tenants).set({ displayCurrency: null, displayFxRates: null })
      .where(eq(schema.tenants.id, TENANT_ID));
  },
};
