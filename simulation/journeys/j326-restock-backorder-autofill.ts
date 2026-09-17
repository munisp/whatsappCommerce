/**
 * === W43 fulfillment (Coder A) ===
 * J326 — Restock auto-fill: restocking a SKU fills its open backorders
 * OLDEST-FIRST within the same transaction — products.stockQuantity is
 * decremented for the filled units, a 'committed' reservation is written for
 * the filled order, the fully-filled line returns to 'ordered', and the
 * customer is notified via the channelParity-registered 'backorder_filled'
 * category (WhatsApp AND Telegram).
 */
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { TENANT_ID, assert, type World } from "../world";
import type { Journey } from "../runner";
import { setAllowBackorders } from "./w43-fulfillment-seed";

async function seedBackorderedOrder(world: World, tag: string, phone: string, productId: string, qty: number) {
  const schema = await import("../../drizzle/schema");
  const { markLineBackordered } = await import("../../server/services/backorders");
  const orderId = `ord-w43-${tag}-${randomUUID().slice(0, 8)}`;
  await world.db.insert(schema.orders).values({
    id: orderId,
    tenantId: TENANT_ID,
    customerId: phone,
    orderNumber: `W43-${tag}-${randomUUID().slice(0, 4).toUpperCase()}`,
    status: "confirmed",
    totalAmount: "500.00",
    currency: "NGN",
    paymentStatus: "completed",
    metadata: {},
  });
  const orderLineId = randomUUID();
  await world.db.insert(schema.orderItems).values({
    id: orderLineId,
    orderId,
    productId,
    productName: "W43 Restock Widget",
    quantity: qty,
    unitPrice: "500.00",
    currency: "NGN",
    status: "backordered",
  });
  const { backorderId } = await markLineBackordered(world.db, { tenantId: TENANT_ID, orderLineId, qty });
  return { orderId, orderLineId, backorderId };
}

export const journey: Journey = {
  id: "J326",
  name: "restock auto-fills backorders oldest-first + both-channel notify",
  feature: "backorder_requests auto-fill + backorder_filled parity category",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const { restockAndFillBackorders } = await import("../../server/services/backorders");
    const phone = world.newPhone("j326");
    const productId = `p-w43-j326-${randomUUID().slice(0, 6)}`;
    await world.db.insert(schema.products).values({
      id: productId,
      tenantId: TENANT_ID,
      sku: `W43-J326-${randomUUID().slice(0, 6)}`,
      name: "W43 Restock Widget",
      price: "500.00",
      currency: "NGN",
      stockQuantity: 0,
      status: "active",
    } as any);
    await setAllowBackorders(world, true);

    try {
      // Two backordered orders for the same SKU: older (2 units) + newer (2).
      const older = await seedBackorderedOrder(world, "j326a", phone, productId, 2);
      await new Promise((r) => setTimeout(r, 20)); // distinct createdAt
      const newer = await seedBackorderedOrder(world, "j326b", phone, productId, 2);

      // Duplicate mark on the same line is idempotent (tops up, no 2nd row).
      const dup = await markLineBackorderedIdempotent(world, newer.orderLineId);
      assert(dup === 1, `still 1 open request after duplicate mark (got ${dup})`);

      const notified: { category: string; text: string }[] = [];
      const notify = async (_t: string, _ref: string, category: string, text: string) => {
        notified.push({ category, text });
      };

      // 1. Restock 3 units: oldest order fully filled (2), newer partially (1).
      const fills1 = await restockAndFillBackorders(world.db, {
        tenantId: TENANT_ID, productId, qty: 3, notify,
      });
      assert(fills1.length === 2, `2 fills oldest-first (got ${fills1.length})`);
      assert(fills1[0].orderId === older.orderId && fills1[0].fullyFilled && fills1[0].filledQty === 2,
        "oldest filled first, fully");
      assert(fills1[1].orderId === newer.orderId && !fills1[1].fullyFilled && fills1[1].filledQty === 1,
        "newer partially filled");

      const [prod] = await world.db.select().from(schema.products).where(eq(schema.products.id, productId));
      assert(prod.stockQuantity === 0, `3 restocked - 3 filled = 0 (got ${prod.stockQuantity})`);

      const [olderBo] = await world.db.select().from(schema.backorderRequests)
        .where(eq(schema.backorderRequests.id, older.backorderId));
      assert(olderBo.status === "filled" && olderBo.filledQty === 2, `older filled (got ${olderBo.status})`);
      const [newerBo] = await world.db.select().from(schema.backorderRequests)
        .where(eq(schema.backorderRequests.id, newer.backorderId));
      assert(newerBo.status === "partially_filled" && newerBo.filledQty === 1,
        `newer partially_filled (got ${newerBo.status}/${newerBo.filledQty})`);

      const [olderLine] = await world.db.select().from(schema.orderItems)
        .where(eq(schema.orderItems.id, older.orderLineId));
      assert(olderLine.status === "ordered", `filled line back to ordered (got ${olderLine.status})`);

      const olderResv = await world.db.select().from(schema.inventoryReservations)
        .where(eq(schema.inventoryReservations.orderId, older.orderId));
      assert(olderResv.length === 1 && olderResv[0].status === "committed" && olderResv[0].qty === 2,
        `committed reservation for filled order (got ${olderResv.length}/${olderResv[0]?.status})`);

      // 2. Restock 1 more: newer completes.
      const fills2 = await restockAndFillBackorders(world.db, {
        tenantId: TENANT_ID, productId, qty: 1, notify,
      });
      assert(fills2.length === 1 && fills2[0].orderId === newer.orderId && fills2[0].fullyFilled,
        "newer completed on second restock");
      const [newerBo2] = await world.db.select().from(schema.backorderRequests)
        .where(eq(schema.backorderRequests.id, newer.backorderId));
      assert(newerBo2.status === "filled", `newer filled (got ${newerBo2.status})`);

      // 3. Every fill notified on the parity-registered category.
      assert(notified.length === 3 && notified.every((n) => n.category === "backorder_filled"),
        `backorder_filled notifications (got ${notified.map((n) => n.category).join(",")})`);
      const parity = await import("../../server/services/channelParity");
      const cat = parity.getParityCategory("backorder_filled");
      assert(!!cat && cat.telegram === "full", "backorder_filled registered for BOTH channels");
    } finally {
      await setAllowBackorders(world, false);
    }
  },
};

async function markLineBackorderedIdempotent(world: World, orderLineId: string): Promise<number> {
  const schema = await import("../../drizzle/schema");
  const { markLineBackordered } = await import("../../server/services/backorders");
  const { eq } = await import("drizzle-orm");
  await markLineBackordered(world.db, { tenantId: TENANT_ID, orderLineId, qty: 1 });
  const rows = await world.db.select().from(schema.backorderRequests)
    .where(eq(schema.backorderRequests.orderLineId, orderLineId));
  // Reset the top-up so the journey's qty math stays exact.
  await world.db.update(schema.backorderRequests)
    .set({ qty: 2 } as any)
    .where(eq(schema.backorderRequests.orderLineId, orderLineId));
  return rows.length;
}
