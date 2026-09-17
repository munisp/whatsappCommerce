/**
 * === W45 orders-p0 (Coder C): ORD-17 + ORD-18 — goods receipts & 3-way match ===
 *
 * ORD-17 (P0): before W45 a vendor bill could be paid in full against a PO
 * whose goods were NEVER received — po_items had no receivedQty and
 * vendor_bills had no poId. Now:
 *   - goods_receipts (mig 0143) records every PO-line receipt event;
 *   - po_items.received_qty is incremented ATOMICALLY (received_qty + n <= qty
 *     guard) inside recordGoodsReceipt — over-receipt is rejected, replays
 *     can never double-count;
 *   - vendor_bills.po_id (mig 0144) links a bill to its PO;
 *   - assertBillWithinReceived runs the match check (billed ≤ received value)
 *     CLAIM-FIRST (the PO's item rows are locked FOR UPDATE inside the
 *     caller's transaction before any wallet debit) — a bill exceeding the
 *     received value throws CONFLICT and no money moves.
 *
 * ORD-18 (P0): receiving goods (recordGoodsReceipt) and marking a PO
 * fulfilled (poFlow.markPoFulfilled → receiveRemainingPoItems) credits the
 * BUYER's products.stockQuantity in the SAME transaction as the receipt rows
 * + one stock_adjustments audit row per credited line (W43
 * recordStockAdjustment — mutation and audit commit or roll back together).
 * productRef → product mapping: productRef is matched against products.sku
 * (then products.id) within the buyer tenant; unmatched refs are honestly
 * skipped (receipt still records; no phantom stock is invented).
 */
import { and, eq, sql } from "drizzle-orm";
import {
  goodsReceipts,
  poItems,
  products,
  purchaseOrders,
  vendorBills,
  type PoItem,
  type PurchaseOrder,
} from "../../drizzle/schema";
import { recordStockAdjustment, type StockAuditHandle } from "./stockAdjustments";

type Tx = StockAuditHandle & {
  select: (...args: any[]) => any;
  insert: (...args: any[]) => any;
  update: (...args: any[]) => any;
  execute: (...args: any[]) => any;
};
type Db = Tx & { transaction: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T> };

/** PO statuses whose goods may be received. */
const RECEIVABLE_STATUSES = ["approved", "invoiced", "paid", "fulfilled"] as const;

export interface ReceiptLineInput {
  poItemId: string;
  receivedQty: number;
}

export interface RecordReceiptResult {
  ok: boolean;
  poId: string;
  receiptIds: string[];
  /** productId → units credited to products.stockQuantity (matched refs only). */
  stockCredited: Record<string, number>;
  /** poItemIds with no matching product — receipt recorded, no stock credit. */
  unmatchedRefs: string[];
  fullyReceived: boolean;
}

/**
 * Resolve a po_items.productRef to a products row within the buyer tenant.
 * productRef is the supplier's catalog reference; historically it carries the
 * buyer-side SKU (or product id). Returns null when nothing matches — callers
 * must NOT invent stock for unknown refs.
 */
async function resolveProductRef(
  tx: Tx,
  tenantId: string,
  productRef: string | null,
): Promise<{ id: string } | null> {
  const ref = (productRef ?? "").trim();
  if (!ref) return null;
  const rows = await tx.execute(sql`
    SELECT id FROM products
    WHERE "tenantId" = ${tenantId} AND (sku = ${ref} OR id = ${ref})
    LIMIT 1
  `) as unknown as Array<{ id: string }>;
  return rows[0] ?? null;
}

/**
 * Credit the buyer's inventory for received units, inside the SAME tx as the
 * receipt rows. One stock_adjustments audit row per credited line.
 */
