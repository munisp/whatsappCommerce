// === W56 credit ===
/**
 * creditServicing.ts — mid-flight credit servicing admin workflows (Feature 3).
 *
 * Closes the servicing gap: `credit_accounts.fee_bps` was snapshotted at
 * approval (tradeCredit/terms.ts) and installment schedules were immutable.
 * This module adds three ADJUSTMENT workflows — none of them ever rewrites a
 * settled/posted money row:
 *
 *   adjustFeeBps(db, { accountId, newFeeBps, reason, ... })
 *     Re-points the facility fee for UNBILLED/future fee accruals only. The
 *     credit_ledger is append-only: existing draw/fee/repayment rows are
 *     never touched. Audit = credit_ledger 'adjustment' note row (zero
 *     amount, JSON payload) + writeAuditLog entry. Buyer is notified via
 *     channelParity (WA/TG parity, fail-open, localized ×8 via t27).
 *
 *   rescheduleInstallments(db, { planId, graceDays | newSchedule, reason, ... })
 *     For ACTIVE installment_plans: recomputes the future UNPAID slices.
 *     Invariants: Σ principal of the replacement slices === Σ principal of
 *     the replaced unpaid slices (integer cents, remainder rides the last
 *     slice — never a rounding loss), fee delta is explicit in the result
 *     and the audit trail, paid slices are byte-preserved. Prior schedule
 *     is preserved in the audit-log `before` payload and each replacement
 *     entry is stamped `rescheduled: true` (+ previous dueAt/amount).
 *
 *   gracePeriod(db, { accountId, days, reason, actionRef, ... })
 *     Extends due_date on OPEN (kind='invoice_draw', status='posted')
 *     credit_ledger draws by `days` — rows are never voided. Claim-first
 *     per-row marker ` [grace:<actionRef>]` makes a retry of the SAME
 *     action idempotent (a second call with the same actionRef extends
 *     nothing). Dunning (tradeCredit/dunning.ts) reads due_date LIVE from
 *     the ledger on every sweep — no cache — so extended dates are
 *     respected automatically (verified by J577).
 *
 * Money/authz guards live in the ROUTER (moneyProcedure + assertTenantAccess
 * + supplier-ownership check + W31 approvals threshold gate for large
 * reschedules, kind "credit_servicing"). The service itself is tx-safe and
 * never throws on notification (fail-open).
 */
import { and, eq, isNotNull, sql } from "drizzle-orm";
import {
  creditAccounts,
  creditLedger,
  installmentPlans,
  tenants,
} from "../../drizzle/schema";
import type { TxHandle } from "./tradeCredit/accounts";
import { writeAuditLog } from "../routers/audit";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Grace-period bounds: at least one day, at most one quarter. */
export const GRACE_MIN_DAYS = 1;
export const GRACE_MAX_DAYS = 90;
/** fee_bps ceiling (100%). Mirrors manufacturerPrograms' 0..10_000 guard. */
export const MAX_FEE_BPS = 10_000;

