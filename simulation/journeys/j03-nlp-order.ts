/**
 * J3 — NLP order: "2 jollof rice and 1 chicken" → cart → confirm → itemized
 * summary → pickup choice → payment link on the total.
 */
import { and, eq } from "drizzle-orm";
import { TENANT_ID, assert, assertIncludes, bodyText, type World } from "../world";
import type { Journey } from "../runner";
import { lastReply, nlpAddToCart, nlpConfirm, replyCount } from "./helpers";

export const journey: Journey = {
  id: "J03",
  name: "NLP order + payment link",
  feature: "nlpCart → checkout → paystack link",
  async run(world) {
    const phone = world.newPhone("a");
    await world.grantConsent(phone);

    // 1. Natural-language add to cart.
    await nlpAddToCart(world, phone, "2 jollof rice and 1 chicken", [
      { product: "Jollof Rice", quantity: 2 },
      { product: "Grilled Chicken", quantity: 1 },
    ]);
    const addMsg = lastReply(world, phone);
    const addReply = bodyText(addMsg);
    assertIncludes(addReply, "2 × Jollof Rice", "add-to-cart summary lists jollof x2");
    assertIncludes(addReply, "1 × Grilled Chicken", "add-to-cart summary lists chicken x1");
    assertIncludes(addReply, "🛒 Cart: 3 items · ₦8,000.00", "cart total shown after adding");
    assertIncludes(JSON.stringify(addMsg?.body), "say:checkout", "Checkout button offered after adding");

    // 2. Confirm → itemized summary + fulfillment options.
    await nlpConfirm(world, phone, "confirm my order please");
    const summaryMsg = lastReply(world, phone);
    const summary = bodyText(summaryMsg);
    assertIncludes(JSON.stringify(summaryMsg?.body), "say:2", "Delivery offered as a button");
    assertIncludes(summary, "2 × Jollof Rice", "confirm summary itemizes jollof");
    assertIncludes(summary, "1 × Grilled Chicken", "confirm summary itemizes chicken");
    assertIncludes(summary, "₦8,000.00", "confirm summary shows ₦8,000 subtotal");
    assertIncludes(summary, "Pickup", "fulfillment options offered");

    // 3. Pickup → order + payment link.
    const beforePickup = replyCount(world, phone);
    await world.buttonReply(phone, "say:1", "🏪 Pickup");
    await world.waitFor(() => replyCount(world, phone) > beforePickup, 15000, "order reply");
    await world.settle();

    // 4. ONE message: the order summary with a Pay now button.
    assert(replyCount(world, phone) === beforePickup + 1, `order step is a single message (got ${replyCount(world, phone) - beforePickup})`);
    const payMsg = lastReply(world, phone);
    const orderMsg = bodyText(payMsg);
    assertIncludes(orderMsg, "Order", "order confirmation message");
    assertIncludes(orderMsg, "₦8,000.00", "order total ₦8,000.00");
    assert(payMsg?.body?.interactive?.type === "cta_url", `summary carries a Pay button (got ${payMsg?.body?.interactive?.type})`);
    assertIncludes(JSON.stringify(payMsg?.body), "https://checkout.paystack.com/sim/", "Pay button opens the paystack link");
    assert(!orderMsg.includes("Click here to complete payment"), "raw payment link line replaced by the button");

    // 5. State: order row, reservations, payment transaction.
    const schema = await import("../../drizzle/schema");
    const [order] = await world.db.select().from(schema.orders)
      .where(and(eq(schema.orders.tenantId, TENANT_ID), eq(schema.orders.customerId, phone)))
      .limit(1);
    assert(order, "orders row exists");
    assert(Number(order.totalAmount) === 8000, `order total is 8000 (got ${order.totalAmount})`);
    assert(order.status === "pending", "order starts pending (awaiting payment)");
    const items = order.items as any[];
    assert(items.length === 2 && items.some((i) => i.name === "Jollof Rice" && i.qty === 2), "order items persisted");

    const reservations = await world.db.select().from(schema.inventoryReservations)
      .where(eq(schema.inventoryReservations.orderId, order.id));
    assert(reservations.length === 2, "two stock reservations created");
    assert(reservations.every((r: any) => r.status === "reserved"), "reservations are reserved");
    const jollofRes = reservations.find((r: any) => r.productId === "p-jollof");
    assert(jollofRes?.qty === 2, "jollof reservation quantity 2");

    const [tx] = await world.db.select().from(schema.paymentTransactions)
      .where(eq(schema.paymentTransactions.orderId, order.id)).limit(1);
    assert(tx?.status === "initiated", "payment transaction initiated");
    assertIncludes(tx?.paymentUrl, "https://checkout.paystack.com/sim/", "tx paymentUrl is the mocked paystack link");
    assert(Number(tx.amount) === 8000, "tx amount 8000");

    // 6. Stock reserved (seed - 2 available jollof).
    const { PRODUCTS } = await import("../world");
    const [jollof] = await world.db.select().from(schema.products).where(eq(schema.products.id, "p-jollof")).limit(1);
    assert(jollof.stockQuantity === PRODUCTS.jollof.stock - 2, `jollof stock reserved to ${PRODUCTS.jollof.stock - 2} (got ${jollof.stockQuantity})`);
  },
};