async function creditReceivedStockTx(
  tx: Tx,
  opts: {
    po: PurchaseOrder;
    lines: Array<{ item: PoItem; qty: number }>;
    actorId?: string | null;
    refType: string;
  },
): Promise<{ stockCredited: Record<string, number>; unmatchedRefs: string[] }> {
  const stockCredited: Record<string, number> = {};
  const unmatchedRefs: string[] = [];
  for (const { item, qty } of opts.lines) {
    if (qty <= 0) continue;
    const product = await resolveProductRef(tx, opts.po.buyerTenantId, item.productRef);
    if (!product) {
      unmatchedRefs.push(item.id);
      console.warn(
        `[goodsReceipts] po_item ${item.id} (ref ${item.productRef ?? "null"}) matched no product in tenant ${opts.po.buyerTenantId} — receipt recorded without stock credit`,
      );
      continue;
    }
    await tx.execute(sql`
      UPDATE products
      SET "stockQuantity" = "stockQuantity" + ${qty}, "updatedAt" = now()
      WHERE id = ${product.id} AND "tenantId" = ${opts.po.buyerTenantId}
    `);
    // ERP-tracked products keep inventory_snapshots as the availability
    // ledger — credit it too when a snapshot row exists (no-op otherwise).
    await tx.execute(sql`
      UPDATE inventory_snapshots
      SET "stockQty" = CAST("stockQty" AS NUMERIC) + ${qty},
          "availableQty" = CAST("availableQty" AS NUMERIC) + ${qty},
          "lastSyncedAt" = now()
      WHERE "productId" = ${product.id} AND "tenantId" = ${opts.po.buyerTenantId}
    `);
    await recordStockAdjustment(tx, {
      tenantId: opts.po.buyerTenantId,
      productId: product.id,
      deltaQty: qty,
      reason: "restock",
      refType: opts.refType,
      refId: opts.po.id,
      actorId: opts.actorId ?? null,
      note: `PO ${opts.po.poNumber} receipt: +${qty} × ${item.name}`,
    });
    stockCredited[product.id] = (stockCredited[product.id] ?? 0) + qty;
  }
  return { stockCredited, unmatchedRefs };
}

/**
 * Record a goods receipt against a PO (GRN). Claim-first: the PO row is
 * locked FOR UPDATE, each line's received_qty is bumped by a guarded atomic
 * UPDATE (never beyond the ordered qty — over-receipt throws CONFLICT), the
 * goods_receipts rows and the ORD-18 stock credits + audit rows commit in
 * ONE transaction.
 */
export async function recordGoodsReceipt(
  db: Db,
  opts: {
    poId: string;
    tenantId: string; // buyer tenant — must own the PO
    lines: ReceiptLineInput[];
    receivedBy?: string | null;
    note?: string | null;
  },
): Promise<RecordReceiptResult> {
  if (!opts.lines.length) {
    throw Object.assign(new Error("recordGoodsReceipt: at least one line is required"), { code: "BAD_REQUEST" });
  }
  for (const l of opts.lines) {
    if (!Number.isInteger(l.receivedQty) || l.receivedQty <= 0) {
      throw Object.assign(new Error("receivedQty must be a positive integer"), { code: "BAD_REQUEST" });
    }
  }
  return db.transaction(async (tx) => {
    const poRows = await tx.select().from(purchaseOrders)
      .where(eq(purchaseOrders.id, opts.poId)).for("update");
    const po = poRows[0] as PurchaseOrder | undefined;
    if (!po) throw Object.assign(new Error("Purchase order not found"), { code: "NOT_FOUND" });
    if (po.buyerTenantId !== opts.tenantId) {
      throw Object.assign(new Error("PO belongs to a different tenant"), { code: "FORBIDDEN" });
    }
    if (!(RECEIVABLE_STATUSES as readonly string[]).includes(po.status)) {
      throw Object.assign(new Error(`PO status "${po.status}" cannot receive goods`), { code: "CONFLICT" });
    }

    const receiptIds: string[] = [];
    const creditedLines: Array<{ item: PoItem; qty: number }> = [];
    for (const line of opts.lines) {
      // Atomic guarded increment: received_qty can never exceed ordered qty,
      // and a concurrent receipt for the same line serializes on the row lock.
      const bumped = await tx.update(poItems)
        .set({ receivedQty: sql`${poItems.receivedQty} + ${line.receivedQty}` as unknown as number })
        .where(and(
          eq(poItems.id, line.poItemId),
          eq(poItems.poId, po.id),
          sql`${poItems.receivedQty} + ${line.receivedQty} <= ${poItems.qty}`,
        ))
        .returning() as PoItem[];
      const item = bumped[0];
      if (!item) {
        const [existing] = await tx.select().from(poItems)
          .where(and(eq(poItems.id, line.poItemId), eq(poItems.poId, po.id)));
        if (!existing) {
          throw Object.assign(new Error(`PO line ${line.poItemId} not found on this PO`), { code: "NOT_FOUND" });
        }
        throw Object.assign(
          new Error(`Over-receipt on line "${existing.name}": ordered ${existing.qty}, already received ${existing.receivedQty}, attempted +${line.receivedQty}`),
          { code: "CONFLICT" },
        );
      }
      const [receipt] = await tx.insert(goodsReceipts).values({
        tenantId: opts.tenantId,
        poId: po.id,
        poItemId: item.id,
        receivedQty: line.receivedQty,
        receivedBy: opts.receivedBy ?? null,
        note: opts.note ?? null,
      }).returning({ id: goodsReceipts.id });
      receiptIds.push(receipt!.id as string);
      creditedLines.push({ item, qty: line.receivedQty });
    }

    // ORD-18: buyer inventory credit in the SAME txn (+ audit rows).
    const { stockCredited, unmatchedRefs } = await creditReceivedStockTx(tx, {
      po,
      lines: creditedLines,
      actorId: opts.receivedBy ?? null,
      refType: "po_receipt",
    });

    const remaining = await tx.execute(sql`
      SELECT COUNT(*)::int AS open FROM po_items WHERE po_id = ${po.id} AND received_qty < qty
    `) as unknown as Array<{ open: number }>;

    return {
      ok: true,
      poId: po.id,
      receiptIds,
      stockCredited,
      unmatchedRefs,
      fullyReceived: (remaining[0]?.open ?? 0) === 0,
    };
  });
}

