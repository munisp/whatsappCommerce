/**
 * === W31 approvals (Coder C) — threshold approval workflows ===
 *
 * A tenant approval policy (tenant_approval_policies) parks covered money
 * actions as approval_requests rows until a member with the policy's
 * approver_role decides. Honest semantics:
 *   - no policy row, threshold_cents = 0, or kind not covered
 *     → requireApprovalIfNeeded returns { approvalRequired: false } and the
 *       caller proceeds exactly as pre-W31;
 *   - threshold > 0 and amountCents >= threshold → the action parks as
 *     status 'pending' and callers surface an honest `pending_approval`.
 *
 * Approval is a GATE, not a money mover: approve/reject only flips the
 * request row (guarded single-consumption UPDATE — concurrent decisions get
 * CONFLICT). Execution re-invokes the ORIGINATING action through the
 * registered executor map (kind → executor fn), so the money path, its
 * idempotency keys and its ledger writes stay identical to a direct call.
 *
 * Executor-map contract (for A/B/D parallel branches + merger):
 *   registerApprovalExecutor(kind, fn) — call once at module scope of the
 *   OWNING router file (bannered). fn receives { db, approval } and MUST
 *   re-invoke the originating action with the SAME idempotency reference
 *   stored in approval.metadata.reference, returning
 *   { ok: true, reference?, detail? } on success or throwing / returning
 *   { ok: false, detail } on honest failure (the approval then stays
 *   'approved' — decided but not executed — never silently lost).
 *   - "withdrawal"           → implemented on THIS branch (escrow.ts).
 *   - "vendor_bill_payment"  → Coder A wires vendorBills.recordPayment
 *                              (bill flips to 'approved'/'paid' only after
 *                              this executor runs; payment_ref idempotency
 *                              stays A's).
 *   - "scheduled_payment"    → Coder B wires adhoc payout execution above
 *                              threshold (sched:<id> idempotency stays B's).
 *   Kinds without a registered executor approve honestly as
 *   { executed: false, reason: "no_executor" } — nothing moves.
 *
 * Step-up composition: approving a withdrawal/payout-kind request above
 * WITHDRAWAL_STEPUP_THRESHOLD still requires a fresh step-up OTP at DECISION
 * time (purpose "withdrawal"); the challenge id is stored on the row and the
 * withdrawal executor replays with approvalId so requestWithdrawal knows the
 * gates were already satisfied exactly once. Compose, never bypass.
 */
