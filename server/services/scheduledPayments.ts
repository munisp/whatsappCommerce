/**
 * === W31 scheduled-batch (Coder B) ===
 * Payment scheduling + batch payments engine (Melio-inspired AP fundamentals).
 *
 * Doctrine:
 *  - Claim-before-send: a scheduled payment is claimed by a guarded UPDATE
 *    pending→claimed (exactly one claimant wins) BEFORE any ledger work.
 *  - Never claim money moved before the ledger write commits: the wallet
 *    debit, the wallet_tx ledger row (reference `sched:<id>`) and the
 *    scheduled_payments status flip to 'executed' commit in ONE transaction.
 *  - Honest insufficient_funds: when the wallet cannot cover the debit the
 *    row goes to status 'insufficient_funds' (nothing moves) and the merchant
 *    can top up and call `retry` (resets to pending). No fake success.
 *  - Other failures: status 'failed' + last_error, attempts++ per claim,
 *    exponential backoff re-pick, dead-letter (metadata.deadLetteredAt) after
 *    5 attempts.
 *  - vendor_bill contract: kind='vendor_bill' rows reference Coder A's
 *    vendor_bills table BY ID ONLY. The bill is resolved lazily at execution
 *    time inside try/catch so this branch compiles and runs standalone; when
 *    the table (or row) is absent the wallet payment still executes honestly
 *    and the bill-side bookkeeping is skipped with a logged warning.
 */
import crypto from "crypto";
import { and, desc, eq, gt, lte, sql, type SQL } from "drizzle-orm";
import { getDb } from "../db";
import { merchantWallets, paymentBatches, scheduledPayments, walletTransactions } from "../../drizzle/schema";

export type DbHandle = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type DbOrTx = DbHandle | any;

/** Maximum attempts before a failed payment is dead-lettered. */
export const SCHED_MAX_ATTEMPTS = 5;
/** T-1 reminder window: pending payments due within the next 24h. */
export const REMINDER_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Backoff before a failed payment is picked up again (attempt n → ms). */
export function retryBackoffMs(attempts: number): number {
  // 1min, 2min, 4min, 8min, 16min — deterministic, capped.
  return Math.min(16, 2 ** Math.max(0, attempts - 1)) * 60_000;
}

// ─── Wallet helpers (post-W30 locked-debit pattern, mirrors escrow.ts) ──────

async function getOrCreateWallet(db: DbOrTx, tenantId: string) {
  const [existing] = await db.select().from(merchantWallets).where(eq(merchantWallets.tenantId, tenantId));
  if (existing) return existing;
  const id = crypto.randomUUID();
  await db.insert(merchantWallets).values({
    id, tenantId, currency: "NGN",
    availableBalance: "0", escrowBalance: "0",
    totalEarned: "0", totalWithdrawn: "0",
    custodyMode: "psp", isActive: true,
    createdAt: new Date(), updatedAt: new Date(),
  }).onConflictDoNothing();
  const [created] = await db.select().from(merchantWallets).where(eq(merchantWallets.tenantId, tenantId));
  return created!;
}

/** SQLSTATE 23505 on wallet_tx_wallet_ref_uniq (0053). */
function isWalletRefUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; constraint?: string; message?: string };
  if (e?.code !== "23505") return false;
  const hay = `${e.constraint ?? ""} ${e.message ?? ""}`;
  return hay.includes("wallet_tx_wallet_ref_uniq");
}

export interface SchedExecutionOutcome {
  outcome: "executed" | "insufficient_funds" | "failed" | "duplicate" | "pending_approval";
  walletTxId?: string;
  error?: string;
}

/**
 * Execute one CLAIMED scheduled payment. The conditional wallet debit
 * (UPDATE … WHERE available_balance >= amount), the wallet_tx ledger row
 * (reference `sched:<id>` — unique-index backstop) and the status flip to
 * 'executed' all commit in a single DB transaction, so a status of
 * 'executed' can never be observed without the ledger write.
 */