export class ServicingError extends Error {
  code: "NOT_FOUND" | "BAD_REQUEST" | "CONFLICT";
  constructor(code: ServicingError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

// ─── Shared bits ────────────────────────────────────────────────────────────

function assertReason(reason: string): void {
  if (typeof reason !== "string" || !reason.trim() || reason.length > 255) {
    throw new ServicingError("BAD_REQUEST", "A non-empty reason (≤255 chars) is required for every servicing action");
  }
}

function adminPhoneFromSettings(settings: unknown): string | null {
  const s = settings as any;
  const cand = s?.adminPhone ?? s?.whatsapp?.adminPhone ?? s?.notifications?.adminPhone;
  return typeof cand === "string" && cand.trim() ? cand.trim() : null;
}

/**
 * Buyer-facing servicing notice: localized (tenant locale, ×8 catalog with
 * en fallback) and routed through channelParity — telegram-linked admins get
 * the TG path, everyone else the original WA path. FAIL-OPEN: returns the
 * channel attempted; never throws into the money path.
 */
export async function notifyBuyerServicing(
  db: TxHandle,
  buyerTenantId: string,
  text: string,
): Promise<{ notified: boolean; channel: "whatsapp" | "telegram" | null }> {
  try {
    const [t] = await db
      .select({ settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, buyerTenantId))
      .limit(1)
      .catch(() => [] as any[]);
    const phone = adminPhoneFromSettings(t?.settings);
    if (!phone) {
      console.info(`[creditServicing] no admin phone for buyer tenant ${buyerTenantId} — notice skipped`);
      return { notified: false, channel: null };
    }
    const { sendCustomerText } = await import("./channelParity");
    const res = await sendCustomerText(buyerTenantId, phone, "credit_servicing", text, {
      notifType: "credit_servicing",
    });
    return { notified: true, channel: res.channel };
  } catch (err: any) {
    console.warn("[creditServicing] buyer notify failed (fail-open):", err?.message);
    return { notified: false, channel: null };
  }
}

/** Localized servicing text for the buyer tenant's admin. Fail-open → en. */
export async function servicingText(
  db: TxHandle,
  buyerTenantId: string,
  key: "creditFeeAdjusted" | "creditRescheduled" | "creditGraceExtended",
  vars: Record<string, string | number>,
): Promise<string> {
  const { t27, resolveLocale } = await import("./i18n");
  const locale = await resolveLocale({ tenantId: buyerTenantId, phone: "" }).catch(() => "en" as const);
  return t27(locale, key, vars);
}

// ─── 1. adjustFeeBps ────────────────────────────────────────────────────────

export interface AdjustFeeResult {
  ok: true;
  accountId: string;
  oldFeeBps: number | null;
  newFeeBps: number;
  /** true ⇒ account already carried newFeeBps — idempotent no-op, no ledger/audit row. */
  unchanged: boolean;
  ledgerNoteId?: string;
  notified: boolean;
}

/**
 * Re-point the facility fee. FUTURE-ONLY: updates credit_accounts.fee_bps
 * (read at draw/accrual time); existing credit_ledger rows — posted, settled
 * or otherwise — are NEVER modified. Claim-first: the UPDATE is guarded on
 * status<>'closed' and IS DISTINCT FROM the new value, so a concurrent or
 * repeated call resolves to exactly one effective change.
 */
export async function adjustFeeBps(
  db: TxHandle,
  args: { accountId: string; newFeeBps: number; reason: string; actorId: string; now?: Date },
): Promise<AdjustFeeResult> {
  const now = args.now ?? new Date();
  assertReason(args.reason);
  if (!Number.isInteger(args.newFeeBps) || args.newFeeBps < 0 || args.newFeeBps > MAX_FEE_BPS) {
    throw new ServicingError("BAD_REQUEST", `newFeeBps must be an integer in 0..${MAX_FEE_BPS}`);
  }

  const outcome = await db.transaction(async (tx) => {
    const [account] = await tx
      .select()
      .from(creditAccounts)
      .where(eq(creditAccounts.id, args.accountId))
      .limit(1)
      .for("update");
    if (!account) throw new ServicingError("NOT_FOUND", `credit account ${args.accountId} not found`);
    if (account.status === "closed") {
      throw new ServicingError("BAD_REQUEST", "cannot adjust the fee of a closed credit account");
    }
    const oldFeeBps = account.feeBps ?? null;
    if (oldFeeBps === args.newFeeBps) {
      return { account, oldFeeBps, unchanged: true as const, ledgerNoteId: undefined as string | undefined };
    }
    // Claim-first guarded update (row is locked by the tx; the guard keeps
    // the semantics honest if the locking read is ever relaxed).
    const [updated] = await tx
      .update(creditAccounts)
      .set({ feeBps: args.newFeeBps, updatedAt: now })
      .where(
        and(
          eq(creditAccounts.id, account.id),
          sql`${creditAccounts.status} <> 'closed'`,
          sql`${creditAccounts.feeBps} IS DISTINCT FROM ${args.newFeeBps}`,
        ),
      )
      .returning({ id: creditAccounts.id });
    if (!updated) {
      throw new ServicingError("CONFLICT", "fee changed concurrently — retry");
    }
    // Append-only ledger 'adjustment' note (zero amount — direction-neutral).
    const notePayload = {
      type: "fee_bps_adjust",
      oldFeeBps,
      newFeeBps: args.newFeeBps,
      reason: args.reason.trim(),
      actorId: args.actorId,
      at: now.toISOString(),
      appliesTo: "future_accruals_only",
    };
    const [noteRow] = await tx
      .insert(creditLedger)
      .values({
        creditAccountId: account.id,
        kind: "adjustment",
        amountCents: 0,
        status: "posted",
        ref: `feeadj:${account.id}:${now.getTime()}`,
        note: `[svc:fee] ${JSON.stringify(notePayload)}`,
      })
      .returning({ id: creditLedger.id });
    return { account, oldFeeBps, unchanged: false as const, ledgerNoteId: noteRow?.id };
  });

  if (!outcome.unchanged) {
    await writeAuditLog({
      actorId: args.actorId,
      actorRole: "user",
      action: "credit.fee_bps_adjusted",
      entityType: "credit_account",
      entityId: args.accountId,
      tenantId: outcome.account.supplierTenantId,
      summary: `Facility fee ${outcome.oldFeeBps ?? "none"} → ${args.newFeeBps} bps (future accruals only): ${args.reason.trim()}`,
      before: { feeBps: outcome.oldFeeBps },
      after: { feeBps: args.newFeeBps, reason: args.reason.trim(), ledgerNoteId: outcome.ledgerNoteId },
    }).catch(() => {});
  }

  const text = await servicingText(db, outcome.account.buyerTenantId, "creditFeeAdjusted", {
    oldBps: outcome.oldFeeBps ?? 0,
    newBps: args.newFeeBps,
    reason: args.reason.trim(),
  });
  const notice = await notifyBuyerServicing(db, outcome.account.buyerTenantId, text);

  return {
    ok: true,
    accountId: args.accountId,
    oldFeeBps: outcome.oldFeeBps,
    newFeeBps: args.newFeeBps,
    unchanged: outcome.unchanged,
    ledgerNoteId: outcome.ledgerNoteId,
    notified: notice.notified,
  };
}

// ─── 2. rescheduleInstallments ──────────────────────────────────────────────

export interface ServicingScheduleEntry {
  seq: number;
  dueAt: string; // ISO
  amountCents: number;
  principalCents: number;
  feeCents: number;
  status: "due" | "paid" | "overdue";
  paidAt: string | null;
  /** W56 servicing stamps — present on replacement slices only. */
  rescheduled?: true;
  previousDueAt?: string | null;
  previousAmountCents?: number | null;
}

export interface NewSliceInput {
  dueAt: string; // ISO date/datetime
  principalCents: number;
  feeCents: number;
}

export interface RescheduleResult {
  ok: true;
  planId: string;
  mode: "grace" | "schedule";
  rescheduledCount: number;
  /** Σ fee of replacement slices − Σ fee of replaced unpaid slices. */
  feeDeltaCents: number;
  /** Principal is invariant by construction — always 0. */
  principalDeltaCents: 0;
  remainingPrincipalCents: number;
  schedule: ServicingScheduleEntry[];
  notified: boolean;
}

function parseSchedule(raw: unknown): ServicingScheduleEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((e: any) => ({
    seq: Number(e.seq),
    dueAt: String(e.dueAt),
    amountCents: Number(e.amountCents),
    principalCents: Number(e.principalCents),
    feeCents: Number(e.feeCents),
    status: e.status,
    paidAt: e.paidAt ?? null,
    ...(e.rescheduled ? { rescheduled: true as const } : {}),
    ...(e.previousDueAt !== undefined ? { previousDueAt: e.previousDueAt } : {}),
    ...(e.previousAmountCents !== undefined ? { previousAmountCents: e.previousAmountCents } : {}),
  }));
}

function assertIntCents(n: number, label: string): void {
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new ServicingError("BAD_REQUEST", `${label} must be a non-negative integer (cents)`);
  }
}

