/**
 * === W32 recurring-tiers (Coder B) ===
 * Recurring bills / auto-pay engine (Melio recurring) + CRUD for
 * recurring_rules. Doctrine:
 *  - Claim-before-work: a due rule is claimed by a guarded UPDATE
 *    (status='active' AND next_run_at<=now) before anything is created.
 *  - Crash-safe advancement: the period's vendor_bill / scheduled_payment
 *    row AND the rule's next_run_at advance commit in ONE DB transaction —
 *    a crash can never leave a created payment whose rule still looks due.
 *  - Idempotency: the scheduled_payment carries idempotency key
 *    `recur:<ruleId>:<period>` (period = the due date, YYYY-MM-DD UTC), so a
 *    replayed sweep for the same period is a no-op.
 *  - Auto-pay: amount <= auto_pay_under_cents (and the W31 approvals policy
 *    does not park it) → claimed + executed inline through the W31
 *    scheduledPayments engine (same locked debit, same sched:<id> ledger
 *    reference). Above the threshold (or parked by policy) → an
 *    approval_requests row (kind 'scheduled_payment') is created, the
 *    approver is notified over WhatsApp, and the payment stays honestly
 *    pending until a one-tap approve executes it via the W31 executor map.
 *  - Honest vocab: paused/cancelled rules are never picked up; resuming a
 *    rule whose next_run_at is in the past processes exactly one period per
 *    sweep (the daily cron catches up day by day).
 */
import crypto from "crypto";
import { and, desc, eq, inArray, lte, sql } from "drizzle-orm";
import { approvalRequests, recurringRules, scheduledPayments, vendorBills } from "../../drizzle/schema";

type Db = any;

export const RECURRING_KINDS = ["vendor_bill", "adhoc"] as const;
export const RECURRING_CADENCES = ["weekly", "monthly"] as const;

// ─── Cadence math (pure, exported for tests) ────────────────────────────────

/** Clamp a desired day-of-month into a given UTC month (1-based month). */
function clampedDay(year: number, month1: number, day: number): number {
  const last = new Date(Date.UTC(year, month1, 0)).getUTCDate();
  return Math.min(Math.max(1, day), last);
}

/** One cadence step forward from `from` (weekly: +7d; monthly: next month, clamped). */
export function stepCadence(rule: { cadence: string; dayOfMonth: number | null }, from: Date): Date {
  if (rule.cadence === "weekly") {
    return new Date(from.getTime() + 7 * 24 * 60 * 60 * 1000);
  }
  // monthly
  const day = rule.dayOfMonth ?? from.getUTCDate();
  const y = from.getUTCFullYear();
  const m = from.getUTCMonth(); // 0-based
  const nextMonth = m === 11 ? { y: y + 1, m: 0 } : { y, m: m + 1 };
  const d = clampedDay(nextMonth.y, nextMonth.m + 1, day);
  return new Date(Date.UTC(nextMonth.y, nextMonth.m, d,
    from.getUTCHours(), from.getUTCMinutes(), from.getUTCSeconds()));
}

/**
 * Advance next_run_at after a run: one cadence step from the PREVIOUS
 * next_run_at (phase preserved); if that is still in the past (rule was
 * paused), keep stepping until the next run is in the future — missed
 * periods are skipped honestly, never back-filled in bulk.
 */
export function advanceNextRun(rule: { cadence: string; dayOfMonth: number | null }, prevNextRunAt: Date, now: Date): Date {
  let next = stepCadence(rule, prevNextRunAt);
  let guard = 0;
  while (next.getTime() <= now.getTime() && guard++ < 500) next = stepCadence(rule, next);
  return next;
}

