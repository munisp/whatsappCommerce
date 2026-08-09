/**
 * J12 — Smart reorder: "repeat my last order" rebuilds the cart from the
 * last PAID order at current catalog prices, noting price changes.
 */
import { eq } from "drizzle-orm";
import { assert, assertIncludes, bodyText, type World } from "../world";
import type { Journey } from "../runner";
import { createChatOrderViaNlp, paystackChargeSuccess } from "./helpers";

export const journey: Journey = {
  id: "J12",
  name: "smart reorder",
  feature: "reorder → repriced cart",
  async run(world) {
    const phone = world.newPhone("a");
    await world.grantConsent(phone);
    const schema = await import("../../drizzle/schema");

    // 1. Place + pay for an order (1 jollof @ 2500).
    const first = await createChatOrderViaNlp(world, phone, { items: [{ product: "Jollof Rice", quantity: 1 }] });
    await paystackChargeSuccess(world, { reference: first.paymentRef!, amountMajor: first.total });
    await world.waitFor(async () => {
      const [o] = await world.db.select().from(schema.orders).where(eq(schema.orders.id, first.orderId)).limit(1);
      return o?.paymentStatus === "completed";
    }, 10000, "first order paid");

    // 2. Price change since the last order: 2500 → 2800.
    await world.db.update(schema.products).set({ price: "2800.00" }).where(eq(schema.products.id, "p-jollof"));

    // 3. "repeat my last order" → reorder intent → repriced cart.
    world.llm.when("repeat my last order", {
      reply: "One moment, rebuilding your cart…",
      intent: "reorder",
      nextState: "browse",
      extractedItems: [],
      extractedProduct: null,
      extractedQuantity: null,
      extractedAddress: null,
      confidence: 0.95,
    });
    await world.text(phone, "repeat my last order");
    const reply = bodyText(world.outbound.lastOfType("text", phone));
    assertIncludes(reply, "Reordering from", "reorder reply references the last order");
    assertIncludes(reply, first.orderNumber, "reorder reply names the order number");
    assertIncludes(reply, "1 × Jollof Rice", "reorder re-adds the item");
    assertIncludes(reply, "2800.00", "reorder repriced to today's catalog price");
    assertIncludes(reply, "was 2500.00", "price change is called out");

    // 4. The repriced cart feeds the standard checkout.
    const cartRows = await world.db.select().from(schema.cartItems);
    const mine = cartRows.filter((r: any) => r.productName === "Jollof Rice");
    assert(mine.some((r: any) => Number(r.unitPrice) === 2800), "cart carries the new unit price");

    // restore price for other journeys
    await world.db.update(schema.products).set({ price: "2500.00" }).where(eq(schema.products.id, "p-jollof"));
  },
};