export async function executeClaimedPayment(db: DbHandle, paymentId: string): Promise<SchedExecutionOutcome> {
  const [row] = await db.select().from(scheduledPayments).where(eq(scheduledPayments.id, paymentId));
  if (!row) return { outcome: "failed", error: "scheduled payment not found" };
  if (row.status === "executed") return { outcome: "duplicate" };
  if (row.status !== "claimed") return { outcome: "failed", error: `cannot execute from status ${row.status}` };

  // ─── W31 merger seam: approval gate for adhoc/payout kinds ──────────────
  // Adhoc payouts above the tenant's approval threshold never move money on
  // the cron tick alone: the row is parked (claimed → pending, +15min) with
  // metadata.approvalId, and the approvals executor re-executes after an
  // owner/operator approves (metadata.approvalExecutedFor set then).
  if (row.kind === "adhoc" || row.kind === "payout") {
    const gateMeta = ((row.metadata ?? {}) as Record<string, unknown>);
    if (!gateMeta.approvalExecutedFor) {
      const approvals = await import("./approvals").catch(() => null);
      const res = await approvals?.requireApprovalIfNeeded?.(
        row.tenantId, "scheduled_payment", row.amountCents, row.id, db,
      );
      if (res?.approvalRequired) {
        await db.update(scheduledPayments)
          .set({
            status: "pending",
            executeAt: new Date(Date.now() + 15 * 60_000),
            metadata: { ...gateMeta, approvalId: res.approvalId },
            updatedAt: new Date(),
          })
          .where(and(eq(scheduledPayments.id, row.id), eq(scheduledPayments.status, "claimed")));
        return { outcome: "pending_approval" };
      }
    }
  }

  const ref = `sched:${row.id}`;
  // Idempotent reconciliation: the ledger row already exists (replay after a
  // crash between commit and status read-back) → flip to executed, no debit.
  const [existingTx] = await db.select({ id: walletTransactions.id }).from(walletTransactions)
    .where(and(eq(walletTransactions.reference, ref), eq(walletTransactions.tenantId, row.tenantId)));
  if (existingTx) {
    await db.update(scheduledPayments).set({ status: "executed", lastError: null, updatedAt: new Date() })
      .where(and(eq(scheduledPayments.id, row.id), eq(scheduledPayments.status, "claimed")));
    await syncVendorBillBestEffort(db, row);
    return { outcome: "duplicate", walletTxId: existingTx.id };
  }

  const amountMajor = row.amountCents / 100;
  const wallet = await getOrCreateWallet(db, row.tenantId);
  const walletTxId = crypto.randomUUID();
  try {
    await db.transaction(async (tx) => {
      // Atomic conditional debit — balance check and debit are one UPDATE, so
      // concurrent executions can never double-spend or go negative.
      const debited = await tx.execute(sql`
        UPDATE merchant_wallets
        SET available_balance = available_balance - ${amountMajor.toFixed(2)}::numeric,
            total_withdrawn = total_withdrawn + ${amountMajor.toFixed(2)}::numeric,
            updated_at = now()
        WHERE id = ${wallet.id}
          AND available_balance >= ${amountMajor.toFixed(2)}::numeric
        RETURNING available_balance
      `);
      const balRow = (debited as unknown as Record<string, unknown>[])[0];
      if (!balRow) throw new SchedInsufficientFundsError();
      const after = parseFloat(String(balRow.available_balance));
      const before = after + amountMajor;
      // wallet_tx_type enum has no vendor-payment value (additive-only schema
      // doctrine); the debit is typed "withdrawal" with the reference
      // `sched:<id>` + metadata labelling it as a scheduled payment.
      await tx.insert(walletTransactions).values({
        id: walletTxId,
        walletId: wallet.id,
        tenantId: row.tenantId,
        type: "withdrawal",
        amount: amountMajor.toFixed(2),
        balanceBefore: before.toFixed(2),
        balanceAfter: after.toFixed(2),
        currency: row.currency,
        description: describePayment(row),
        reference: ref,
        metadata: {
          status: "completed",
          source: "scheduled_payment",
          scheduledPaymentId: row.id,
          kind: row.kind,
          targetId: row.targetId ?? null,
          recipient: row.recipient ?? null,
        },
        createdAt: new Date(),
      });
      // Status flip INSIDE the same commit as the ledger write.
      const flipped = await tx.update(scheduledPayments)
        .set({ status: "executed", lastError: null, updatedAt: new Date() })
        .where(and(eq(scheduledPayments.id, row.id), eq(scheduledPayments.status, "claimed")))
        .returning({ id: scheduledPayments.id });
      if (flipped.length !== 1) throw new Error("scheduled payment status flip lost claim — rolling back");
    });
  } catch (err) {
    if (err instanceof SchedInsufficientFundsError) {
      // Honest state — nothing moved; merchant retries after top-up.
      await db.update(scheduledPayments)
        .set({ status: "insufficient_funds", lastError: "INSUFFICIENT_FUNDS: wallet balance too low at execution time", updatedAt: new Date() })
        .where(and(eq(scheduledPayments.id, row.id), eq(scheduledPayments.status, "claimed")));
      return { outcome: "insufficient_funds" };
    }
    if (isWalletRefUniqueViolation(err)) {
      // A concurrent executor committed the same reference first — replay.
      await db.update(scheduledPayments).set({ status: "executed", lastError: null, updatedAt: new Date() })
        .where(and(eq(scheduledPayments.id, row.id), eq(scheduledPayments.status, "claimed")));
      await syncVendorBillBestEffort(db, row);
      return { outcome: "duplicate" };
    }
    await markFailed(db, row, err instanceof Error ? err.message : String(err));
    return { outcome: "failed", error: err instanceof Error ? err.message : String(err) };
  }
  await syncVendorBillBestEffort(db, row);
  return { outcome: "executed", walletTxId };
}

