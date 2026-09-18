// === W46 uc-ux (Coder E) ===
/**
 * J407 — UC-17: venue-table QR deep link seeds cart metadata; the chat order
 * carries the venue table onto orders.metadata; the kitchen board lists
 * active table orders and drops terminal ones.
 */
import { eq } from "drizzle-orm";
import { assert, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";
import { seedCartWithProduct } from "./w46-uc-ux-seed";

export const journey: Journey = {
  id: "J407",
  name: "venue table QR deep link → cart metadata → kitchen board",
  feature: "UC-17 venue_tables + QR deep link + kitchen board view",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const svc = await import("../../server/services/venueTables");
    const { createChatOrder } = await import("../../server/routers/nlp");
    const phone = world.newPhone("j407");
    await world.grantConsent(phone);

    // ── Create a venue table + resolve via its QR capability token ──
    const table = await svc.createVenueTable(world.db, { tenantId: TENANT_ID, label: "Table 7" });
    assert(table.qrToken.length >= 8, "qr token minted");
    const resolved = await svc.resolveTableByToken(world.db, TENANT_ID, table.qrToken);
    assert(resolved?.label === "Table 7", "token resolves to the table");
    assert((await svc.resolveTableByToken(world.db, TENANT_ID, "vt_bogus")) === null, "unknown token resolves null");

    // ── QR deep link seeds the cart session metadata ──
    const seeded = await svc.seedCartFromTableQr(world.db, { tenantId: TENANT_ID, qrToken: table.qrToken, waPhoneNumber: phone });
    assert(seeded && seeded.tableLabel === "Table 7", "QR scan seeds the cart");
    const [cart] = await world.db.select().from(schema.cartSessions).where(eq(schema.cartSessions.id, seeded!.cartSessionId));
    assert((cart.sessionData as any)?.venueTable?.tableId === table.id, "cart sessionData carries venueTable");
    // Idempotent re-scan on the SAME cart.
    const again = await svc.seedCartFromTableQr(world.db, { tenantId: TENANT_ID, qrToken: table.qrToken, waPhoneNumber: phone });
    assert(again!.cartSessionId === seeded!.cartSessionId, "re-scan refreshes the same cart session");

    // ── Chat order placed from a table-stamped cart carries the venue stamp ──
    const { cartSessionId } = await seedCartWithProduct(world, "j407", phone, { unitPrice: "2500.00", qty: 2 });
    await world.db.update(schema.cartSessions).set({
      sessionData: { venueTable: { tableId: table.id, label: "Table 7" } },
    }).where(eq(schema.cartSessions.id, cartSessionId));

    const order = await createChatOrder(world.db, {
      tenantId: TENANT_ID,
      waPhoneNumber: phone,
      cartSessionId,
      fulfillment: "pickup",
      address: null,
    });
    assert(order.created === true, `order created (got ${JSON.stringify(order)})`);
    assert(order.venueTable?.tableId === table.id, "venue table attached via the createChatOrder seam");
    const [ord] = await world.db.select().from(schema.orders).where(eq(schema.orders.id, order.orderId!));
    assert((ord.metadata as any)?.venueTable?.label === "Table 7", "orders.metadata.venueTable persisted");

    // ── Kitchen board: active order visible, terminal order gone ──
    const board = await svc.getKitchenBoard(world.db, TENANT_ID);
    assert(board.some((b) => b.orderId === order.orderId && b.tableLabel === "Table 7"), "kitchen board lists the table order");
    await world.db.update(schema.orders).set({ status: "delivered" }).where(eq(schema.orders.id, order.orderId!));
    const boardAfter = await svc.getKitchenBoard(world.db, TENANT_ID);
    assert(!boardAfter.some((b) => b.orderId === order.orderId), "delivered order drops off the kitchen board");
    // Parity: venue_order category registered for both channels.
    const parity = await import("../../server/services/channelParity");
    assert(parity.getParityCategory("venue_order")?.telegram === "full", "venue_order parity category registered");
  },
};
// === END W46 uc-ux ===