/**
 * Pure replacement-slice builder (unit-tested without a DB — J575 proves it
 * end-to-end). Enforces the SUM INVARIANT (Σ replacement principal ===
 * Σ unpaid principal, integer cents) and stamps every replacement slice
 * `rescheduled: true` with its previous dueAt/amount. Seq numbers continue
 * after the paid slices.
 */
export function buildReplacementSchedule(
  paidCount: number,
  unpaid: ServicingScheduleEntry[],
  slices: NewSliceInput[],
): ServicingScheduleEntry[] {
  const oldPrincipal = unpaid.reduce((a, e) => a + e.principalCents, 0);
  const newPrincipal = slices.reduce((a, s) => a + s.principalCents, 0);
  if (newPrincipal !== oldPrincipal) {
    // SUM INVARIANT — principal is never created or destroyed.
    throw new ServicingError(
      "BAD_REQUEST",
      `principal sum invariant violated: replacement sums to ${newPrincipal} but ${oldPrincipal} is outstanding`,
    );
  }
  return slices.map((s, i) => ({
    seq: paidCount + i + 1,
    dueAt: new Date(s.dueAt).toISOString(),
    amountCents: s.principalCents + s.feeCents,
    principalCents: s.principalCents,
    feeCents: s.feeCents,
    status: "due" as const,
    paidAt: null,
    rescheduled: true as const,
    previousDueAt: unpaid[i]?.dueAt ?? null,
    previousAmountCents: unpaid[i]?.amountCents ?? null,
  }));
}