/** First run: the next weekly/monthly boundary at-or-after `from`. */
export function initialNextRun(rule: { cadence: string; dayOfMonth: number | null }, from = new Date()): Date {
  if (rule.cadence === "weekly") return new Date(from.getTime() + 7 * 24 * 60 * 60 * 1000);
  const day = rule.dayOfMonth ?? from.getUTCDate();
  const y = from.getUTCFullYear();
  const m = from.getUTCMonth();
  const thisMonth = new Date(Date.UTC(y, m, clampedDay(y, m + 1, day),
    from.getUTCHours(), from.getUTCMinutes(), from.getUTCSeconds()));
  if (thisMonth.getTime() > from.getTime()) return thisMonth;
  return stepCadence({ cadence: "monthly", dayOfMonth: day }, thisMonth);
}

// ─── CRUD ───────────────────────────────────────────────────────────────────

export interface CreateRuleInput {
  tenantId: string;
  kind: (typeof RECURRING_KINDS)[number];
  recipient?: Record<string, unknown> | null;
  amountCents: number;
  currency?: string;
  cadence: (typeof RECURRING_CADENCES)[number];
  dayOfMonth?: number | null;
  autoPayUnderCents?: number;
  firstRunAt?: Date | null;
  createdBy?: string | null;
}

export async function createRule(db: Db, input: CreateRuleInput) {
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    throw new Error("BAD_REQUEST: amountCents must be a positive integer");
  }
  if (input.kind === "vendor_bill" && !(input.recipient?.name || input.recipient?.vendorName)) {
    throw new Error("BAD_REQUEST: vendor_bill rules require recipient.name");
  }
  const dayOfMonth = input.cadence === "monthly" ? (input.dayOfMonth ?? null) : null;
  if (input.cadence === "monthly" && (dayOfMonth == null || dayOfMonth < 1 || dayOfMonth > 31)) {
    throw new Error("BAD_REQUEST: monthly rules require dayOfMonth 1..31");
  }
  const id = crypto.randomUUID();
  const nextRunAt = input.firstRunAt ?? initialNextRun({ cadence: input.cadence, dayOfMonth });
  const [created] = await db.insert(recurringRules).values({
    id,
    tenantId: input.tenantId,
    kind: input.kind,
    recipient: input.recipient ?? null,
    amountCents: input.amountCents,
    currency: input.currency ?? "NGN",
    cadence: input.cadence,
    dayOfMonth,
    autoPayUnderCents: Math.max(0, input.autoPayUnderCents ?? 0),
    nextRunAt,
    status: "active",
    createdBy: input.createdBy ?? null,
    createdAt: new Date(),
    updatedAt: new Date(),
  }).returning();
  return created;
}

export async function listRules(db: Db, tenantId: string, opts: { status?: string; limit?: number } = {}) {
  const conds = [eq(recurringRules.tenantId, tenantId)];
  if (opts.status) conds.push(eq(recurringRules.status, opts.status));
  return db.select().from(recurringRules).where(and(...conds))
    .orderBy(desc(recurringRules.createdAt))
    .limit(Math.min(opts.limit ?? 100, 200));
}

export async function getRule(db: Db, tenantId: string, id: string) {
  const [row] = await db.select().from(recurringRules)
    .where(and(eq(recurringRules.id, id), eq(recurringRules.tenantId, tenantId)));
  if (!row) throw new Error("NOT_FOUND: recurring rule not found");
  return row;
}

/** Edit amount/cadence/auto-pay threshold/next run of a non-cancelled rule. */
export async function updateRule(db: Db, tenantId: string, id: string, patch: {
  amountCents?: number;
  cadence?: (typeof RECURRING_CADENCES)[number];
  dayOfMonth?: number | null;
  autoPayUnderCents?: number;
  nextRunAt?: Date;
  recipient?: Record<string, unknown> | null;
}) {
  const row = await getRule(db, tenantId, id);
  if (row.status === "cancelled") throw new Error("CONFLICT: cancelled rules cannot be edited");
  if (patch.amountCents !== undefined && (!Number.isInteger(patch.amountCents) || patch.amountCents <= 0)) {
    throw new Error("BAD_REQUEST: amountCents must be a positive integer");
  }
  const [updated] = await db.update(recurringRules).set({
    ...(patch.amountCents !== undefined ? { amountCents: patch.amountCents } : {}),
    ...(patch.cadence !== undefined ? { cadence: patch.cadence } : {}),
    ...(patch.dayOfMonth !== undefined ? { dayOfMonth: patch.dayOfMonth } : {}),
    ...(patch.autoPayUnderCents !== undefined ? { autoPayUnderCents: Math.max(0, patch.autoPayUnderCents) } : {}),
    ...(patch.nextRunAt !== undefined ? { nextRunAt: patch.nextRunAt } : {}),
    ...(patch.recipient !== undefined ? { recipient: patch.recipient } : {}),
    updatedAt: new Date(),
  }).where(and(eq(recurringRules.id, id), eq(recurringRules.tenantId, tenantId),
    sql`${recurringRules.status} IN ('active','paused')`)).returning();
  if (!updated) throw new Error("CONFLICT: rule changed concurrently — reload and retry");
  return updated;
}

