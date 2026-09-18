/**
 * === W43 exchanges (Coder B): stock-adjustment audit ===
 *
 * recordStockAdjustment — the SINGLE audit-write helper for every stock
 * mutation on the platform (SPEC_W43 Coder B). It writes one append-only
 * stock_adjustments row (migration 0133) and MUST be called with the same
 * db/tx handle that performed the stock mutation, so the audit row and the
 * mutation commit or roll back TOGETHER (an audited mutation can never be
 * lost to a mid-flight failure, and a rolled-back mutation never leaves a
 * phantom audit row).
 *
 * Callers wired by Coder B (paths owned by exchanges/returns/cancel):
 *   - services/inventory.ts     releaseReservations / releaseCommittedReservations (cancel-release)
 *   - services/orderCancel.ts   cancelOrder inventory_snapshots restock leg
 *   - services/rma.ts           receiveAndRestock return-restock leg
 *   - services/exchanges.ts     exchange_in / exchange_out / damage write-off
 *
 * MERGER SEAM — Coder A (w43/fulfillment) owns the fulfill + backorder-fill
 * paths. To audit those mutations, import { recordStockAdjustment } from
 * "./stockAdjustments" and call it inside the SAME transaction as:
 *   - partial-fulfillment stock decrement: reason "other", refType
 *     "fulfillment", refId fulfillmentId (per fulfillment line);
 *   - backorder auto-fill on restock: reason "backorder_fill", refType
 *     "backorder", refId backorderRequestId.
 * The helper takes a generic { insert } handle so any drizzle tx works.
 */
import { stockAdjustments, type StockAdjustmentReason } from "../../drizzle/schema";

/** Minimal handle: anything drizzle-ish that can .insert (db or tx). */
export interface StockAuditHandle {
  insert: (...args: any[]) => any;
}

export interface StockAdjustmentInput {
  tenantId: string;
  productId: string;
  variantId?: string | null;
  /** Signed units: positive = stock in, negative = stock out. Never 0
   *  except for a damage write-off audit (0 = received but not restocked). */
  deltaQty: number;
  reason: StockAdjustmentReason;
  refType?: string | null;
  refId?: string | null;
  actorId?: string | null;
  note?: string | null;
}

/**
 * Append one audit row. Throws on invalid input (fail-closed: a stock
 * mutation that cannot be audited must not commit silently — callers run
 * this inside the mutation txn, so a throw rolls the mutation back too).
 * Returns the inserted row id.
 */
export async function recordStockAdjustment(
  db: StockAuditHandle,
  input: StockAdjustmentInput,
): Promise<string> {
  if (!input.tenantId || !input.productId) {
    throw new Error("recordStockAdjustment: tenantId and productId are required");
  }
  if (!Number.isInteger(input.deltaQty)) {
    throw new Error("recordStockAdjustment: deltaQty must be an integer");
  }
  const rows = await db
    .insert(stockAdjustments)
    .values({
      tenantId: input.tenantId,
      productId: input.productId,
      variantId: input.variantId ?? null,
      deltaQty: input.deltaQty,
      reason: input.reason,
      refType: input.refType ?? null,
      refId: input.refId ?? null,
      actorId: input.actorId ?? null,
      note: input.note ?? null,
    })
    .returning({ id: stockAdjustments.id });
  return rows[0]!.id as string;
}
// === END W43 exchanges ===
