/**
 * === W43 exchanges (Coder B) ===
 * J331 — Stock-adjustment audit trail: EVERY stock mutation in the paths
 * Coder B owns writes an append-only stock_adjustments row in the SAME txn:
 *   - order cancel: snapshot restock ('order_cancel') + reservation release
 *     ('reservation_release');
 *   - paid-order cancel: committed release ('committed_reservation_release');
 *   - RMA receive: return restock ('rma') + committed release;
 * and the tenant-scoped tRPC query inventory.adjustmentHistory serves the
 * trail (other tenants see nothing; reason/ref filters work).
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { TENANT_ID, assert, type World } from "../world";
import type { Journey } from "../runner";
import { seedRmaOrder } from "./w41-rma-seed";

export const journey: Journey = {
  id: "J331",
  name: "stock_adjustments audit rows on cancel-release + RMA restock; tenant-scoped history",
  feature: "stock_adjustments audit + inventory.adjustmentHistory",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const { cancelOrder } = await import("../../server/services/orderCancel");
    const { requestReturn, decideReturn, receiveAndRestock } = await import("../../server/services/rma");
    const phone = world.newPhone("j331");
    const auditsFor = (refId: string) =>
      world.db.select().from(schema.stockAdjustments)
        .where(and(eq(schema.stockAdjustments.tenantId, TENANT_ID), eq(schema.stockAdjustments.refId, refId)));

    // ── 1. Unpaid cancel: snapshot restock + reserved-release audited ──
    const orderId = `ord-w43-j331-${randomUUID().slice(0, 8)}`;
    await world.db.insert(schema.orders).values({
      id: orderId, tenantId: TENANT_ID, customerId: phone,
      orderNumber: `W43-J331-${randomUUID().slice(0, 4).toUpperCase()}`,
      status: "pending", totalAmount: "5000.00", currency: "NGN", paymentStatus: "unpaid", metadata: {},
    });
    await world.db.insert(schema.orderItems).values({
      orderId, productId: "p-jollof", productName: "Jollof Rice", quantity: 2, unitPrice: "2500.00", currency: "NGN",
    });
    const resvId = randomUUID();
    await world.db.insert(schema.inventoryReservations).values({
      id: resvId, tenantId: TENANT_ID, orderId, productId: "p-jollof", qty: 2,
      status: "reserved", expiresAt: new Date(Date.now() + 900_000),
    });
    const [order] = await world.db.select().from(schema.orders).where(eq(schema.orders.id, orderId));
    await cancelOrder(world.db, order as any, { reason: "buyer changed mind" });

    const cancelAudit = await auditsFor(orderId);
    assert(cancelAudit.some((r) => r.refType === "order_cancel" && r.reason === "restock" && r.deltaQty === 2 && r.productId === "p-jollof"),
      "order_cancel snapshot restock audited");
    const relAudit = await auditsFor(resvId);
    assert(relAudit.some((r) => r.refType === "reservation_release" && r.reason === "restock" && r.deltaQty === 2),
      "reservation release audited");

    // ── 2. Paid RMA receive: rma restock + committed-release audited ──
    const seed = await seedRmaOrder(world, "j331", phone);
    const notify = { waSend: async () => {}, tgSend: async () => {} };
    const { rma } = await requestReturn(world.db, {
      tenantId: TENANT_ID, buyerRef: phone, orderId: seed.orderId, reason: "wrong size", ...notify,
    });
    await decideReturn(world.db, { rmaId: rma.id, tenantId: TENANT_ID, approve: true, ...notify });
    await receiveAndRestock(world.db, { rmaId: rma.id, tenantId: TENANT_ID, ...notify });

    const rmaAudit = await auditsFor(rma.id);
    assert(rmaAudit.some((r) => r.refType === "rma" && r.reason === "restock" && r.deltaQty === 2 && r.productId === "p-jollof"),
      "rma restock audited");
    const [committedResv] = await world.db.select().from(schema.inventoryReservations)
      .where(eq(schema.inventoryReservations.orderId, seed.orderId));
    const committedAudit = await auditsFor(committedResv.id);
    assert(committedAudit.some((r) => r.refType === "committed_reservation_release" && r.deltaQty === 2),
      "committed release audited");

    // ── 3. inventory.adjustmentHistory tRPC query, tenant-scoped ──
    // A foreign-tenant row must NEVER leak through the query.
    await world.db.insert(schema.stockAdjustments).values({
      tenantId: "w43-other-tenant", productId: "p-jollof", deltaQty: 99,
      reason: "theft", refType: "manual", refId: "foreign",
    });
    const { appRouter } = await import("../../server/routers");
    const caller = appRouter.createCaller({
      user: {
        id: 1, openId: "sim-admin", email: "admin@sim.local", name: "Sim Admin",
        loginMethod: "keycloak", role: "admin",
        createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date(),
      },
      res: { clearCookie: () => {} },
    } as any);

    const history: any[] = await (caller as any).inventory.adjustmentHistory({ tenantId: TENANT_ID, limit: 500 });
    assert(history.length > 0, "history returns rows for the tenant");
    assert(history.every((r) => r.tenantId === TENANT_ID), "history is tenant-scoped");
    assert(history.some((r) => r.refType === "order_cancel" && r.refId === orderId), "cancel rows visible");
    assert(history.some((r) => r.refType === "rma" && r.refId === rma.id), "rma rows visible");

    const restocksOnly: any[] = await (caller as any).inventory.adjustmentHistory({ tenantId: TENANT_ID, reason: "restock", productId: "p-jollof", limit: 500 });
    assert(restocksOnly.length > 0 && restocksOnly.every((r) => r.reason === "restock" && r.productId === "p-jollof"), "reason+product filters");

    const foreign: any[] = await (caller as any).inventory.adjustmentHistory({ tenantId: "w43-other-tenant", limit: 10 });
    assert(foreign.length === 1 && foreign[0].reason === "theft", "foreign tenant sees only its own rows");
  },
};