/** pause | resume | cancel — honest status transitions, single-consumption. */
export async function setRuleStatus(db: Db, tenantId: string, id: string, action: "pause" | "resume" | "cancel") {
  const from = action === "pause" ? ["active"] : action === "resume" ? ["paused"] : ["active", "paused"];
  const to = action === "pause" ? "paused" : action === "resume" ? "active" : "cancelled";
  const res = await db.update(recurringRules)
    .set({ status: to, updatedAt: new Date() })
    .where(and(eq(recurringRules.id, id), eq(recurringRules.tenantId, tenantId),
      inArray(recurringRules.status, from)))
    .returning({ id: recurringRules.id });
  if (res.length === 1) return { status: to, changed: true };
  const row = await getRule(db, tenantId, id);
  return { status: row.status, changed: false };
}

// ─── Recurring engine (daily cron sweep) ────────────────────────────────────

export interface RecurringSweepSummary {
  claimed: number;
  created: number;
  autoPaid: number;
  insufficientFunds: number;
  pendingApproval: number;
  failed: number;
  skippedDuplicate: number;
}

/** Period key for the idempotency anchor: the due date (YYYY-MM-DD, UTC). */
export function periodKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Create the period's payment + advance the rule in ONE transaction.
 * Returns the scheduled_payment id, or null when the period already exists
 * (replay after a crash — the idempotency key won).
 */
