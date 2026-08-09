/**
 * J18 — Stock guard: two buyers race for the LAST unit — exactly one order
 * is created; ordering an out-of-stock item gets a shortage reply with NO
 * payment link; "NOTIFY ME" joins the waitlist.
 */
import { and, eq } from "drizzle-orm";
import { PHONE_NUMBER_ID, TENANT_ID, assert, assertIncludes, bodyText, type World } from "../world";
import * as payloads from "../payloads";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J18",
  name: "stock guard (race + OOS)",
  feature: "reserveStock atomicity + waitlist",
  async run(world) {
    const schema = await import("../../drizzle/schema");

    // Reset the last-unit product to exactly 1 in stock.
    await world.db.update(schema.products).set({ stockQuantity: 1 }).where(eq(schema.products.id, "p-lastunit"));

    const phoneA = world.newPhone("a");
    const phoneB = world.newPhone("b");
    await world.grantConsent(phoneA);
    await world.grantConsent(phoneB);

    const scriptCheckout = (phone: string, tag: string) => {
      world.llm.when(`last unit special ${tag}`, {
        reply: "Added!",
        intent: "add_to_cart",
        nextState: "add_to_cart",
        extractedItems: [{ product: "Last Unit Special", quantity: 1 }],
        extractedProduct: null,
        extractedQuantity: null,
        extractedAddress: null,
        confidence: 0.95,
      });
      world.llm.when(`confirm ${tag}`, {
        reply: "Confirming.",
        intent: "confirm_order",
        nextState: "checkout_confirm",
        extractedItems: [],
        extractedProduct: null,
        extractedQuantity: null,
        extractedAddress: null,
        confidence: 0.95,
      });
    };
    scriptCheckout(phoneA, "A");
    scriptCheckout(phoneB, "B");

    // Both buyers build carts and hit confirm, then race pickup.
    await world.text(phoneA, "last unit special A");
    await world.text(phoneB, "last unit special B");
    await world.text(phoneA, "confirm A");
    await world.text(phoneB, "confirm B");

    // Fire both fulfillment choices WITHOUT settling between them — a true race.
    await Promise.all([
      world.postWebhook(payloads.inbound.text(PHONE_NUMBER_ID, phoneA, "1")),
      world.postWebhook(payloads.inbound.text(PHONE_NUMBER_ID, phoneB, "1")),
    ]);
    // Wait for exactly one winner to emerge (order created)…
    const countLastUnitOrders = async () => {
      const orders = await world.db.select().from(schema.orders).where(eq(schema.orders.tenantId, TENANT_ID));
      return orders.filter((o: any) =>
        (o.items as any[]).some((i) => i.productId === "p-lastunit" || i.name === "Last Unit Special"),
      );
    };
    await world.waitFor(async () => (await countLastUnitOrders()).length >= 1, 12000, "one racer created an order");
    await world.settle(1500); // let the loser's shortage reply land
    const lastUnitOrders = await countLastUnitOrders();
    assert(lastUnitOrders.length === 1, `exactly one order won the last unit (got ${lastUnitOrders.length})`);

    const [prod] = await world.db.select().from(schema.products).where(eq(schema.products.id, "p-lastunit")).limit(1);
    assert(prod.stockQuantity === 0, `stock is 0 after the race (got ${prod.stockQuantity}) — never negative`);

    const winner = lastUnitOrders[0].customerId;
    const loser = winner === phoneA ? phoneB : phoneA;
    await world.waitFor(() => world.outbound.toPhone(loser).map((c) => bodyText(c)).join("\n").includes("stock"), 10000, "loser shortage reply");
    const loserReplies = world.outbound.toPhone(loser).map((c) => bodyText(c)).join("\n");
    assertIncludes(loserReplies, "stock", "loser gets a shortage reply");
    assertIncludes(loserReplies, "NOTIFY ME", "shortage reply offers the waitlist");
    assert(!loserReplies.includes("checkout.paystack.com"), "loser got NO payment link");

    // Loser joins the waitlist via NOTIFY ME.
    await world.text(loser, "NOTIFY ME");
    const waitReply = bodyText(world.outbound.lastOfType("text", loser));
    assert(
      waitReply.includes("let you know") || waitReply.includes("notify") || waitReply.includes("back in stock"),
      `waitlist subscription acknowledged (got ${waitReply.slice(0, 140)})`,
    );
    const waitlist = await world.db.select().from(schema.waitlistEntries)
      .where(and(eq(schema.waitlistEntries.tenantId, TENANT_ID), eq(schema.waitlistEntries.phone, loser)));
    assert(waitlist.length === 1 && waitlist[0].productId === "p-lastunit", "waitlist entry recorded for the loser");

    // ── Out-of-stock order attempt → shortage, no payment link ───────────
    const phoneC = world.newPhone("c");
    await world.grantConsent(phoneC);
    world.llm.when("sold out sneakers please", {
      reply: "Sure!",
      intent: "add_to_cart",
      nextState: "add_to_cart",
      extractedItems: [{ product: "Sold Out Sneakers", quantity: 1 }],
      extractedProduct: null,
      extractedQuantity: null,
      extractedAddress: null,
      confidence: 0.95,
    });
    await world.text(phoneC, "sold out sneakers please");
    const oosReply = world.outbound.toPhone(phoneC).map((c) => bodyText(c)).join("\n");
    assertIncludes(oosReply, "out of stock", "OOS item produces a shortage note");
    assert(!oosReply.includes("checkout.paystack.com"), "OOS attempt produced no payment link");
    const ordersAfter = await world.db.select().from(schema.orders).where(eq(schema.orders.tenantId, TENANT_ID));
    const oosOrders = ordersAfter.filter((o: any) => o.customerId === phoneC);
    assert(oosOrders.length === 0, "no order created for the OOS item");
  },
};