class SchedInsufficientFundsError extends Error {
  constructor() { super("INSUFFICIENT_FUNDS"); }
}

function describePayment(row: typeof scheduledPayments.$inferSelect): string {
  const label = row.kind === "vendor_bill" ? `vendor bill ${row.targetId ?? ""}`.trim()
    : row.kind === "payout" ? "scheduled payout"
    : "scheduled ad-hoc payment";
  return `Scheduled payment — ${label}`;
}

async function markFailed(db: DbHandle, row: typeof scheduledPayments.$inferSelect, message: string) {
  const attempts = row.attempts; // already incremented at claim time
  const dead = attempts >= SCHED_MAX_ATTEMPTS;
  await db.update(scheduledPayments).set({
    status: "failed",
    lastError: message.slice(0, 500),
    updatedAt: new Date(),
    ...(dead
      ? { metadata: sql`COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify({ deadLetteredAt: new Date().toISOString() })}::jsonb` }
      : {}),
  }).where(and(eq(scheduledPayments.id, row.id), eq(scheduledPayments.status, "claimed")));
  if (dead) console.error(`[scheduled-payments] DEAD-LETTER ${row.id} after ${attempts} attempts: ${message}`);
}

/**
 * vendor_bill contract (Coder A owns the table): on successful execution the
 * referenced bill is flipped to paid by ID. Lazy, fully guarded — when the
 * vendor_bills table does not exist yet (this branch standalone) or the row
 * is missing, the payment itself is unaffected and we log honestly.
 */
async function syncVendorBillBestEffort(db: DbHandle, row: typeof scheduledPayments.$inferSelect): Promise<void> {
  if (row.kind !== "vendor_bill" || !row.targetId) return;
  try {
    await db.execute(sql`
      UPDATE vendor_bills
      SET status = 'paid',
          paid_cents = amount_cents,
          payment_ref = ${`sched:${row.id}`},
          updated_at = now()
      WHERE id = ${row.targetId}
        AND tenant_id = ${row.tenantId}
        AND status IN ('pending','scheduled','approved','overdue','partially_paid')
    `);
  } catch (err) {
    console.warn(`[scheduled-payments] vendor_bill sync skipped for ${row.targetId}: ${(err as Error)?.message}`);
  }
}

// ─── Claim-before-send engine ───────────────────────────────────────────────

/**
 * Claim due payments (pending and execute_at<=now, plus failed rows whose
 * backoff elapsed and which are not dead-lettered) one row at a time via a
 * guarded UPDATE … WHERE status IN (<claimable>) — exactly one claimant wins
 * each row. Returns the claimed rows (freshly re-read).
 */
