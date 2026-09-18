/**
 * === W46 orders-p2 (Coder G, ORD-19) ===
 * poBreach.ts — PO promised-date bookkeeping + promise-breach sweep.
 *
 * Previously supplierProfiles.leadTimeDays was DISPLAY-ONLY: a buyer had no
 * committed delivery date and no signal when a supplier blew past it
 * (residual-backlog ORD-19: "grep promisedDate → 0").
 *
 * Contract:
 *   1. On approval (poFlow.approvePurchaseOrder — both the credit 'invoiced'
 *      and paynow 'approved' branches) the PO stamps approvedAt = now and
 *      promisedDate = approvedAt + leadTimeDays (snapshotted from the
 *      supplier profile at approval time; default 3 days when the supplier
 *      has no profile row — same default as the directory display).
 *   2. runPoBreachSweep scans unfulfilled POs (approved|invoiced|paid) whose
 *      promisedDate < now() and breachAlertedAt IS NULL, claims each row
 *      claim-first (guarded UPDATE ... WHERE breach_alerted_at IS NULL), and
 *      alerts BOTH sides: the buyer contact (notifyBuyer) and the supplier
 *      admin (notifyTenantAdminPhone). Only the claim WINNER sends — a
 *      concurrent/repeated sweep never double-alerts.
 *   3. The sweep never flips PO status: breach is a notification, not a
 *      lifecycle transition. A PO fulfilled after the promise simply stops
 *      matching the scan (status guard), so a fulfilled-past-promise PO is
 *      never alerted post-hoc.
 *
 * Wired via POST /api/scheduled/po-breach-sweep (W42 cronAuth scope+jti;
 * services/scheduler/scheduler.mjs allowlist, J178 contract).
 */
import { and, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { purchaseOrders } from "../../../drizzle/schema";
import { getSupplierProfile, type DbHandle } from "./directory";
// notifyBuyer/notifyTenantAdminPhone are dynamically imported inside the
// sweep (poFlow imports the compute helpers above — dynamic import keeps the
// cycle one-directional at module-init time).

/** Directory display default when a supplier has no profile row. */
export const DEFAULT_LEAD_TIME_DAYS = 3;

/** promisedDate = approvedAt + leadTimeDays (integer days, ms arithmetic). */
export function computePromisedDate(approvedAt: Date, leadTimeDays: number): Date {
  const days = Number.isFinite(leadTimeDays) && leadTimeDays >= 0 ? Math.floor(leadTimeDays) : DEFAULT_LEAD_TIME_DAYS;
  return new Date(approvedAt.getTime() + days * 24 * 60 * 60 * 1000);
}

/** Resolve the supplier's lead time at approval time (fail-soft default). */
export async function resolveLeadTimeDays(db: DbHandle, supplierTenantId: string): Promise<number> {
  const profile = await getSupplierProfile(db, supplierTenantId).catch(() => null);
  const days = Number((profile as any)?.leadTimeDays);
  return Number.isFinite(days) && days >= 0 ? Math.floor(days) : DEFAULT_LEAD_TIME_DAYS;
}

export interface PoBreachSweepResult {
  scanned: number;
  alerted: number;
  /** PO numbers whose alert was dispatched by THIS run (claim winners). */
  alertedPoNumbers: string[];
  errors: string[];
}

/**
 * Sweep for breached PO promises. Claim-first per row: the guarded UPDATE
 * (breach_alerted_at IS NULL) is the exactly-once gate; only the winner
 * sends the alerts. Safe to run overlapping/repeatedly.
 */
export async function runPoBreachSweep(db: DbHandle, now: Date = new Date()): Promise<PoBreachSweepResult> {
  const result: PoBreachSweepResult = { scanned: 0, alerted: 0, alertedPoNumbers: [], errors: [] };
  const breached = await db
    .select()
    .from(purchaseOrders)
    .where(and(
      inArray(purchaseOrders.status, ["approved", "invoiced", "paid"]),
      isNull(purchaseOrders.breachAlertedAt),
      lt(purchaseOrders.promisedDate, now),
    ))
    .limit(500);
  result.scanned = breached.length;

  for (const po of breached) {
    try {
      // Claim-first: only one concurrent sweep claims the alert.
      const [claimed] = await db.update(purchaseOrders)
        .set({ breachAlertedAt: now, updatedAt: now })
        .where(and(eq(purchaseOrders.id, po.id), isNull(purchaseOrders.breachAlertedAt)))
        .returning({ id: purchaseOrders.id });
      if (!claimed) continue; // lost the race — the winner alerts
      const { notifyBuyer, notifyTenantAdminPhone } = await import("./poFlow");
      const promised = po.promisedDate ? new Date(po.promisedDate) : null;
      const overdueDays = promised
        ? Math.max(1, Math.ceil((now.getTime() - promised.getTime()) / (24 * 60 * 60 * 1000)))
        : null;
      await notifyBuyer(db, po,
        `⚠️ ${po.poNumber} is past its promised delivery date` +
        (promised ? ` (${promised.toDateString()}${overdueDays ? ` — ${overdueDays}d overdue` : ""})` : "") +
        `. The supplier has been notified; reply here if you'd like an update or to cancel.`);
      await notifyTenantAdminPhone(db, po.supplierTenantId,
        `⚠️ Promise breached: ${po.poNumber} was promised by ` +
        (promised ? promised.toDateString() : "an unknown date") +
        ` and is still unfulfilled. Fulfil it or message the buyer today to protect your supplier rating.`);
      result.alerted += 1;
      result.alertedPoNumbers.push(po.poNumber);
    } catch (e: any) {
      result.errors.push(`${po.poNumber}: ${e?.message ?? String(e)}`);
    }
  }
  return result;
}

/** SQL fragment kept for route-level smoke assertions (unused at runtime). */
export const PO_BREACH_SCAN_PREDICATE = sql`promised_date < now() AND breach_alerted_at IS NULL`;
// === END W46 orders-p2 ===