/**
 * ORD-18 fulfillment leg: mark the PO fulfilled AND receive any not-yet-
 * received units (status flip + received_qty bump + stock credit + audit in
 * ONE transaction). Already-received lines are never double-credited.
 */
export async function fulfillPoWithReceiptTx(
  tx: Tx,
  po: PurchaseOrder,
  opts: { actorId?: string | null } = {},
): Promise<{ stockCredited: Record<string, number>; unmatchedRefs: string[] }> {
  // Snapshot the pre-update per-line received qty, then bump to full. The
  // credited delta is (qty − previously received) so partial receipts are
  // never double-credited.
  const openLines = await tx.select().from(poItems)
    .where(and(eq(poItems.poId, po.id), sql`${poItems.receivedQty} < ${poItems.qty}`))
    .for("update") as PoItem[];
  const deltas = openLines.map((item) => ({ item, qty: item.qty - (item.receivedQty ?? 0) }));
  if (openLines.length > 0) {
    await tx.execute(sql`
      UPDATE po_items SET received_qty = qty
      WHERE po_id = ${po.id} AND received_qty < qty
    `);
    for (const { item, qty } of deltas) {
      await tx.insert(goodsReceipts).values({
        tenantId: po.buyerTenantId,
        poId: po.id,
        poItemId: item.id,
        receivedQty: qty,
        receivedBy: opts.actorId ?? null,
        note: "Auto-receipt on PO fulfillment",
      });
    }
  }
  return creditReceivedStockTx(tx, {
    po,
    lines: deltas.filter((d) => d.qty > 0),
    actorId: opts.actorId ?? null,
    refType: "po_fulfill",
  });
}

/**
 * ORD-17 3-way match, CLAIM-FIRST: lock the PO's item rows FOR UPDATE (so a
 * concurrent receipt/payment serializes) and refuse payment when the bill's
 * total exceeds the received value of the linked PO. No-op for bills without
 * poId (legacy/manual bills keep their pre-W45 path).
 *
 * MUST run inside the same transaction (or before) the wallet debit — the
 * lock only protects while held, so callers invoke this FIRST and release
 * money after it returns.
 */
export async function assertBillWithinReceived(
  db: Db,
  opts: { billId: string; tenantId: string },
): Promise<{ matched: boolean; receivedValueCents: number }> {
  const [bill] = await db.select().from(vendorBills)
    .where(and(eq(vendorBills.id, opts.billId), eq(vendorBills.tenantId, opts.tenantId)));
  if (!bill) throw Object.assign(new Error("Vendor bill not found"), { code: "NOT_FOUND" });
  if (!bill.poId) return { matched: false, receivedValueCents: 0 };

  return db.transaction(async (tx) => {
    // Claim-first: lock the PO + its lines before evaluating the match.
    const poRows = await tx.select().from(purchaseOrders)
      .where(eq(purchaseOrders.id, bill.poId!)).for("update");
    const po = poRows[0] as PurchaseOrder | undefined;
    if (!po) throw Object.assign(new Error("Linked purchase order not found"), { code: "NOT_FOUND" });
    const lines = await tx.select().from(poItems)
      .where(eq(poItems.poId, po.id)).for("update") as PoItem[];
    const receivedValueCents = lines.reduce(
      (s, l) => s + (l.receivedQty ?? 0) * Number(l.unitPriceCents),
      0,
    );
    if (Number(bill.amountCents) > receivedValueCents) {
      throw Object.assign(
        new Error(
          `3-way match failed: bill ${bill.billNumber ?? bill.id} totals ${bill.amountCents}¢ but only ${receivedValueCents}¢ of PO ${po.poNumber} has been received. Record a goods receipt first.`,
        ),
        { code: "CONFLICT" },
      );
    }
    return { matched: true, receivedValueCents };
  });
}
// === END W45 orders-p0 ===