export async function claimDuePayments(db: DbHandle, now: Date, limit = 50): Promise<Array<typeof scheduledPayments.$inferSelect>> {
  const due = await db.select({ id: scheduledPayments.id, attempts: scheduledPayments.attempts, status: scheduledPayments.status, updatedAt: scheduledPayments.updatedAt })
    .from(scheduledPayments)
    .where(and(
      lte(scheduledPayments.executeAt, now),
      sql`${scheduledPayments.status} IN ('pending','failed')`,
      sql`${scheduledPayments.attempts} < ${SCHED_MAX_ATTEMPTS}`,
    ))
    .orderBy(scheduledPayments.executeAt)
    .limit(limit * 2);
  const claimed: Array<typeof scheduledPayments.$inferSelect> = [];
  for (const cand of due) {
    if (claimed.length >= limit) break;
    // Backoff gate for retries (failed rows only — a merchant-retried
    // insufficient_funds row is fresh 'pending' work, not a backoff case).
    if (cand.status === "failed" && cand.attempts > 0) {
      const nextAt = new Date(cand.updatedAt).getTime() + retryBackoffMs(cand.attempts);
      if (nextAt > now.getTime()) continue;
    }
    const won = await db.update(scheduledPayments)
      .set({ status: "claimed", attempts: sql`${scheduledPayments.attempts} + 1`, updatedAt: now })
      .where(and(
        eq(scheduledPayments.id, cand.id),
        sql`${scheduledPayments.status} IN ('pending','failed')`,
      ))
      .returning();
    if (won.length === 1) claimed.push(won[0]);
  }
  return claimed;
}

export interface TickSummary {
  claimed: number;
  executed: number;
  insufficientFunds: number;
  failed: number;
  remindersSent: number;
}

/** One cron tick: claim due payments → execute each → send T-1 reminders. */
export async function runScheduledPaymentTick(db: DbHandle, now = new Date()): Promise<TickSummary> {
  const claimed = await claimDuePayments(db, now);
  const summary: TickSummary = { claimed: claimed.length, executed: 0, insufficientFunds: 0, failed: 0, remindersSent: 0 };
  for (const row of claimed) {
    const res = await executeClaimedPayment(db, row.id);
    if (res.outcome === "executed" || res.outcome === "duplicate") summary.executed++;
    else if (res.outcome === "insufficient_funds") summary.insufficientFunds++;
    else summary.failed++;
  }
  summary.remindersSent = await sendDueReminders(db, now);
  return summary;
}

// ─── T-1 WhatsApp reminders (metadata.remindedAt dedupe) ───────────────────

/**
 * Send a WhatsApp reminder to the tenant admin for pending payments due
 * within the next 24h. Claim-before-send: the metadata.remindedAt marker is
 * set by a guarded UPDATE FIRST (exactly one sender wins, so a payment is
 * never reminded twice), then the message goes out.
 */
export async function sendDueReminders(db: DbHandle, now = new Date()): Promise<number> {
  const horizon = new Date(now.getTime() + REMINDER_WINDOW_MS);
  const dueSoon = await db.select().from(scheduledPayments)
    .where(and(
      eq(scheduledPayments.status, "pending"),
      gt(scheduledPayments.executeAt, now),
      lte(scheduledPayments.executeAt, horizon),
      sql`COALESCE(${scheduledPayments.metadata}->>'remindedAt', '') = ''`,
    ))
    .limit(50);
  let sent = 0;
  for (const row of dueSoon) {
    const marker = new Date().toISOString();
    const won = await db.update(scheduledPayments)
      .set({ metadata: sql`COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify({ remindedAt: marker })}::jsonb`, updatedAt: new Date() })
      .where(and(
        eq(scheduledPayments.id, row.id),
        eq(scheduledPayments.status, "pending"),
        sql`COALESCE(${scheduledPayments.metadata}->>'remindedAt', '') = ''`,
      ))
      .returning({ id: scheduledPayments.id });
    if (won.length !== 1) continue; // another sender claimed this reminder
    try {
      const { resolveTenantAdminPhone } = await import("./stepUp");
      const { sendWhatsAppText } = await import("./waSender");
      const phone = await resolveTenantAdminPhone(db, row.tenantId);
      if (!phone) { console.warn(`[scheduled-payments] no admin phone for tenant ${row.tenantId} — reminder ${row.id} marked, not sent`); continue; }
      const amount = (row.amountCents / 100).toFixed(2);
      await sendWhatsAppText(row.tenantId, phone,
        `Reminder: your ${describePayment(row)} of ${row.currency} ${amount} is scheduled within the next 24 hours and will be paid automatically from your wallet. Ensure your balance covers it.`,
        { notifType: "scheduled_payment_reminder" });
      sent++;
    } catch (err) {
      // Marker stays set (no double-send); the failure is logged honestly.
      console.error(`[scheduled-payments] reminder send failed for ${row.id}:`, (err as Error)?.message);
    }
  }
  return sent;
}