/**
 * Remaining UNPAID totals of a plan's schedule — used by the router to size
 * the W31 approvals gate BEFORE executing.
 */
export function unpaidTotals(schedule: ServicingScheduleEntry[]): {
  count: number;
  amountCents: number;
  principalCents: number;
  feeCents: number;
} {
  const unpaid = schedule.filter((e) => e.status !== "paid");
  return {
    count: unpaid.length,
    amountCents: unpaid.reduce((a, e) => a + e.amountCents, 0),
    principalCents: unpaid.reduce((a, e) => a + e.principalCents, 0),
    feeCents: unpaid.reduce((a, e) => a + e.feeCents, 0),
  };
}

export async function getPlanUnpaidTotals(
  db: TxHandle,
  planId: string,
): Promise<{ tenantId: string; status: string } & ReturnType<typeof unpaidTotals>> {
  const [plan] = await db
    .select()
    .from(installmentPlans)
    .where(eq(installmentPlans.id, planId))
    .limit(1);
  if (!plan) throw new ServicingError("NOT_FOUND", `installment plan ${planId} not found`);
  return { tenantId: plan.tenantId, status: plan.status, ...unpaidTotals(parseSchedule(plan.schedule)) };
}

/**
 * Recompute the future unpaid slices of an ACTIVE plan. Two modes:
 *   - graceDays: shift every unpaid slice's dueAt by N days (amounts/fee
 *     untouched ⇒ feeDeltaCents = 0);
 *   - newSchedule: replace every unpaid slice with the given slices.
 *     SUM INVARIANT (enforced): Σ principalCents of the replacement ===
 *     Σ principalCents of the replaced unpaid slices — integer cents, no
 *     rounding (caller computes the split; the service refuses any drift).
 * Paid slices are never touched. The prior unpaid schedule is preserved in
 * the audit-log `before` payload; replacement slices are stamped
 * `rescheduled: true` with their previous dueAt/amount.
 */
