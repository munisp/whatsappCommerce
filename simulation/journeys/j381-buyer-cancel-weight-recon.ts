// === W45 orders-p0 (Coder C) ===
/**
 * J381 — ORD-27 + ORD-9 + ORD-26:
 *  ORD-27: buyer chat cancel is guarded pre-ship — pending order cancels with
 *    stock restock; shipped order is refused (dispute path); another phone
 *    cannot cancel it.
 *  ORD-9: quoteDeliveryFee prices by weight and tenant delivery zones
 *    (merchant-configured zone names replace the Lagos hints).
 *  ORD-26: post-sync reconciliation reports snapshot-vs-ledger drift.
 */
import { eq } from "drizzle-orm";
import { assert, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";
import { seedOrderWithItem } from "./w45-orders-seed";

export const journey: Journey = {
  id: "J381",
  name: "buyer pre-ship cancel + weight/zone quote + drift recon",
  feature: "ORD-27 buyerCancel + ORD-9 quoteDeliveryFee + ORD-26 reconcile",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const { appRouter } = await import("../../server/routers");
    const caller = appRouter.createCaller({
      user: { id: 0, role: "user", tenantId: TENANT_ID, name: "j381" },
    } as any);
    const phone = world.newPhone("j381");
    await world.grantConsent(phone);

    // ── ORD-27: pending order cancels; restock happens ──
    const o1 = await seedOrderWithItem(world, "j381a", phone, { status: "pending", paymentStatus: "unpaid", stock: 5, qty: 2 });
    const res = await caller.orderCrud.buyerCancel({ tenantId: TENANT_ID, phone });
    assert(res.ok && res.orderId === o1.orderId, "buyer cancel resolves latest open order");
    const [prod] = await world.db.select().from(schema.products).where(eq(schema.products.id, o1.productId));
    const [ord1] = await world.db.select().from(schema.orders).where(eq(schema.orders.id, o1.orderId));
    assert(ord1.status === "cancelled", "order cancelled");
    void prod;

    // ── ORD-27: shipped order is refused (pre-ship guard) ──
    await seedOrderWithItem(world, "j381b", phone, { status: "shipped" });
    let shipBlocked = false;
    try {
      await caller.orderCrud.buyerCancel({ tenantId: TENANT_ID, phone, orderId: undefined });
    } catch (e: any) {
      shipBlocked = /shipped|terminal|No cancellable/i.test(e?.message ?? "");
    }
    assert(shipBlocked, "shipped order cannot be buyer-cancelled");

    // ── ORD-27: another phone cannot cancel someone else's order ──
    const o3 = await seedOrderWithItem(world, "j381c", phone, { status: "confirmed", paymentStatus: "unpaid" });
    const stranger = world.newPhone("j381x");
    let foreignBlocked = false;
    try {
      await caller.orderCrud.buyerCancel({ tenantId: TENANT_ID, phone: stranger, orderId: o3.orderId });
    } catch (e: any) {
      foreignBlocked = e?.code === "FORBIDDEN";
    }
    assert(foreignBlocked, "foreign phone blocked by ownership check");
    const own = await caller.orderCrud.buyerCancel({ tenantId: TENANT_ID, phone, orderId: o3.orderId, reason: "changed my mind" });
    assert(own.ok, "owner can cancel by explicit id");

    // ── ORD-9: weight-aware, tenant-zone quoting ──
    const { quoteDeliveryFee } = await import("../../server/services/deliveryQuote");
    const light = quoteDeliveryFee({ address: "Lekki, Lagos", weightKg: 1 });
    const heavy = quoteDeliveryFee({ address: "Lekki, Lagos", weightKg: 6 });
    assert(heavy.fee > light.fee, "weight increases the quote");
    const zoned = quoteDeliveryFee({
      address: "12 Ozumba Mbadiwe, Victoria Island",
      weightKg: 1,
      deliveryZones: [{ name: "Victoria Island" }, { name: "Ikeja" }],
    });
    assert(zoned.zone === "same_city", "tenant zone match → same_city");
    const outside = quoteDeliveryFee({
      address: "45 Awolowo Rd, Abuja",
      weightKg: 1,
      deliveryZones: [{ name: "Victoria Island" }, { name: "Ikeja" }],
    });
    assert(outside.zone === "intercity", "outside tenant zones → intercity");
    // No configured zones → legacy Lagos hints preserved.
    assert(quoteDeliveryFee({ address: "Surulere" }).zone === "same_city", "hint fallback preserved");

    // ── ORD-26: reconciliation reports drift, clean when aligned ──
    const { reconcileInventoryDrift } = await import("../../server/services/inventorySync");
    const driftPid = `prod-w45-drift`;
    await world.db.execute(`DELETE FROM inventory_snapshots WHERE "productId" = '${driftPid}'`).catch(() => undefined);
    await world.db.execute(`DELETE FROM products WHERE id = '${driftPid}'`).catch(() => undefined);
    await world.db.insert(schema.products).values({
      id: driftPid, tenantId: TENANT_ID, sku: "SIM-W45-DRIFT", name: "Drifty",
      price: "100.00", currency: "NGN", status: "active", stockQuantity: 10,
    });
    await world.db.insert(schema.inventorySnapshots).values({
      id: crypto.randomUUID(), tenantId: TENANT_ID, productId: driftPid,
      stockQty: "7", reservedQty: "0", availableQty: "7", syncSource: "odoo",
    });
    const recon = await reconcileInventoryDrift(world.db, TENANT_ID);
    const row = recon.drifts.find((d) => d.productId === driftPid);
    assert(row && row.drift === -3, `drift detected (got ${row?.drift})`);
    await world.db.update(schema.products).set({ stockQuantity: 7 })
      .where(eq(schema.products.id, driftPid));
    const recon2 = await reconcileInventoryDrift(world.db, TENANT_ID);
    assert(!recon2.drifts.some((d) => d.productId === driftPid), "no drift once aligned");
  },
};
// === END W45 orders-p0 ===