// ─── Procedure-facing operations ────────────────────────────────────────────

export interface ScheduleInput {
  tenantId: string;
  kind: "vendor_bill" | "payout" | "adhoc";
  targetId?: string | null;
  recipient?: Record<string, unknown> | null;
  amountCents: number;
  currency?: string;
  executeAt: Date;
  idempotencyKey?: string;
  createdBy?: string | null;
}

/** Schedule a future payment. Idempotent on idempotencyKey. */
export async function schedulePayment(db: DbHandle, input: ScheduleInput): Promise<{ payment: typeof scheduledPayments.$inferSelect; duplicate: boolean }> {
  const key = input.idempotencyKey ?? `sched-req:${input.tenantId}:${crypto.randomUUID()}`;
  const [existing] = await db.select().from(scheduledPayments).where(eq(scheduledPayments.idempotencyKey, key));
  if (existing) return { payment: existing, duplicate: true };
  try {
    const [created] = await db.insert(scheduledPayments).values({
      id: crypto.randomUUID(),
      tenantId: input.tenantId,
      kind: input.kind,
      targetId: input.targetId ?? null,
      recipient: input.recipient ?? null,
      amountCents: input.amountCents,
      currency: input.currency ?? "NGN",
      executeAt: input.executeAt,
      status: "pending",
      idempotencyKey: key,
      createdBy: input.createdBy ?? null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }).returning();
    return { payment: created, duplicate: false };
  } catch (err) {
    // Unique-key race → idempotent replay of the winner's row.
    const e = err as { code?: string; constraint?: string; message?: string };
    if (e?.code === "23505" && `${e.constraint ?? ""} ${e.message ?? ""}`.includes("scheduled_payments_idem_uniq")) {
      const [row2] = await db.select().from(scheduledPayments).where(eq(scheduledPayments.idempotencyKey, key));
      if (row2) return { payment: row2, duplicate: true };
    }
    throw err;
  }
}

export async function listPayments(db: DbHandle, tenantId: string, opts: { status?: string; limit?: number } = {}) {
  const conds: SQL[] = [eq(scheduledPayments.tenantId, tenantId)];
  if (opts.status) conds.push(eq(scheduledPayments.status, opts.status));
  return db.select().from(scheduledPayments).where(and(...conds))
    .orderBy(desc(scheduledPayments.executeAt))
    .limit(Math.min(opts.limit ?? 100, 200));
}

/** Cancel a not-yet-executed payment (pending / insufficient_funds / failed). */
export async function cancelPayment(db: DbHandle, tenantId: string, id: string): Promise<{ cancelled: boolean; status: string }> {
  const res = await db.update(scheduledPayments)
    .set({ status: "cancelled", updatedAt: new Date() })
    .where(and(
      eq(scheduledPayments.id, id),
      eq(scheduledPayments.tenantId, tenantId),
      sql`${scheduledPayments.status} IN ('pending','insufficient_funds','failed')`,
    ))
    .returning({ id: scheduledPayments.id });
  if (res.length === 1) return { cancelled: true, status: "cancelled" };
  const [row] = await db.select({ status: scheduledPayments.status }).from(scheduledPayments)
    .where(and(eq(scheduledPayments.id, id), eq(scheduledPayments.tenantId, tenantId)));
  if (!row) throw new Error("NOT_FOUND: scheduled payment not found");
  return { cancelled: false, status: row.status };
}

/**
 * Merchant retry after top-up (or after a transient failure): resets an
 * insufficient_funds / failed (non-dead-lettered) payment to pending with a
 * fresh execute_at = now so the next tick picks it up. Executed / cancelled /
 * dead-lettered rows are refused honestly.
 */
