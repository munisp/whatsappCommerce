/**
 * Credit control plane (W13) — enforcement coupling between the trade-credit
 * engine and procurement.
 *
 * Exports consumed by the procurement wave (C3):
 *
 *   suspendOrderAccess({buyerTenantId, supplierTenantId, reason})
 *     Sets suspended=true on the (supplier, buyer) credit account. While
 *     suspended, the buyer must not place new credit-backed orders with that
 *     supplier (procurement checks isOrderAccessSuspended before accepting a
 *     credit PO). Claim-first: re-suspending an already-suspended account is
 *     a no-op (returns changed:false).
 *
 *   isOrderAccessSuspended(buyerTenantId, supplierTenantId) → boolean
 *     Fail-open ONLY for "no account": a pair with no facility has nothing
 *     to suspend, so ordering is unaffected. Any account row with
 *     suspended=true ⇒ true.
 *
 *   settleDrawToSupplier({poId, drawResult})
 *     Marks the purchase_orders row linked to a credit draw as paid-via-credit
 *     (status 'invoiced' → 'paid', claim-first). The write happens here
 *     (not in procurement/poFlow.ts, which the procurement wave owns) but
 *     follows the poFlow status machine exactly — 'paid' is the terminal
 *     settlement state for invoiced credit POs, mirroring
 *     handlePoPaymentConfirmed for the paynow path.
 *
 * Auto-lift: when a repayment brings outstanding to 0 the suspension lifts
 * automatically (see repayment.ts).
 */
import { and, eq } from "drizzle-orm";
import { creditAccounts, purchaseOrders } from "../../../drizzle/schema";
import { getCreditAccountTx, type TxHandle } from "./accounts";
import type { DrawResult } from "./draw";

export interface SuspendArgs {
  buyerTenantId: string;
  supplierTenantId: string;
  reason: string;
}

export async function suspendOrderAccessTx(
  db: TxHandle,
  args: SuspendArgs,
  now: Date = new Date(),
): Promise<{ ok: boolean; changed: boolean; reason?: string }> {
  const account = await getCreditAccountTx(db, args.supplierTenantId, args.buyerTenantId);
  if (!account) return { ok: false, changed: false, reason: "no_account" };
  const [row] = await db
    .update(creditAccounts)
    .set({
      suspended: true,
      suspendedAt: now,
      suspensionReason: args.reason.slice(0, 255),
      updatedAt: now,
    })
    .where(and(eq(creditAccounts.id, account.id), eq(creditAccounts.suspended, false)))
    .returning({ id: creditAccounts.id });
  return { ok: true, changed: !!row };
}

export async function liftOrderAccessTx(
  db: TxHandle,
  args: { buyerTenantId: string; supplierTenantId: string },
  now: Date = new Date(),
): Promise<{ ok: boolean; changed: boolean; reason?: string }> {
  const account = await getCreditAccountTx(db, args.supplierTenantId, args.buyerTenantId);
  if (!account) return { ok: false, changed: false, reason: "no_account" };
  const [row] = await db
    .update(creditAccounts)
    .set({ suspended: false, suspendedAt: null, suspensionReason: null, updatedAt: now })
    .where(and(eq(creditAccounts.id, account.id), eq(creditAccounts.suspended, true)))
    .returning({ id: creditAccounts.id });
  return { ok: true, changed: !!row };
}

export async function isOrderAccessSuspendedTx(
  db: TxHandle,
  buyerTenantId: string,
  supplierTenantId: string,
): Promise<boolean> {
  const account = await getCreditAccountTx(db, supplierTenantId, buyerTenantId);
  if (!account) return false; // no facility ⇒ nothing to suspend
  return account.suspended === true;
}

export interface SettleDrawToSupplierArgs {
  poId: string;
  /** The successful draw result this settlement corresponds to. */
  drawResult: Extract<DrawResult, { ok: true }>;
}
export type SettleDrawResult =
  | { ok: true; action: "paid" | "already_paid" }
  | { ok: false; action: string };

/**
 * Mark the PO linked to a credit draw as paid-via-credit. Claim-first on
 * status='invoiced' so the settlement is exactly-once even under retries;
 * a PO already 'paid' is idempotent-success, any other status fails closed.
 */
export async function settleDrawToSupplierTx(
  db: TxHandle,
  args: SettleDrawToSupplierArgs,
  now: Date = new Date(),
): Promise<SettleDrawResult> {
  if (!args.drawResult?.ok) return { ok: false, action: "no_draw" };
  const [po] = await db.select().from(purchaseOrders).where(eq(purchaseOrders.id, args.poId)).limit(1);
  if (!po) return { ok: false, action: "not_found" };
  if (po.status === "paid") return { ok: true, action: "already_paid" };
  if (po.status !== "invoiced") return { ok: false, action: `wrong_status:${po.status}` };
  const [row] = await db
    .update(purchaseOrders)
    .set({
      status: "paid",
      notes: `Paid via credit draw ${args.drawResult.ledgerId}`,
      updatedAt: now,
    })
    .where(and(eq(purchaseOrders.id, po.id), eq(purchaseOrders.status, "invoiced")))
    .returning({ id: purchaseOrders.id });
  return row ? { ok: true, action: "paid" } : { ok: false, action: "claim_failed" };
}