import { and, eq, lt, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import type { getDb } from "../db";
import {
  approvalRequests,
  tenantApprovalPolicies,
  tenantMemberships,
  users,
  type ApprovalRequest,
  type TenantApprovalPolicy,
} from "../../drizzle/schema";
import { writeAuditLog } from "../routers/audit";

export type DbHandle = NonNullable<Awaited<ReturnType<typeof getDb>>>;

export type ApprovalKind =
  | "vendor_bill_payment"
  | "scheduled_payment"
  | "withdrawal"
  | "payout";

export const APPROVAL_KINDS: readonly ApprovalKind[] = [
  "vendor_bill_payment",
  "scheduled_payment",
  "withdrawal",
  "payout",
];

// ─── Executor map ───────────────────────────────────────────────────────────

export interface ApprovalExecutionContext {
  db: DbHandle;
  approval: ApprovalRequest;
  /** User id of the approver who triggered execution. */
  actorId: string;
}

export interface ApprovalExecutionResult {
  ok: boolean;
  reference?: string;
  detail?: string;
}

export type ApprovalExecutor = (
  ctx: ApprovalExecutionContext,
) => Promise<ApprovalExecutionResult>;

const EXECUTORS = new Map<string, ApprovalExecutor>();

/**
 * Register the executor for a kind. Called once at module scope by the
 * router file that owns the originating action (see contract above).
 * Re-registering the same kind throws — a kind has exactly ONE money path.
 */
export function registerApprovalExecutor(kind: ApprovalKind, fn: ApprovalExecutor): void {
  if (EXECUTORS.has(kind)) {
    throw new Error(`approval executor already registered for kind ${kind}`);
  }
  EXECUTORS.set(kind, fn);
}

export function getApprovalExecutor(kind: string): ApprovalExecutor | null {
  return EXECUTORS.get(kind) ?? null;
}

// ─── Policy ─────────────────────────────────────────────────────────────────

export async function getApprovalPolicy(
  db: DbHandle,
  tenantId: string,
): Promise<TenantApprovalPolicy | null> {
  const [row] = await db
    .select()
    .from(tenantApprovalPolicies)
    .where(eq(tenantApprovalPolicies.tenantId, tenantId));
  return row ?? null;
}

/** Does this policy park (kind, amountCents)? Pure — exported for tests. */
export function policyCovers(
  policy: Pick<TenantApprovalPolicy, "thresholdCents" | "kinds"> | null,
  kind: string,
  amountCents: number,
): boolean {
  if (!policy) return false;
  if (!policy.thresholdCents || policy.thresholdCents <= 0) return false;
  if (amountCents < policy.thresholdCents) return false;
  if (policy.kinds && policy.kinds.length > 0 && !policy.kinds.includes(kind)) return false;
  return true;
}

/**
 * The gate every money procedure calls BEFORE executing (bannered insert at
 * the call site). Creates a pending approval_requests row when the tenant
 * policy covers this (kind, amount); otherwise a no-op.
 */
export async function requireApprovalIfNeeded(
  tenantId: string,
  kind: ApprovalKind,
  amountCents: number,
  targetId: string | null,
  db: DbHandle,
  opts: { requestedBy?: string; reference?: string; metadata?: Record<string, unknown> } = {},
): Promise<{ approvalRequired: boolean; approvalId?: string }> {
  const policy = await getApprovalPolicy(db, tenantId);
  if (!policyCovers(policy, kind, amountCents)) {
    return { approvalRequired: false };
  }
  const id = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + (policy!.expiryHours || 72) * 60 * 60 * 1000);
  await db.insert(approvalRequests).values({
    id,
    tenantId,
    kind,
    targetId,
    amountCents,
    requestedBy: opts.requestedBy ?? "system",
    approverRole: policy!.approverRole || "owner",
    status: "pending",
    expiresAt,
    metadata: {
      ...(opts.reference ? { reference: opts.reference } : {}),
      ...(opts.metadata ?? {}),
    },
  });
  await writeAuditLog({
    actorId: opts.requestedBy ?? "system",
    actorRole: "user",
    action: "approval.requested",
    entityType: "approval_request",
    entityId: id,
    tenantId,
    summary: `Approval required: ${kind} of ${(amountCents / 100).toFixed(2)} parked pending ${policy!.approverRole} approval`,
    after: { kind, amountCents, targetId, approverRole: policy!.approverRole },
  }).catch(() => {});
  // WA notification to the approver(s) — best-effort, never blocks the gate.
  // AWAITED (not fire-and-forget): concurrent pipelined queries over the
  // single embedded-PG connection can cross results; the notify helpers are
  // internally catch-guarded so a WA failure still never blocks the gate.
  await notifyApprovers(db, tenantId, policy!.approverRole || "owner", {
    id,
    kind,
    amountCents,
    requestedBy: opts.requestedBy ?? "system",
  }).catch(() => {});
  return { approvalRequired: true, approvalId: id };
}

// ─── Decision (approve / reject) ────────────────────────────────────────────

/** ApproverRole check against the caller's membership (fail-closed). */
export async function assertApproverRole(
  db: DbHandle,
  tenantId: string,
  userId: string | number,
  approverRole: string,
): Promise<string> {
  const [m] = await db
    .select()
    .from(tenantMemberships)
    .where(and(
      eq(tenantMemberships.tenantId, tenantId),
      eq(tenantMemberships.userId, String(userId)),
    ));
  if (!m) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Only tenant members can decide approval requests" });
  }
  if (approverRole === "operator") {
    if (m.role === "owner" || m.role === "operator") return m.role;
  } else if (m.role === "owner") {
    return m.role;
  }
  throw new TRPCError({
    code: "FORBIDDEN",
    message: `This approval requires the ${approverRole} role (you are ${m.role})`,
  });
}

export interface DecideArgs {
  tenantId: string;
  approvalId: string;
  approverUserId: string | number;
  approve: boolean;
  note?: string;
  /** Required when approving withdrawal/payout above the step-up threshold. */
  stepUpChallengeId?: string;
  stepUpOtp?: string;
}

export interface DecideResult {
  approval: ApprovalRequest;
  executed: boolean;
  execution?: ApprovalExecutionResult | { ok: false; detail: string };
}

/**
 * Single-consumption decision: guarded UPDATE ... WHERE status='pending'
 * AND not expired. The loser's UPDATE matches zero rows → CONFLICT.
 * On approve, the registered executor re-invokes the originating action;
 * execution success flips the row to 'executed' (approved-but-unexecuted is
 * an honest, inspectable state — never a silent money claim).
 */