export async function retryPayment(db: DbHandle, tenantId: string, id: string): Promise<{ retried: boolean; status: string; reason?: string }> {
  const [row] = await db.select().from(scheduledPayments)
    .where(and(eq(scheduledPayments.id, id), eq(scheduledPayments.tenantId, tenantId)));
  if (!row) throw new Error("NOT_FOUND: scheduled payment not found");
  if (row.status === "executed") return { retried: false, status: row.status, reason: "already executed — wallet_tx committed" };
  if (row.status === "cancelled") return { retried: false, status: row.status, reason: "cancelled payments cannot be retried" };
  const dead = row.status === "failed" && row.attempts >= SCHED_MAX_ATTEMPTS;
  if (dead) return { retried: false, status: "failed", reason: `dead-lettered after ${SCHED_MAX_ATTEMPTS} attempts` };
  const res = await db.update(scheduledPayments)
    .set({ status: "pending", executeAt: new Date(), lastError: null, updatedAt: new Date() })
    .where(and(
      eq(scheduledPayments.id, id),
      eq(scheduledPayments.tenantId, tenantId),
      sql`${scheduledPayments.status} IN ('insufficient_funds','failed')`,
    ))
    .returning({ id: scheduledPayments.id });
  return res.length === 1
    ? { retried: true, status: "pending" }
    : { retried: false, status: row.status, reason: `cannot retry from status ${row.status}` };
}

// ─── Batch payments ─────────────────────────────────────────────────────────

export interface BatchItem {
  kind: "vendor_bill" | "adhoc" | "payout";
  targetId?: string | null;
  recipient?: Record<string, unknown> | null;
  amountCents: number;
  currency?: string;
}

export interface BatchItemOutcome {
  idx: number;
  scheduledPaymentId: string;
  outcome: "executed" | "insufficient_funds" | "failed";
  error?: string;
}

export interface BatchResult {
  batchId: string;
  duplicate: boolean;
  totalCents: number;
  itemCount: number;
  executedCount: number;
  failedCount: number;
  items: BatchItemOutcome[];
}

export const BATCH_MAX_ITEMS = 50;

/**
 * Pay up to 50 targets under ONE confirmation. Each item is a
 * scheduled_payments row with per-item idempotency key `batch:<batchId>:<idx>`
 * executed independently in its own transaction (partial-failure isolation).
 * Replaying with the same batchId returns the stored summary without
 * re-executing anything.
 */
