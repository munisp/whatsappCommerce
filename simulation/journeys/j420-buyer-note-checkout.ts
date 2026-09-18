// === W46 orders-p2 (Coder G) ===
/**
 * J420 — ORD-25: buyer free-text note captured at chat checkout is persisted
 * onto orders.notes. Covers the extractor grammar (explicit "note:" /
 * "add note —" / "instructions:" markers only — never guesses) and the
 * createChatOrder seam both channels share.
 */
import { eq } from "drizzle-orm";
import { assert, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J420",
  name: "buyer free-text note lands on orders.notes at chat checkout",
  feature: "ORD-25 extractBuyerNote + createChatOrder buyerNote",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const { extractBuyerNote, createChatOrder } = await import("../../server/routers/nlp");

    // Extractor grammar.
    assert(extractBuyerNote("note: leave at the gate") === "leave at the gate", "note: marker");
    assert(extractBuyerNote("2 delivery, add note — call when you arrive") === "call when you arrive", "add note — marker");
    assert(extractBuyerNote("delivery note: knock twice") === "knock twice", "delivery note marker");
    assert(extractBuyerNote("Instructions: no onions please") === "no onions please", "instructions marker");
    assert(extractBuyerNote("12 Adeola Odeku St") === null, "plain address is never a note");
    assert(extractBuyerNote("thanks, noted!") === null, "no marker → no note");
    assert(extractBuyerNote(`note: ${"x".repeat(600)}`)?.length === 500, "note capped at 500 chars");

    // End-to-end through the checkout seam: cart → order with notes set.
    const phone = world.newPhone("j420");
    const productId = "prod-w46-j420";
    await world.db.execute(`DELETE FROM products WHERE id = '${productId}'`).catch(() => undefined);
    await world.db.insert(schema.products).values({
      id: productId,
      tenantId: TENANT_ID,
      sku: "SIM-W46-J420",
      name: "W46 Note Product",
      price: "5000.00",
      currency: "NGN",
      status: "active",
      stockQuantity: 5,
      weightKg: "1.000",
    });
    const cartSessionId = crypto.randomUUID();
    await world.db.insert(schema.cartSessions).values({
      id: cartSessionId,
      tenantId: TENANT_ID,
      waPhoneNumber: phone,
      sessionData: {},
    });
    await world.db.insert(schema.cartItems).values({
      id: crypto.randomUUID(),
      cartSessionId,
      productId,
      productName: "W46 Note Product",
      quantity: 1,
      unitPrice: "5000.00",
      currency: "NGN",
    });

    const order = await createChatOrder(world.db, {
      tenantId: TENANT_ID,
      waPhoneNumber: phone,
      cartSessionId,
      fulfillment: "delivery",
      address: "12 Adeola Odeku St",
      buyerNote: "leave at the gate, call on arrival",
    });
    assert(order.created && order.orderId, `order created (got ${JSON.stringify(order).slice(0, 200)})`);
    const [row] = await world.db.select().from(schema.orders).where(eq(schema.orders.id, order.orderId!));
    assert(row.notes === "leave at the gate, call on arrival", `orders.notes carries the buyer note (got ${row.notes})`);

    // No note → orders.notes stays NULL (no guessed/empty notes).
    const cart2 = crypto.randomUUID();
    await world.db.insert(schema.cartSessions).values({ id: cart2, tenantId: TENANT_ID, waPhoneNumber: phone, sessionData: {} });
    await world.db.insert(schema.cartItems).values({
      id: crypto.randomUUID(), cartSessionId: cart2, productId,
      productName: "W46 Note Product", quantity: 1, unitPrice: "5000.00", currency: "NGN",
    });
    const order2 = await createChatOrder(world.db, {
      tenantId: TENANT_ID, waPhoneNumber: phone, cartSessionId: cart2,
      fulfillment: "pickup", address: null, buyerNote: null,
    });
    assert(order2.created, "second order created");
    const [row2] = await world.db.select().from(schema.orders).where(eq(schema.orders.id, order2.orderId!));
    assert(row2.notes === null, "no note → notes stays NULL");
  },
};
// === END W46 orders-p2 ===