export async function decideApproval(db: DbHandle, args: DecideArgs): Promise<DecideResult> {
  const [req] = await db
    .select()
    .from(approvalRequests)
    .where(and(eq(approvalRequests.id, args.approvalId), eq(approvalRequests.tenantId, args.tenantId)));
  if (!req) throw new TRPCError({ code: "NOT_FOUND", message: "Approval request not found" });
  if (req.status !== "pending") {
    throw new TRPCError({
      code: "CONFLICT",
      message: `Approval request already ${req.status} — decisions are single-consumption`,
    });
  }
  await assertApproverRole(db, args.tenantId, args.approverUserId, req.approverRole);

  // Step-up composition: high-value payout/withdrawal approvals need a fresh
  // OTP at decision time. The challenge is consumed HERE; execution replays
  // with approvalId so the originating path does not demand a second one.
  if (args.approve) {
    const { requireStepUp, withdrawalStepUpThreshold } = await import("./stepUp");
    const stepUpThresholdCents = Math.floor(withdrawalStepUpThreshold() * 100);
    const needsStepUp =
      (req.kind === "withdrawal" || req.kind === "payout") && req.amountCents > stepUpThresholdCents;
    await requireStepUp(db, {
      required: needsStepUp,
      tenantId: args.tenantId,
      userId: args.approverUserId,
      purpose: "withdrawal",
      stepUpChallengeId: args.stepUpChallengeId,
      stepUpOtp: args.stepUpOtp,
    });
  }

  const now = new Date();
  const decided = await db
    .update(approvalRequests)
    .set({
      status: args.approve ? "approved" : "rejected",
      decidedBy: String(args.approverUserId),
      decidedAt: now,
      decisionNote: args.note ?? null,
      ...(args.stepUpChallengeId ? { stepUpChallengeId: args.stepUpChallengeId } : {}),
    })
    .where(and(
      eq(approvalRequests.id, req.id),
      eq(approvalRequests.status, "pending"),
      sql`${approvalRequests.expiresAt} > now()`,
    ))
    .returning();
  if (decided.length === 0) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "Approval request was already decided or has expired — decisions are single-consumption",
    });
  }
  const decidedRow = decided[0];

  await writeAuditLog({
    actorId: String(args.approverUserId),
    actorRole: "user",
    action: args.approve ? "approval.approved" : "approval.rejected",
    entityType: "approval_request",
    entityId: req.id,
    tenantId: args.tenantId,
    summary: `Approval ${req.id} (${req.kind}, ${(req.amountCents / 100).toFixed(2)}) ${args.approve ? "approved" : "rejected"}${args.note ? `: ${args.note}` : ""}`,
    after: { status: decidedRow.status, kind: req.kind, amountCents: req.amountCents, targetId: req.targetId },
  }).catch(() => {});

  let executed = false;
  let execution: DecideResult["execution"];
  if (args.approve) {
    const executor = getApprovalExecutor(req.kind);
    if (!executor) {
      // Honest: approved, but this branch has no money path for the kind.
      execution = { ok: false, detail: `no_executor: no approval executor registered for kind ${req.kind}` };
    } else {
      try {
        const result = await executor({ db, approval: decidedRow, actorId: String(args.approverUserId) });
        execution = result;
        if (result.ok) {
          executed = true;
          const [ex] = await db
            .update(approvalRequests)
            .set({ status: "executed", executedAt: new Date() })
            .where(and(eq(approvalRequests.id, req.id), eq(approvalRequests.status, "approved")))
            .returning();
          if (ex) decidedRow.status = ex.status;
        }
      } catch (err) {
        execution = { ok: false, detail: (err as Error)?.message ?? "executor failed" };
      }
    }
  }

  // WA result to the requester — best-effort (awaited; see note above).
  await notifyRequester(db, args.tenantId, decidedRow, args.approve, executed, execution).catch(() => {});
  return { approval: decidedRow, executed, execution };
}

// ─── Withdrawal replay validation (called from escrow.requestWithdrawal) ────

/**
 * Validate that a withdrawal replay carrying approvalId is the execution leg
 * of a legitimately approved request: row exists for this tenant, kind is
 * withdrawal/payout, status is approved (first execution) or executed
 * (idempotent replay — the wallet reference uniqueness backstop still
 * prevents any double debit), and the amount matches exactly.
 */
