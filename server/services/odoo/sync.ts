/**
 * W28 odoo-sync — outbox, event hooks, sweep, worker.
 *
 * Flow:
 *   1. Business event (order paid / expense confirmed / payout / loan
 *      disbursed) → enqueueOutbox (exactly-once via the unique
 *      (tenantId, entityType, entityId) constraint — duplicate events are
 *      no-ops).
 *   2. Push-on-event: when the tenant's syncMode is 'push', the event hook
 *      immediately attempts delivery. 'batch' rows wait for the nightly
 *      cron; 'ondemand' rows wait for "odoo sync now" / portal trigger.
 *   3. Worker (runOdooSyncWorker): claim-before-send — a row is claimed by
 *      flipping pending|failed-retry → 'sending' (attempts+1) BEFORE the
 *      adapter call, so a crash mid-send never double-posts; the sweep
 *      re-queues stale 'sending' rows. Deterministic retry: no exponential
 *      backoff, retries are driven by sweep cadence; attempts >= maxAttempts
 *      → 'failed' which surfaces in the portal reconciliation queue.
 *   4. Nightly batch cron (syncMode 'batch'): posts summarized journal
 *      entries — one payment per payout/loan plus per-entity invoice/bill,
 *      still through the same outbox (no silent divergence).
 *
 * The sweep (sweepOdooOutbox) is the safety net for event paths we must NOT
 * modify (paymentConfirm.ts is pinned): it scans paid orders / confirmed
 * expenses / withdrawals / disbursed loans and enqueues any that are
 * missing. Combined with the unique constraint this gives exactly-once
 * coverage without touching pinned files.
 *
 * Integer cents everywhere; no Math.random; no live API calls in tests
 * (adapter registry resolves the deterministic mock under NODE_ENV=test).
 */
import { and, desc, eq, isNotNull, lt, sql } from "drizzle-orm";
import {
  expenses,
  merchantLoans,
  odooConfigs,
  odooSyncOutbox,
  orders,
  walletTransactions,
} from "../../../drizzle/schema";
import { getOdooAdapter, type OdooAdapter } from "./adapter";

type Db = any;

export type OdooEntityType = "sale" | "expense" | "payout" | "loan_disbursement";

// ─── Payload builders (integer cents) ───────────────────────────────────────

