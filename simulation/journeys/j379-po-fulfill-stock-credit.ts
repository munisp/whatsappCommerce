// === W45 orders-p0 (Coder C) ===
/**
 * J379 — ORD-18: markPoFulfilled maps productRef → product and credits the
 * buyer's products.stockQuantity in the SAME transaction as the status flip,
 * with one stock_adjustments audit row per credited line. Already-received
 * units are never double-credited; unmatched refs are honestly skipped.
 */
import { eq } from "drizzle-orm";
import { assert, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";
import { seedPoWithItem } from "./w45-orders-seed";

export const journey: Journey = {
  id: "J379",
  name: "PO fulfillment credits buyer stock + audit, exactly once",
  feature: "ORD-18 markPoFulfilled → stockQuantity + stock_adjustments",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const { markPoFulfilled } = await import("../../server/services/procurement/poFlow");
    const { recordGoodsReceipt } = await import("../../server/services/goodsReceipts");

    // ── Full fulfill credits all 4 units ──
    const { poId, productId } = await seedPoWithItem(world, "j379a", { qty: 4 });
    const before = (await world.db.select().from(schema.products)
      .where(eq(schema.products.id, productId)))[0]!;
    assert(before.stockQuantity === 1, "seed stock 1");

    const r = await markPoFulfilled(world.db as any, { poId });
    assert(r.ok, "fulfill ok");
    const after = (await world.db.select().from(schema.products)
      .where(eq(schema.products.id, productId)))[0]!;
    assert(after.stockQuantity === 5, `stock credited +4 (got ${after.stockQuantity})`);
    const [po] = await world.db.select().from(schema.purchaseOrders)
      .where(eq(schema.purchaseOrders.id, poId));
    assert(po.status === "fulfilled", "po fulfilled");
    const audit = await world.db.select().from(schema.stockAdjustments)
      .where(eq(schema.stockAdjustments.refId, poId));
    assert(audit.length === 1 && audit[0]!.deltaQty === 4 && audit[0]!.refType === "po_fulfill",
      `one fulfill audit row (+4) — got ${audit.length}`);
    const [line] = await world.db.select().from(schema.poItems)
      .where(eq(schema.poItems.poId, poId));
    assert(line.receivedQty === 4, "fulfill marks lines fully received");

    // Replay is rejected by the status guard — no double credit.
    const replay = await markPoFulfilled(world.db as any, { poId });
    assert(!replay.ok && replay.reason === "wrong_status", "fulfill replay rejected");
    const afterReplay = (await world.db.select().from(schema.products)
      .where(eq(schema.products.id, productId)))[0]!;
    assert(afterReplay.stockQuantity === 5, "no double stock credit on replay");

    // ── Partial receipt first, then fulfill credits only the remainder ──
    const p2 = await seedPoWithItem(world, "j379b", { qty: 5 });
    await recordGoodsReceipt(world.db, {
      poId: p2.poId, tenantId: TENANT_ID,
      lines: [{ poItemId: p2.poItemId, receivedQty: 2 }], receivedBy: "j379",
    });
    const mid = (await world.db.select().from(schema.products)
      .where(eq(schema.products.id, p2.productId)))[0]!;
    assert(mid.stockQuantity === 3, `receipt credited +2 (got ${mid.stockQuantity})`);
    const r2 = await markPoFulfilled(world.db as any, { poId: p2.poId });
    assert(r2.ok, "fulfill after partial receipt ok");
    const fin = (await world.db.select().from(schema.products)
      .where(eq(schema.products.id, p2.productId)))[0]!;
    assert(fin.stockQuantity === 6, `fulfill credits only remaining +3 (got ${fin.stockQuantity})`);

    // ── Unmatched productRef: fulfill succeeds, no phantom stock ──
    const p3 = await seedPoWithItem(world, "j379c", { qty: 2, productRef: "NO-SUCH-SKU" });
    const r3 = await markPoFulfilled(world.db as any, { poId: p3.poId });
    assert(r3.ok, "fulfill with unmatched ref still succeeds");
    const audit3 = await world.db.select().from(schema.stockAdjustments)
      .where(eq(schema.stockAdjustments.refId, p3.poId));
    assert(audit3.length === 0, "no audit rows for unmatched refs");
  },
};
// === END W45 orders-p0 ===