export async function rescheduleInstallments(
  db: TxHandle,
  args: {
    planId: string;
    graceDays?: number;
    newSchedule?: NewSliceInput[];
    reason: string;
    actorId: string;
    now?: Date;
  },
): Promise<RescheduleResult> {
  const now = args.now ?? new Date();
  assertReason(args.reason);
  const hasGrace = args.graceDays !== undefined;
  const hasSchedule = args.newSchedule !== undefined;
  if (hasGrace === hasSchedule) {
    throw new ServicingError("BAD_REQUEST", "provide exactly one of graceDays or newSchedule");
  }
  if (hasGrace && (!Number.isInteger(args.graceDays!) || args.graceDays! < GRACE_MIN_DAYS || args.graceDays! > GRACE_MAX_DAYS)) {
    throw new ServicingError("BAD_REQUEST", `graceDays must be an integer in ${GRACE_MIN_DAYS}..${GRACE_MAX_DAYS}`);
  }
  if (hasSchedule) {
    if (!Array.isArray(args.newSchedule) || args.newSchedule!.length === 0) {
      throw new ServicingError("BAD_REQUEST", "newSchedule must be a non-empty array of slices");
    }
    for (let i = 0; i < args.newSchedule!.length; i++) {
      const s = args.newSchedule![i];
      assertIntCents(s.principalCents, `newSchedule[${i}].principalCents`);
      assertIntCents(s.feeCents, `newSchedule[${i}].feeCents`);
      if (Number.isNaN(new Date(s.dueAt).getTime())) {
        throw new ServicingError("BAD_REQUEST", `newSchedule[${i}].dueAt is not a valid date`);
      }
    }
  }

  const txOut = await db.transaction(async (tx) => {
    const [plan] = await tx
      .select()
      .from(installmentPlans)
      .where(eq(installmentPlans.id, args.planId))
      .limit(1)
      .for("update");
    if (!plan) throw new ServicingError("NOT_FOUND", `installment plan ${args.planId} not found`);
    if (plan.status !== "active") {
      throw new ServicingError("BAD_REQUEST", `only active plans can be rescheduled (status=${plan.status})`);
    }
    const schedule = parseSchedule(plan.schedule);
    const paid = schedule.filter((e) => e.status === "paid");
    const unpaid = schedule.filter((e) => e.status !== "paid");
    if (unpaid.length === 0) {
      throw new ServicingError("BAD_REQUEST", "plan has no unpaid installments to reschedule");
    }
    const oldUnpaidPrincipal = unpaid.reduce((a, e) => a + e.principalCents, 0);
    const oldUnpaidFee = unpaid.reduce((a, e) => a + e.feeCents, 0);

    let replacement: ServicingScheduleEntry[];
    let mode: "grace" | "schedule";
    if (hasGrace) {
      mode = "grace";
      const shiftMs = args.graceDays! * DAY_MS;
      replacement = unpaid.map((e) => ({
        ...e,
        dueAt: new Date(new Date(e.dueAt).getTime() + shiftMs).toISOString(),
        status: e.status === "overdue" ? "due" as const : e.status,
        rescheduled: true as const,
        previousDueAt: e.dueAt,
        previousAmountCents: e.amountCents,
      }));
    } else {
      mode = "schedule";
      replacement = buildReplacementSchedule(paid.length, unpaid, args.newSchedule!);
    }
    const newUnpaidFee = replacement.reduce((a, e) => a + e.feeCents, 0);
    const feeDeltaCents = newUnpaidFee - oldUnpaidFee;
    const nextSchedule = [...paid, ...replacement].sort((a, b) => a.seq - b.seq);

    const [updated] = await tx
      .update(installmentPlans)
      .set({ schedule: nextSchedule as any, updatedAt: now })
      .where(and(eq(installmentPlans.id, plan.id), eq(installmentPlans.status, "active")))
      .returning({ id: installmentPlans.id });
    if (!updated) throw new ServicingError("CONFLICT", "plan status changed concurrently — retry");

    return {
      plan,
      mode,
      priorUnpaid: unpaid,
      nextSchedule,
      feeDeltaCents,
      remainingPrincipalCents: paid.reduce((a, e) => a + e.principalCents, 0) + oldUnpaidPrincipal,
    };
  });

  await writeAuditLog({
    actorId: args.actorId,
    actorRole: "user",
    action: "credit.installments_rescheduled",
    entityType: "installment_plan",
    entityId: args.planId,
    tenantId: txOut.plan.tenantId,
    summary:
      `Plan ${args.planId} rescheduled (${txOut.mode}, ${txOut.priorUnpaid.length} unpaid slice(s) replaced, ` +
      `fee delta ${txOut.feeDeltaCents} cents): ${args.reason.trim()}`,
    // Prior schedule preserved here (append-only audit) — rows themselves
    // are stamped rescheduled:true with previousDueAt/previousAmountCents.
    before: { unpaidSchedule: txOut.priorUnpaid },
    after: {
      mode: txOut.mode,
      graceDays: args.graceDays ?? null,
      feeDeltaCents: txOut.feeDeltaCents,
      reason: args.reason.trim(),
      unpaidSchedule: txOut.nextSchedule.filter((e) => e.status !== "paid"),
    },
  }).catch(() => {});

  const text = await servicingText(db, txOut.plan.tenantId, "creditRescheduled", {
    count: txOut.priorUnpaid.length,
    delta: (txOut.feeDeltaCents / 100).toFixed(2),
    reason: args.reason.trim(),
  });
  const notice = await notifyBuyerServicing(db, txOut.plan.tenantId, text);

  return {
    ok: true,
    planId: args.planId,
    mode: txOut.mode,
    rescheduledCount: txOut.priorUnpaid.length,
    feeDeltaCents: txOut.feeDeltaCents,
    principalDeltaCents: 0,
    remainingPrincipalCents: txOut.remainingPrincipalCents,
    schedule: txOut.nextSchedule,
    notified: notice.notified,
  };
}

// ─── 3. gracePeriod ─────────────────────────────────────────────────────────