export async function assertApprovedWithdrawalReplay(
  db: DbHandle,
  args: { approvalId: string; tenantId: string; amountCents: number },
): Promise<ApprovalRequest> {
  const [req] = await db
    .select()
    .from(approvalRequests)
    .where(and(eq(approvalRequests.id, args.approvalId), eq(approvalRequests.tenantId, args.tenantId)));
  if (!req) throw new TRPCError({ code: "NOT_FOUND", message: "Approval request not found for this tenant" });
  if (req.kind !== "withdrawal" && req.kind !== "payout") {
    throw new TRPCError({ code: "BAD_REQUEST", message: `Approval ${args.approvalId} is for kind ${req.kind}, not a withdrawal` });
  }
  if (req.status !== "approved" && req.status !== "executed") {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Approval request is ${req.status} — only approved requests execute` });
  }
  if (req.amountCents !== args.amountCents) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Withdrawal amount does not match the approved request" });
  }
  return req;
}

// ─── Expiry sweep (cron) ────────────────────────────────────────────────────

/**
 * Flip stale pending requests to 'expired' (guarded UPDATE; claim-before-
 * notify so a concurrent decide cannot race the sweep). Returns the expired
 * rows for notification. Exported for the /api/scheduled/approvals-expiry
 * cron block in _core/index.ts.
 */
export async function sweepExpiredApprovals(db: DbHandle, now: Date = new Date()): Promise<ApprovalRequest[]> {
  const expired = await db
    .update(approvalRequests)
    .set({ status: "expired" })
    .where(and(
      eq(approvalRequests.status, "pending"),
      lt(approvalRequests.expiresAt, now),
    ))
    .returning();
  for (const row of expired) {
    await writeAuditLog({
      actorId: "system",
      actorRole: "system",
      action: "approval.expired",
      entityType: "approval_request",
      entityId: row.id,
      tenantId: row.tenantId,
      summary: `Approval ${row.id} (${row.kind}) expired without a decision`,
      after: { status: "expired", kind: row.kind, amountCents: row.amountCents },
    }).catch(() => {});
    await notifyRequester(db, row.tenantId, row, false, false, { ok: false, detail: "expired" }).catch(() => {});
  }
  return expired;
}

// ─── WhatsApp notifications (best-effort) ───────────────────────────────────

async function resolvePhonesForRole(db: DbHandle, tenantId: string, role: string): Promise<string[]> {
  const roles = role === "operator" ? ["owner", "operator"] : ["owner"];
  const members = await db
    .select({ userId: tenantMemberships.userId })
    .from(tenantMemberships)
    .where(and(
      eq(tenantMemberships.tenantId, tenantId),
      sql`${tenantMemberships.role} = ANY(${roles})`,
    ))
    .catch(() => [] as { userId: string }[]);
  const phones: string[] = [];
  for (const m of members) {
    const uid = Number(m.userId);
    if (!Number.isFinite(uid)) continue;
    const [u] = await db.select({ phone: users.phone }).from(users).where(eq(users.id, uid)).catch(() => []);
    if (u?.phone) phones.push(u.phone);
  }
  return phones;
}

async function notifyApprovers(
  db: DbHandle,
  tenantId: string,
  approverRole: string,
  req: { id: string; kind: string; amountCents: number; requestedBy: string },
): Promise<void> {
  const phones = await resolvePhonesForRole(db, tenantId, approverRole);
  if (phones.length === 0) return;
  const { sendWhatsAppText } = await import("./waSender");
  const body =
    `Approval needed (${approverRole}): ${req.kind} of ${(req.amountCents / 100).toFixed(2)} ` +
    `requested by ${req.requestedBy}. Approve/reject in the dashboard under Approvals. Ref ${req.id.slice(0, 8)}.`;
  for (const phone of phones) {
    await sendWhatsAppText(tenantId, phone, body, { notifType: "approval_request" }).catch(() => {});
  }
}

async function notifyRequester(
  db: DbHandle,
  tenantId: string,
  req: ApprovalRequest,
  approved: boolean,
  executed: boolean,
  execution?: { ok: boolean; detail?: string },
): Promise<void> {
  const uid = Number(req.requestedBy);
  if (!Number.isFinite(uid)) return;
  const [u] = await db.select({ phone: users.phone }).from(users).where(eq(users.id, uid)).catch(() => []);
  if (!u?.phone) return;
  const { sendWhatsAppText } = await import("./waSender");
  const amount = (req.amountCents / 100).toFixed(2);
  const body = req.status === "expired"
    ? `Your ${req.kind} of ${amount} expired without approval — nothing moved. Re-submit if still needed. Ref ${req.id.slice(0, 8)}.`
    : approved
      ? executed
        ? `Your ${req.kind} of ${amount} was approved and executed. Ref ${req.id.slice(0, 8)}.`
        : `Your ${req.kind} of ${amount} was approved but could not execute yet (${execution?.detail ?? "pending"}). Nothing moved. Ref ${req.id.slice(0, 8)}.`
      : `Your ${req.kind} of ${amount} was rejected${req.decisionNote ? `: ${req.decisionNote}` : ""}. Nothing moved. Ref ${req.id.slice(0, 8)}.`;
  await sendWhatsAppText(tenantId, u.phone, body, { notifType: "approval_result" }).catch(() => {});
}