export async function batchPay(db: DbHandle, input: { tenantId: string; items: BatchItem[]; batchId?: string; createdBy?: string | null }): Promise<BatchResult> {
  if (input.items.length === 0) throw new Error("BAD_REQUEST: batch must contain at least one item");
  if (input.items.length > BATCH_MAX_ITEMS) throw new Error(`BAD_REQUEST: batch limited to ${BATCH_MAX_ITEMS} items (got ${input.items.length})`);
  const batchId = input.batchId ?? crypto.randomUUID();

  // Whole-batch idempotent replay: the summary row is the record of truth.
  const [existingBatch] = await db.select().from(paymentBatches).where(eq(paymentBatches.id, batchId));
  if (existingBatch) {
    const rows = await db.select().from(scheduledPayments)
      .where(sql`${scheduledPayments.idempotencyKey} LIKE ${`batch:${batchId}:%`}`);
    const items: BatchItemOutcome[] = rows
      .map((r) => ({
        idx: parseInt(r.idempotencyKey.split(":").pop() ?? "0", 10),
        scheduledPaymentId: r.id,
        outcome: (r.status === "executed" ? "executed" : r.status === "insufficient_funds" ? "insufficient_funds" : "failed") as BatchItemOutcome["outcome"],
        error: r.lastError ?? undefined,
      }))
      .sort((a, b) => a.idx - b.idx);
    return {
      batchId, duplicate: true,
      totalCents: existingBatch.totalCents, itemCount: existingBatch.itemCount,
      executedCount: existingBatch.executedCount, failedCount: existingBatch.failedCount,
      items,
    };
  }

  const totalCents = input.items.reduce((s, it) => s + it.amountCents, 0);
  const outcomes: BatchItemOutcome[] = [];
  for (let idx = 0; idx < input.items.length; idx++) {
    const it = input.items[idx];
    try {
      const { payment } = await schedulePayment(db, {
        tenantId: input.tenantId,
        kind: it.kind,
        targetId: it.targetId ?? null,
        recipient: it.recipient ?? null,
        amountCents: it.amountCents,
        currency: it.currency ?? "NGN",
        executeAt: new Date(),
        idempotencyKey: `batch:${batchId}:${idx}`,
        createdBy: input.createdBy ?? null,
      });
      if (payment.status === "executed") {
        // Per-item idempotent replay (partial retry of the batch).
        outcomes.push({ idx, scheduledPaymentId: payment.id, outcome: "executed" });
        continue;
      }
      if (payment.status !== "pending") {
        outcomes.push({
          idx, scheduledPaymentId: payment.id,
          outcome: payment.status === "insufficient_funds" ? "insufficient_funds" : "failed",
          error: payment.lastError ?? `replayed in status ${payment.status}`,
        });
        continue;
      }
      // Claim-before-send for THIS item only, then execute in its own tx.
      const claimed = await db.update(scheduledPayments)
        .set({ status: "claimed", attempts: sql`${scheduledPayments.attempts} + 1`, updatedAt: new Date() })
        .where(and(eq(scheduledPayments.id, payment.id), eq(scheduledPayments.status, "pending")))
        .returning({ id: scheduledPayments.id });
      if (claimed.length !== 1) {
        outcomes.push({ idx, scheduledPaymentId: payment.id, outcome: "failed", error: "claim lost" });
        continue;
      }
      const res = await executeClaimedPayment(db, payment.id);
      outcomes.push({
        idx, scheduledPaymentId: payment.id,
        outcome: res.outcome === "executed" || res.outcome === "duplicate" ? "executed" : res.outcome === "insufficient_funds" ? "insufficient_funds" : "failed",
        error: res.error,
      });
    } catch (err) {
      outcomes.push({ idx, scheduledPaymentId: "", outcome: "failed", error: err instanceof Error ? err.message : String(err) });
    }
  }
  const executedCount = outcomes.filter((o) => o.outcome === "executed").length;
  const failedCount = outcomes.length - executedCount;
  await db.insert(paymentBatches).values({
    id: batchId,
    tenantId: input.tenantId,
    totalCents,
    itemCount: input.items.length,
    executedCount,
    failedCount,
    createdBy: input.createdBy ?? null,
    createdAt: new Date(),
  }).onConflictDoNothing();
  return { batchId, duplicate: false, totalCents, itemCount: input.items.length, executedCount, failedCount, items: outcomes };
}

// ─── W31 merger seam: approval executor for kind "scheduled_payment" ───────
// Approving a parked adhoc payout claims the row (only if its approvalId
// matches this approval — single consumption) and marks approvalExecutedFor
// so the gate above lets the normal locked-debit path run. Idempotency stays
// the sched:<id> wallet_tx reference.
import { registerApprovalExecutor } from "./approvals";
registerApprovalExecutor("scheduled_payment", async ({ approval, db }) => {
  const targetId = approval.targetId;
  if (!targetId) return { ok: false, detail: "approval has no scheduled-payment target" };
  // Load-then-guarded-update (drizzle type overloads reject raw sql in .set;
  // a plain object merge is equivalent here since the approvalId was written
  // by the gate and nothing else mutates metadata between claim and execute).
  const [row] = await db.select().from(scheduledPayments).where(eq(scheduledPayments.id, targetId));
  if (!row) return { ok: false, detail: "scheduled payment not found" };
  const meta = ((row.metadata ?? {}) as Record<string, unknown>);
  if (meta.approvalId !== approval.id) return { ok: false, detail: "approval mismatch for scheduled payment" };
  const claimed = await db.update(scheduledPayments)
    .set({
      status: "claimed",
      executeAt: new Date(),
      metadata: { ...meta, approvalExecutedFor: approval.id },
      updatedAt: new Date(),
    })
    .where(and(eq(scheduledPayments.id, targetId), eq(scheduledPayments.status, "pending")))
    .returning({ id: scheduledPayments.id });
  if (claimed.length !== 1) return { ok: false, detail: "scheduled payment not claimable (already executed/cancelled)" };
  const res = await executeClaimedPayment(db as never, targetId);
  return {
    ok: res.outcome === "executed" || res.outcome === "duplicate",
    reference: `sched:${targetId}`,
    detail: res.outcome,
  };
});
