/**
 * J3 — NLP order: "2 jollof rice and 1 chicken" → cart → confirm → itemized
 * summary → pickup choice → payment link on the total.
 */
import { and, eq } from "drizzle-orm";
import { TENANT_ID, assert, assertIncludes, bodyText, type World } from "../world";
import type { Journey } from "../runner";
import { nlpAddToCart, nlpConfirm } from "./helpers";

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
    const addReply = bodyText(world.outbound.lastOfType("text", phone));
    assertIncludes(addReply, "2 × Jollof Rice", "add-to-cart summary lists jollof x2");
    assertIncludes(addReply, "1 × Grilled Chicken", "add-to-cart summary lists chicken x1");

    // 2. Confirm → itemized summary + fulfillment options.
    await nlpConfirm(world, phone, "confirm my order please");
    const summary = bodyText(world.outbound.lastOfType("text", phone));
    assertIncludes(summary, "2 × Jollof Rice", "confirm summary itemizes jollof");
    assertIncludes(summary, "1 × Grilled Chicken", "confirm summary itemizes chicken");
    assertIncludes(summary, "₦8,000.00", "confirm summary shows ₦8,000 subtotal");
    assertIncludes(summary, "Pickup", "fulfillment options offered");

    // 3. Pickup → order + payment link.
    await world.text(phone, "1");
    const orderMsg = bodyText(world.outbound.lastOfType("text", phone));
    assertIncludes(orderMsg, "Order", "order confirmation message");
    assertIncludes(orderMsg, "₦8,000.00", "order total ₦8,000.00");
    assertIncludes(orderMsg, "https://checkout.paystack.com/sim/", "paystack payment link present");

    // 4. Order action card with Track/Pay/Cancel buttons.
    const card = world.outbound.lastOfType("interactive", phone);
    assert(card, "order action card sent as interactive message");
    const cardStr = JSON.stringify(card.body);
    assertIncludes(cardStr, "order_track:", "card has Track button");
    assertIncludes(cardStr, "order_pay:", "card has Pay button");
    assertIncludes(cardStr, "order_cancel:", "card has Cancel button");

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
