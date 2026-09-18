// === W45 orders-p0 (Coder C) ===
/**
 * J378 — ORD-17: goods_receipts per PO line (receivedQty accumulates
 * atomically; over-receipt rejected) + vendor_bills.poId 3-way match: a bill
 * exceeding the received value is REFUSED before payment release
 * (claim-first), a bill within the received value passes.
 */
import { and, eq } from "drizzle-orm";
import { assert, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";
import { seedPoWithItem } from "./w45-orders-seed";

export const journey: Journey = {
  id: "J378",
  name: "goods receipt + 3-way match gates vendor bill payment",
  feature: "ORD-17 goodsReceipts + assertBillWithinReceived",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const { recordGoodsReceipt, assertBillWithinReceived } = await import("../../server/services/goodsReceipts");

    const { poId, poItemId } = await seedPoWithItem(world, "j378", { qty: 4, unitPriceCents: 250_000 });

    // Partial receipt: 3 of 4.
    const r1 = await recordGoodsReceipt(world.db, {
      poId, tenantId: TENANT_ID, lines: [{ poItemId, receivedQty: 3 }], receivedBy: "j378",
    });
    assert(r1.ok && !r1.fullyReceived, "partial receipt recorded");
    let [line] = await world.db.select().from(schema.poItems).where(eq(schema.poItems.id, poItemId));
    assert(line.receivedQty === 3, `received_qty=3 (got ${line.receivedQty})`);
    const receipts = await world.db.select().from(schema.goodsReceipts)
      .where(eq(schema.goodsReceipts.poId, poId));
    assert(receipts.length === 1 && receipts[0]!.receivedQty === 3, "goods_receipts row written");

    // Over-receipt rejected atomically (received_qty unchanged).
    let overRejected = false;
    try {
      await recordGoodsReceipt(world.db, {
        poId, tenantId: TENANT_ID, lines: [{ poItemId, receivedQty: 2 }], receivedBy: "j378",
      });
    } catch (e: any) {
      overRejected = e?.code === "CONFLICT";
    }
    assert(overRejected, "over-receipt rejected");
    [line] = await world.db.select().from(schema.poItems).where(eq(schema.poItems.id, poItemId));
    assert(line.receivedQty === 3, "received_qty unchanged after rejected over-receipt");

    // 3-way match: bill total (4 × 250k) > received value (3 × 250k) → refuse.
    const billId = crypto.randomUUID();
    await world.db.insert(schema.vendorBills).values({
      id: billId,
      tenantId: TENANT_ID,
      vendorName: "W45 Supplier",
      amountCents: 1_000_000,
      currency: "NGN",
      status: "pending",
      poId,
    });
    let matchBlocked = false;
    try {
      await assertBillWithinReceived(world.db, { billId, tenantId: TENANT_ID });
    } catch (e: any) {
      matchBlocked = e?.code === "CONFLICT";
    }
    assert(matchBlocked, "billed > received refused before payment release");

    // Receive the final unit → the match now passes.
    const r2 = await recordGoodsReceipt(world.db, {
      poId, tenantId: TENANT_ID, lines: [{ poItemId, receivedQty: 1 }], receivedBy: "j378",
    });
    assert(r2.fullyReceived, "fully received after final unit");
    const match = await assertBillWithinReceived(world.db, { billId, tenantId: TENANT_ID });
    assert(match.matched && match.receivedValueCents === 1_000_000, "match passes once received");

    // Legacy bill without poId: match is a no-op (pre-W45 path preserved).
    const legacyId = crypto.randomUUID();
    await world.db.insert(schema.vendorBills).values({
      id: legacyId, tenantId: TENANT_ID, vendorName: "Legacy",
      amountCents: 9_999_900, currency: "NGN", status: "pending",
    });
    const legacy = await assertBillWithinReceived(world.db, { billId: legacyId, tenantId: TENANT_ID });
    assert(!legacy.matched, "unlinked bill bypasses the match");

    // Tenant scoping: another tenant cannot receive against this PO.
    let scopeBlocked = false;
    try {
      await recordGoodsReceipt(world.db, {
        poId, tenantId: "sim-other", lines: [{ poItemId, receivedQty: 1 }],
      });
    } catch (e: any) {
      scopeBlocked = e?.code === "FORBIDDEN" || e?.code === "CONFLICT";
    }
    assert(scopeBlocked, "cross-tenant receipt refused");
    void and;
  },
};
// === END W45 orders-p0 ===