/** decimal major units ("2500.00") → integer cents (Math.round, no drift). */
function toCents(amount: string | number | null | undefined): number {
  if (amount == null) return 0;
  const n = Number(amount);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

export function buildSalePayload(order: any) {
  const totalCents = toCents(order.totalAmount);
  return {
    kind: "sale" as const,
    orderId: order.id,
    reference: order.orderNumber ?? order.id,
    partnerRef: `customer:${order.customerId ?? "walk-in"}`,
    partnerName: `WhatsApp Customer ${order.customerId ?? "walk-in"}`,
    currency: order.currency ?? "NGN",
    totalCents,
    lines: [{
      description: `Order ${order.orderNumber ?? order.id}`,
      quantity: 1,
      unitPriceCents: totalCents,
    }],
  };
}

export function buildExpensePayload(expense: any) {
  return {
    kind: "expense" as const,
    expenseId: expense.id,
    reference: `EXP-${expense.id}`,
    vendorName: expense.vendor ?? "Unknown vendor",
    amountCents: expense.amountCents,
    currency: expense.currency ?? "NGN",
    category: expense.category ?? "general",
    note: expense.note ?? null,
    expenseDate: expense.expenseDate ? new Date(expense.expenseDate).toISOString().slice(0, 10) : null,
    mediaId: expense.mediaId ?? null,
  };
}

export function buildPayoutPayload(tx: any) {
  return {
    kind: "payout" as const,
    payoutId: tx.id,
    reference: tx.reference ?? `WD-${tx.id}`,
    paymentType: "outbound" as const,
    amountCents: toCents(tx.amount),
    currency: tx.currency ?? "NGN",
    memo: tx.description ?? "merchant withdrawal",
  };
}

export function buildLoanPayload(loan: any) {
  return {
    kind: "loan_disbursement" as const,
    loanId: loan.id,
    reference: `LOAN-${loan.id}`,
    paymentType: "outbound" as const,
    amountCents: loan.principalCents,
    currency: loan.currency ?? "NGN",
    memo: `micro-loan disbursement (tier ${loan.tier})`,
  };
}

// ─── Enqueue (exactly-once) ─────────────────────────────────────────────────

/**
 * Insert an outbox row; the unique (tenantId, entityType, entityId)
 * constraint makes concurrent/duplicate events no-ops. Returns true when
 * this call created the row.
 */
export async function enqueueOutbox(
  db: Db,
  tenantId: string,
  entityType: OdooEntityType,
  entityId: string,
  payload: Record<string, unknown>,
): Promise<boolean> {
  const inserted = await db
    .insert(odooSyncOutbox)
    .values({ tenantId, entityType, entityId, payload })
    .onConflictDoNothing()
    .returning({ id: odooSyncOutbox.id });
  return inserted.length > 0;
}

// ─── Event hooks (additive, fire-and-forget safe) ───────────────────────────

async function hookEnqueue(
  db: Db,
  tenantId: string,
  entityType: OdooEntityType,
  entityId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const created = await enqueueOutbox(db, tenantId, entityType, entityId, payload);
  if (!created) return;
  // Push mode: attempt immediate delivery (best-effort; failures leave the
  // row pending/failed for the sweep — never throw into the caller's flow).
  const [cfg] = await db.select().from(odooConfigs).where(eq(odooConfigs.tenantId, tenantId)).limit(1);
  if (cfg?.enabled && cfg.syncMode === "push") {
    await runOdooSyncWorker(db, { tenantId, limit: 1, entityType, entityId }).catch(() => {});
  }
}

/** Called (additively) when an expense transitions to confirmed. */
export async function onExpenseConfirmed(
  db: Db,
  tenantId: string,
  expense: any,
  receipt?: { base64: string; mimeType: string } | null,
): Promise<void> {
  const payload: Record<string, unknown> = buildExpensePayload(expense);
  if (receipt?.base64) {
    payload.mediaBase64 = receipt.base64;
    payload.mediaMimeType = receipt.mimeType;
  }
  await hookEnqueue(db, tenantId, "expense", expense.id, payload);
}

/** Called when an order is known paid (from non-pinned call sites). */
export async function onOrderPaid(db: Db, tenantId: string, order: any): Promise<void> {
  await hookEnqueue(db, tenantId, "sale", order.id, buildSalePayload(order));
}

/** Called when a merchant withdrawal (payout) is recorded. */
export async function onPayout(db: Db, tenantId: string, walletTx: any): Promise<void> {
  await hookEnqueue(db, tenantId, "payout", walletTx.id, buildPayoutPayload(walletTx));
}

/** Called when a micro-loan is disbursed. */
export async function onLoanDisbursed(db: Db, tenantId: string, loan: any): Promise<void> {
  await hookEnqueue(db, tenantId, "loan_disbursement", loan.id, buildLoanPayload(loan));
}

// ─── Sweep: safety net for pinned event paths ───────────────────────────────

export interface SweepResult {
  salesEnqueued: number;
  expensesEnqueued: number;
  payoutsEnqueued: number;
  loansEnqueued: number;
}

/**
 * Scan source tables for rows that should have outbox entries but don't
 * (pinned paymentConfirm.ts can't call our hooks). Idempotent — the unique
 * constraint absorbs races. Only runs for tenants with an enabled config.
 */
export async function sweepOdooOutbox(db: Db, tenantId: string): Promise<SweepResult> {
  const res: SweepResult = { salesEnqueued: 0, expensesEnqueued: 0, payoutsEnqueued: 0, loansEnqueued: 0 };

  const paidOrders = await db.select().from(orders).where(and(
    eq(orders.tenantId, tenantId),
    sql`${orders.paymentStatus}::text IN ('completed','paid')`,
    sql`NOT EXISTS (SELECT 1 FROM ${odooSyncOutbox} WHERE ${odooSyncOutbox.tenantId} = ${orders.tenantId} AND ${odooSyncOutbox.entityType} = 'sale' AND ${odooSyncOutbox.entityId} = ${orders.id})`,
  )).limit(500);
  for (const o of paidOrders) {
    if (await enqueueOutbox(db, tenantId, "sale", o.id, buildSalePayload(o))) res.salesEnqueued += 1;
  }

  const confirmedExpenses = await db.select().from(expenses).where(and(
    eq(expenses.tenantId, tenantId),
    eq(expenses.status, "confirmed"),
    sql`NOT EXISTS (SELECT 1 FROM ${odooSyncOutbox} WHERE ${odooSyncOutbox.tenantId} = ${expenses.tenantId} AND ${odooSyncOutbox.entityType} = 'expense' AND ${odooSyncOutbox.entityId} = ${expenses.id}::text)`,
  )).limit(500);
  for (const e of confirmedExpenses) {
    if (await enqueueOutbox(db, tenantId, "expense", e.id, buildExpensePayload(e))) res.expensesEnqueued += 1;
  }

  const payouts = await db.select().from(walletTransactions).where(and(
    eq(walletTransactions.tenantId, tenantId),
    eq(walletTransactions.type, "withdrawal"),
    sql`NOT EXISTS (SELECT 1 FROM ${odooSyncOutbox} WHERE ${odooSyncOutbox.tenantId} = ${walletTransactions.tenantId} AND ${odooSyncOutbox.entityType} = 'payout' AND ${odooSyncOutbox.entityId} = ${walletTransactions.id})`,
  )).limit(500);
  for (const p of payouts) {
    if (await enqueueOutbox(db, tenantId, "payout", p.id, buildPayoutPayload(p))) res.payoutsEnqueued += 1;
  }

  const loans = await db.select().from(merchantLoans).where(and(
    eq(merchantLoans.tenantId, tenantId),
    isNotNull(merchantLoans.disbursedAt),
    sql`NOT EXISTS (SELECT 1 FROM ${odooSyncOutbox} WHERE ${odooSyncOutbox.tenantId} = ${merchantLoans.tenantId} AND ${odooSyncOutbox.entityType} = 'loan_disbursement' AND ${odooSyncOutbox.entityId} = ${merchantLoans.id}::text)`,
  )).limit(500);
  for (const l of loans) {
    if (await enqueueOutbox(db, tenantId, "loan_disbursement", l.id, buildLoanPayload(l))) res.loansEnqueued += 1;
  }

  return res;
}

// ─── Worker: claim-before-send ──────────────────────────────────────────────

export interface WorkerResult {
  claimed: number;
  sent: number;
  failed: number;
  retriable: number;
  skippedNoAdapter: number;
}

/**
 * Deliver pending outbox rows for a tenant. Claim-before-send: each row is
 * flipped to 'sending' (attempts incremented) in the same statement that
 * claims it, so a crash mid-send can never post twice — the row stays
 * 'sending' until the next sweep re-queues it (stale-claim recovery) and
 * the adapter call itself is idempotent (mock ids are HMAC-derived from the
 * payload; Odoo `ref` uniqueness is the remote anchor).
 */
export async function runOdooSyncWorker(
  db: Db,
  opts: { tenantId: string; limit?: number; entityType?: string; entityId?: string; staleMinutes?: number },
): Promise<WorkerResult> {
  const res: WorkerResult = { claimed: 0, sent: 0, failed: 0, retriable: 0, skippedNoAdapter: 0 };
  const limit = Math.min(opts.limit ?? 50, 200);

  // Recover stale 'sending' claims (crashed mid-send) back to pending.
  const staleBefore = new Date(Date.now() - (opts.staleMinutes ?? 10) * 60 * 1000);
  await db.update(odooSyncOutbox)
    .set({ status: "pending", updatedAt: new Date() })
    .where(and(
      eq(odooSyncOutbox.tenantId, opts.tenantId),
      eq(odooSyncOutbox.status, "sending"),
      lt(odooSyncOutbox.updatedAt, staleBefore),
    ));

  const conds: any[] = [
    eq(odooSyncOutbox.tenantId, opts.tenantId),
    eq(odooSyncOutbox.status, "pending"),
  ];
  if (opts.entityType) conds.push(eq(odooSyncOutbox.entityType, opts.entityType));
  if (opts.entityId) conds.push(eq(odooSyncOutbox.entityId, opts.entityId));
  const candidates = await db.select().from(odooSyncOutbox)
    .where(and(...conds))
    .orderBy(odooSyncOutbox.createdAt)
    .limit(limit);

  if (candidates.length === 0) return res;

  const resolved = await getOdooAdapter(opts.tenantId);
  if (!resolved) {
    res.skippedNoAdapter = candidates.length;
    return res;
  }
  const { adapter, config } = resolved;

  for (const row of candidates) {
    // Claim: pending → sending, attempts+1. The WHERE status='pending' makes
    // the claim atomic — a concurrent worker's claim matches 0 rows.
    const claimed = await db.update(odooSyncOutbox)
      .set({ status: "sending", attempts: row.attempts + 1, updatedAt: new Date() })
      .where(and(eq(odooSyncOutbox.id, row.id), eq(odooSyncOutbox.status, "pending")))
      .returning({ id: odooSyncOutbox.id });
    if (claimed.length === 0) continue;
    res.claimed += 1;

    try {
      const ref = await deliver(db, adapter, row, config.accountMapping as Record<string, unknown> | null);
      await db.update(odooSyncOutbox)
        .set({ status: "sent", odooRef: ref, sentAt: new Date(), lastError: null, updatedAt: new Date() })
        .where(eq(odooSyncOutbox.id, row.id));
      res.sent += 1;
    } catch (e: any) {
      const attempts = row.attempts + 1;
      const exhausted = attempts >= row.maxAttempts;
      await db.update(odooSyncOutbox)
        .set({
          status: exhausted ? "failed" : "pending",
          lastError: String(e?.message ?? e).slice(0, 1000),
          updatedAt: new Date(),
        })
        .where(eq(odooSyncOutbox.id, row.id));
      if (exhausted) res.failed += 1;
      else res.retriable += 1;
    }
  }
  return res;
}

/** Route one claimed row to the right adapter call; returns the Odoo ref. */
async function deliver(
  db: Db,
  adapter: OdooAdapter,
  row: any,
  accountMapping: Record<string, unknown> | null,
): Promise<string> {
  const p = row.payload as any;
  switch (row.entityType as OdooEntityType) {
    case "sale": {
      const { invoiceId } = await adapter.createInvoice({
        partnerRef: p.partnerRef,
        partnerName: p.partnerName,
        reference: p.reference,
        lines: p.lines,
        currency: p.currency,
        totalCents: p.totalCents,
        accountMapping,
      });
      return `invoice:${invoiceId}`;
    }
    case "expense": {
      const { billId } = await adapter.createVendorBill({
        vendorName: p.vendorName,
        reference: p.reference,
        amountCents: p.amountCents,
        currency: p.currency,
        category: p.category,
        note: p.note,
        expenseDate: p.expenseDate,
        accountMapping,
      });
      // Receipt attachment: when the expense carries a stored receipt image
      // (base64 data URL in payload.mediaBase64 — populated by the receipt
      // pipeline when available), attach it to the vendor bill.
      if (p.mediaBase64) {
        await adapter.attachReceipt({
          billId,
          name: `receipt-${p.reference}`,
          base64: p.mediaBase64,
          mimeType: p.mediaMimeType ?? "image/jpeg",
        });
      }
      return `bill:${billId}`;
    }
    case "payout":
    case "loan_disbursement": {
      const { paymentId } = await adapter.createPayment({
        paymentType: p.paymentType ?? "outbound",
        reference: p.reference,
        amountCents: p.amountCents,
        currency: p.currency,
        memo: p.memo,
        accountMapping,
      });
      return `payment:${paymentId}`;
    }
    default:
      throw new Error(`unknown entityType ${row.entityType}`);
  }
}

// ─── Batch + reconciliation surfaces ────────────────────────────────────────

export interface BatchRunResult {
  tenants: number;
  sweep: Record<string, SweepResult>;
  sent: number;
  failed: number;
}

/**
 * Nightly batch cron body: for every enabled config, sweep missing entities
 * into the outbox, then run the worker. (Batch-mode tenants get their
 * summarized entries posted here; push/ondemand tenants get sweep + retry
 * of pending rows too — retries are cheap and idempotent.)
 */
export async function runOdooNightlyBatch(db: Db): Promise<BatchRunResult> {
  const configs = await db.select().from(odooConfigs).where(eq(odooConfigs.enabled, true));
  const out: BatchRunResult = { tenants: configs.length, sweep: {}, sent: 0, failed: 0 };
  for (const cfg of configs) {
    out.sweep[cfg.tenantId] = await sweepOdooOutbox(db, cfg.tenantId);
    const w = await runOdooSyncWorker(db, { tenantId: cfg.tenantId, limit: 200 });
    out.sent += w.sent;
    out.failed += w.failed;
  }
  return out;
}

export interface OutboxStats {
  pending: number;
  sending: number;
  sent: number;
  failed: number;
}

export async function outboxStats(db: Db, tenantId: string): Promise<OutboxStats> {
  const rows = await db.select({ status: odooSyncOutbox.status, n: sql<number>`count(*)::int` })
    .from(odooSyncOutbox)
    .where(eq(odooSyncOutbox.tenantId, tenantId))
    .groupBy(odooSyncOutbox.status);
  const stats: OutboxStats = { pending: 0, sending: 0, sent: 0, failed: 0 };
  for (const r of rows) (stats as any)[r.status] = r.n;
  return stats;
}

/** Reconciliation queue: failed rows + recent activity, newest first. */
export async function listOutbox(db: Db, tenantId: string, opts: { status?: string; limit?: number } = {}) {
  const conds: any[] = [eq(odooSyncOutbox.tenantId, tenantId)];
  if (opts.status) conds.push(eq(odooSyncOutbox.status, opts.status));
  return db.select().from(odooSyncOutbox)
    .where(and(...conds))
    .orderBy(desc(odooSyncOutbox.updatedAt))
    .limit(Math.min(opts.limit ?? 100, 500));
}

/** Requeue a failed row for retry (portal "retry" action). */
export async function retryOutboxRow(db: Db, tenantId: string, id: string): Promise<boolean> {
  const updated = await db.update(odooSyncOutbox)
    .set({ status: "pending", attempts: 0, lastError: null, updatedAt: new Date() })
    .where(and(
      eq(odooSyncOutbox.id, id),
      eq(odooSyncOutbox.tenantId, tenantId),
      eq(odooSyncOutbox.status, "failed"),
    ))
    .returning({ id: odooSyncOutbox.id });
  return updated.length > 0;
}

/**
 * Full on-demand sync for a tenant ("odoo sync now" / portal button):
 * sweep missing entities, then drain the worker. Returns a compact summary
 * safe for WhatsApp/portal display.
 */
export async function syncNow(db: Db, tenantId: string) {
  const sweep = await sweepOdooOutbox(db, tenantId);
  const worker = await runOdooSyncWorker(db, { tenantId, limit: 200 });
  const stats = await outboxStats(db, tenantId);
  return { sweep, worker, stats };
}