async function createPeriodPaymentTx(db: Db, rule: any, now: Date): Promise<{ paymentId: string | null; nextRunAt: Date }> {
  const period = periodKey(new Date(rule.nextRunAt));
  const idemKey = `recur:${rule.id}:${period}`;
  const paymentId = crypto.randomUUID();
  const nextRunAt = advanceNextRun(rule, new Date(rule.nextRunAt), now);

  await db.transaction(async (tx: any) => {
    // Idempotent insert — the unique index on scheduled_payments.idempotency_key
    // (scheduled_payments_idem_uniq) is the backstop; a replay inserts nothing.
    // NB: timestamps are passed as ISO strings (embedded PG does not serialize
    // Date params in raw SQL).
    const inserted = await tx.execute(sql`
      INSERT INTO scheduled_payments
        (id, tenant_id, kind, target_id, recipient, amount_cents, currency,
         execute_at, status, idempotency_key, attempts, metadata, created_by, created_at, updated_at)
      VALUES (
        ${paymentId}, ${rule.tenantId}, ${rule.kind === "vendor_bill" ? "vendor_bill" : "adhoc"},
        NULL, ${JSON.stringify(rule.recipient ?? null)}::jsonb, ${rule.amountCents}, ${rule.currency},
        ${now.toISOString()}, 'pending', ${idemKey}, 0,
        ${JSON.stringify({ recurringRuleId: rule.id, period, captureSource: "recurring" })}::jsonb,
        ${rule.createdBy ?? null}, now(), now())
      ON CONFLICT (idempotency_key) DO NOTHING
      RETURNING id
    `);
    const createdRow = (inserted as unknown as Record<string, unknown>[])[0];
    if (!createdRow) return; // replay — the rule advance below is idempotent too

    if (rule.kind === "vendor_bill") {
      const billId = crypto.randomUUID();
      const vendorName = String(rule.recipient?.name ?? rule.recipient?.vendorName ?? "Recurring vendor");
      await tx.insert(vendorBills).values({
        id: billId,
        tenantId: rule.tenantId,
        vendorName,
        vendorContact: rule.recipient?.contact ?? (rule.recipient?.phone ? { phone: rule.recipient.phone } : null),
        description: `Recurring ${rule.cadence} bill (rule ${rule.id.slice(0, 8)}, period ${period})`,
        amountCents: rule.amountCents,
        currency: rule.currency,
        issueDate: now,
        dueDate: now,
        status: "pending",
        paidCents: 0,
        captureSource: "recurring", // W32 additive source vocab
        paymentRef: `recurbill:${rule.id}:${period}`,
        createdBy: rule.createdBy ?? null,
        createdAt: now,
        updatedAt: now,
      }).onConflictDoNothing(); // payment_ref unique — replay no-op
      await tx.execute(sql`
        UPDATE scheduled_payments SET target_id = ${billId}, updated_at = now()
        WHERE id = ${paymentId}
      `);
      await tx.execute(sql`
        INSERT INTO vendor_bill_events (id, bill_id, event, actor, metadata, created_at)
        VALUES (${crypto.randomUUID()}, ${billId}, 'created', ${rule.createdBy ?? "recurring-engine"},
          ${JSON.stringify({ source: "recurring", ruleId: rule.id, period })}::jsonb, now())
      `);
    }

    // Advance the rule IN THE SAME COMMIT as the creation (crash-safe).
    const advanced = await tx.update(recurringRules)
      .set({ nextRunAt, lastRunAt: now, updatedAt: now })
      .where(and(eq(recurringRules.id, rule.id), eq(recurringRules.status, "active")))
      .returning({ id: recurringRules.id });
    if (advanced.length !== 1) throw new Error("recurring rule advance lost — rolling back");
  });

  // Re-check whether THIS call created the payment (vs. a replay).
  const [row] = await db.execute(sql`
    SELECT id FROM scheduled_payments WHERE idempotency_key = ${idemKey}
  `) as unknown as [Record<string, unknown>?];
  const created = row && String(row.id) === paymentId;
  return { paymentId: created ? paymentId : null, nextRunAt };
}

/** WhatsApp an approver about a parked recurring payment (best-effort). */
async function notifyApprovalNeeded(db: Db, tenantId: string, amountCents: number, approvalId: string): Promise<void> {
  try {
    const { resolveTenantAdminPhone } = await import("./stepUp");
    const { sendWhatsAppText } = await import("./waSender");
    const phone = await resolveTenantAdminPhone(db, tenantId);
    if (!phone) return;
    await sendWhatsAppText(tenantId, phone,
      `Recurring payment of NGN ${(amountCents / 100).toFixed(2)} is above your auto-pay limit and needs approval. ` +
      `Approve in the dashboard under Approvals (ref ${approvalId.slice(0, 8)}) and it pays immediately.`,
      { notifType: "approval_request" });
  } catch (err) {
    console.error(`[recurring] approval WA notify failed for ${approvalId}:`, (err as Error)?.message);
  }
}

/**
 * One sweep of due recurring rules. Claim → create-period+advance (one tx) →
 * auto-pay inline under the threshold (after the approvals gate) or park for
 * a one-tap WA approval. Exported for /api/scheduled/recurring-run.
 */