export interface GracePeriodResult {
  ok: true;
  accountId: string;
  days: number;
  /** Draws actually extended by THIS call (0 on an actionRef retry). */
  extended: number;
  actionRef: string;
  ledgerNoteId?: string;
  notified: boolean;
}

/**
 * Extend due_date on every OPEN draw (kind='invoice_draw', status='posted',
 * due_date set) of the account by `days`. Rows are NEVER voided; dunning
 * reads due_date live from the ledger each sweep, so reminders/late fees /
 * the +7d freeze all slide with the extension. Claim-first: each extended
 * row carries the ` [grace:<actionRef>]` marker and the UPDATE refuses rows
 * already bearing it — a retry with the SAME actionRef is a no-op.
 */
export async function gracePeriod(
  db: TxHandle,
  args: { accountId: string; days: number; reason: string; actorId: string; actionRef?: string; now?: Date },
): Promise<GracePeriodResult> {
  const now = args.now ?? new Date();
  assertReason(args.reason);
  if (!Number.isInteger(args.days) || args.days < GRACE_MIN_DAYS || args.days > GRACE_MAX_DAYS) {
    throw new ServicingError("BAD_REQUEST", `days must be an integer in ${GRACE_MIN_DAYS}..${GRACE_MAX_DAYS}`);
  }
  const actionRef = args.actionRef ?? crypto.randomUUID();
  const marker = `[grace:${actionRef}]`;

  const txOut = await db.transaction(async (tx) => {
    const [account] = await tx
      .select()
      .from(creditAccounts)
      .where(eq(creditAccounts.id, args.accountId))
      .limit(1)
      .for("update");
    if (!account) throw new ServicingError("NOT_FOUND", `credit account ${args.accountId} not found`);
    if (account.status === "closed") {
      throw new ServicingError("BAD_REQUEST", "cannot grant a grace period on a closed credit account");
    }
    const extendedRows = await tx
      .update(creditLedger)
      .set({
        dueDate: sql`${creditLedger.dueDate} + (${args.days} * INTERVAL '1 day')`,
        note: sql`COALESCE(${creditLedger.note}, '') || ${" " + marker}`,
      })
      .where(
        and(
          eq(creditLedger.creditAccountId, account.id),
          eq(creditLedger.kind, "invoice_draw"),
          eq(creditLedger.status, "posted"),
          isNotNull(creditLedger.dueDate),
          sql`(${creditLedger.note} IS NULL OR ${creditLedger.note} NOT LIKE ${"%" + marker + "%"})`,
        ),
      )
      .returning({ id: creditLedger.id });

    let ledgerNoteId: string | undefined;
    if (extendedRows.length > 0) {
      const notePayload = {
        type: "grace_period",
        days: args.days,
        extendedDrawIds: extendedRows.map((r) => r.id),
        reason: args.reason.trim(),
        actorId: args.actorId,
        actionRef,
        at: now.toISOString(),
      };
      const [noteRow] = await tx
        .insert(creditLedger)
        .values({
          creditAccountId: account.id,
          kind: "adjustment",
          amountCents: 0,
          status: "posted",
          ref: `grace:${account.id}:${actionRef}`,
          note: `[svc:grace] ${JSON.stringify(notePayload)}`,
        })
        .returning({ id: creditLedger.id });
      ledgerNoteId = noteRow?.id;
    }
    return { account, extended: extendedRows.length, ledgerNoteId };
  });

  if (txOut.extended > 0) {
    await writeAuditLog({
      actorId: args.actorId,
      actorRole: "user",
      action: "credit.grace_period_granted",
      entityType: "credit_account",
      entityId: args.accountId,
      tenantId: txOut.account.supplierTenantId,
      summary: `Grace period +${args.days}d on ${txOut.extended} open draw(s): ${args.reason.trim()}`,
      after: { days: args.days, extended: txOut.extended, actionRef, reason: args.reason.trim() },
    }).catch(() => {});
  }

  const text = await servicingText(db, txOut.account.buyerTenantId, "creditGraceExtended", {
    days: args.days,
    count: txOut.extended,
    reason: args.reason.trim(),
  });
  const notice = await notifyBuyerServicing(db, txOut.account.buyerTenantId, text);

  return {
    ok: true,
    accountId: args.accountId,
    days: args.days,
    extended: txOut.extended,
    actionRef,
    ledgerNoteId: txOut.ledgerNoteId,
    notified: notice.notified,
  };
}
// === END W56 credit ===