export async function runRecurringSweep(db: Db, now: Date = new Date()): Promise<RecurringSweepSummary> {
  const summary: RecurringSweepSummary = {
    claimed: 0, created: 0, autoPaid: 0, insufficientFunds: 0,
    pendingApproval: 0, failed: 0, skippedDuplicate: 0,
  };
  const due = await db.select().from(recurringRules)
    .where(and(eq(recurringRules.status, "active"), lte(recurringRules.nextRunAt, now)))
    .orderBy(recurringRules.nextRunAt)
    .limit(100);

  for (const rule of due) {
    // Claim-before-work: exactly one claimant wins each due rule.
    const won = await db.update(recurringRules)
      .set({ updatedAt: now })
      .where(and(
        eq(recurringRules.id, rule.id),
        eq(recurringRules.status, "active"),
        eq(recurringRules.nextRunAt, rule.nextRunAt),
      ))
      .returning({ id: recurringRules.id });
    if (won.length !== 1) continue;
    summary.claimed++;

    try {
      const { paymentId } = await createPeriodPaymentTx(db, rule, now);
      if (!paymentId) { summary.skippedDuplicate++; continue; }
      summary.created++;

      const sched = await import("./scheduledPayments");
      const underAutoPay = rule.autoPayUnderCents > 0 && rule.amountCents <= rule.autoPayUnderCents;

      // Approvals gate: the W31 tenant policy can park even under-threshold
      // auto-pays; above the rule's threshold we ALWAYS request approval.
      const approvals = await import("./approvals");
      const gate = await approvals.requireApprovalIfNeeded(
        rule.tenantId, "scheduled_payment", rule.amountCents, paymentId, db,
        { requestedBy: rule.createdBy ?? "system", reference: `recur:${rule.id}:${periodKey(new Date(rule.nextRunAt))}` },
      );
      let approvalId: string | null = gate.approvalRequired ? gate.approvalId! : null;

      if (!approvalId && !underAutoPay) {
        // Above the rule's auto-pay threshold → unconditional WA approval
        // request (one-tap approve links into the W31 approvals executor).
        approvalId = crypto.randomUUID();
        await db.insert(approvalRequests).values({
          id: approvalId,
          tenantId: rule.tenantId,
          kind: "scheduled_payment",
          targetId: paymentId,
          amountCents: rule.amountCents,
          requestedBy: rule.createdBy ?? "system",
          approverRole: "owner",
          status: "pending",
          expiresAt: new Date(now.getTime() + 72 * 60 * 60 * 1000),
          metadata: { recurringRuleId: rule.id, period: periodKey(new Date(rule.nextRunAt)) },
          createdAt: now,
        });
      }

      if (approvalId) {
        // Park honestly: the payment stays pending (pushed out of the 5-min
        // tick's immediate reach; the W32 guard in executeClaimedPayment
        // re-parks any tick claim while metadata.approvalId is undecided)
        // until approve re-executes via the W31 executor map.
        const [row] = await db.select().from(scheduledPayments).where(eq(scheduledPayments.id, paymentId));
        const meta = ((row?.metadata ?? {}) as Record<string, unknown>);
        await db.update(scheduledPayments)
          .set({ metadata: { ...meta, approvalId }, executeAt: new Date(now.getTime() + 15 * 60_000), updatedAt: now })
          .where(eq(scheduledPayments.id, paymentId));
        await notifyApprovalNeeded(db, rule.tenantId, rule.amountCents, approvalId);
        summary.pendingApproval++;
        continue;
      }

      // Auto-pay inline through the W31 claim-before-send engine.
      const claimed = await db.update(scheduledPayments)
        .set({ status: "claimed", attempts: sql`${scheduledPayments.attempts} + 1`, updatedAt: now })
        .where(and(eq(scheduledPayments.id, paymentId), eq(scheduledPayments.status, "pending")))
        .returning({ id: scheduledPayments.id });
      if (claimed.length !== 1) { summary.failed++; continue; }
      const res = await sched.executeClaimedPayment(db, paymentId);
      if (res.outcome === "executed" || res.outcome === "duplicate") summary.autoPaid++;
      else if (res.outcome === "insufficient_funds") summary.insufficientFunds++;
      else if (res.outcome === "pending_approval") summary.pendingApproval++;
      else summary.failed++;
    } catch (err) {
      summary.failed++;
      console.error(`[recurring] rule ${rule.id} sweep failed:`, (err as Error)?.message);
    }
  }
  return summary;
}
// === END W32 recurring-tiers ===
