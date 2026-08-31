/**
 * === W31 approvals (Coder C) — threshold approval workflow router ===
 *
 * Policy management (owner-only setPolicy) + approval decision surface
 * (list/get/approve/reject). The approval is a GATE: approve/reject flips
 * the approval_requests row (single-consumption guarded UPDATE — concurrent
 * decisions get CONFLICT); the actual money movement is re-invoked through
 * the executor map in server/services/approvals.ts by the originating
 * action's owner (withdrawal executor lives in escrow.ts on this branch;
 * vendor_bill_payment / scheduled_payment are registration hooks for the
 * W31 A/B branches — see the contract comment in the service).
 */
import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { analystProcedure, moneyProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import { approvalRequests } from "../../drizzle/schema";
import {
  APPROVAL_KINDS,
  decideApproval,
  getApprovalPolicy,
} from "../services/approvals";

const kindEnum = z.enum(APPROVAL_KINDS as [string, ...string[]]);

export const approvalsRouter = router({
  /**
   * Owner-only: set/replace the tenant's approval policy.
   * thresholdCents = 0 disables approvals honestly (default).
   */
  setPolicy: moneyProcedure
    .input(z.object({
      tenantId: z.string(),
      thresholdCents: z.number().int().min(0),
      kinds: z.array(kindEnum).optional(),
      approverRole: z.enum(["owner", "operator"]).default("owner"),
      expiryHours: z.number().int().min(1).max(720).default(72),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");
      // Owner-only: moneyProcedure admitted owner|operator (or a legacy
      // single-user caller with no membership row); policy writes are an
      // owner control, so operator memberships stop here.
      if (ctx.user.role !== "admin" && ctx.membership && ctx.membership.role !== "owner") {
        throw new TRPCError({ code: "FORBIDDEN", message: "Only the tenant owner can set the approval policy" });
      }
      const { tenantApprovalPolicies } = await import("../../drizzle/schema");
      const kinds = input.kinds && input.kinds.length > 0 ? input.kinds : null;
      await db.insert(tenantApprovalPolicies).values({
        tenantId: input.tenantId,
        thresholdCents: input.thresholdCents,
        kinds: kinds as string[] | null,
        approverRole: input.approverRole,
        expiryHours: input.expiryHours,
        updatedAt: new Date(),
        updatedBy: String(ctx.user.id),
      }).onConflictDoUpdate({
        target: tenantApprovalPolicies.tenantId,
        set: {
          thresholdCents: input.thresholdCents,
          kinds: kinds as string[] | null,
          approverRole: input.approverRole,
          expiryHours: input.expiryHours,
          updatedAt: new Date(),
          updatedBy: String(ctx.user.id),
        },
      });
      const { writeAuditLog } = await import("./audit");
      await writeAuditLog({
        actorId: String(ctx.user.id),
        actorRole: ctx.user.role,
        action: "approval.policy_set",
        entityType: "tenant_approval_policy",
        entityId: input.tenantId,
        tenantId: input.tenantId,
        summary: `Approval policy set: threshold ${(input.thresholdCents / 100).toFixed(2)} (${input.thresholdCents === 0 ? "off" : "on"}), approver ${input.approverRole}`,
        after: { thresholdCents: input.thresholdCents, kinds, approverRole: input.approverRole, expiryHours: input.expiryHours },
      }).catch(() => {});
      return { ok: true, enabled: input.thresholdCents > 0 };
    }),

  getPolicy: analystProcedure
    .input(z.object({ tenantId: z.string() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return null;
      return getApprovalPolicy(db, input.tenantId);
    }),

  list: analystProcedure
    .input(z.object({
      tenantId: z.string(),
      status: z.enum(["pending", "approved", "rejected", "expired", "executed"]).optional(),
      kind: kindEnum.optional(),
      limit: z.number().int().min(1).max(200).default(50),
    }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return [];
      const conditions = [eq(approvalRequests.tenantId, input.tenantId)];
      if (input.status) conditions.push(eq(approvalRequests.status, input.status));
      if (input.kind) conditions.push(eq(approvalRequests.kind, input.kind));
      return db.select().from(approvalRequests)
        .where(and(...conditions))
        .orderBy(desc(approvalRequests.createdAt))
        .limit(input.limit);
    }),

  get: analystProcedure
    .input(z.object({ tenantId: z.string(), approvalId: z.string().uuid() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return null;
      const [row] = await db.select().from(approvalRequests)
        .where(and(eq(approvalRequests.id, input.approvalId), eq(approvalRequests.tenantId, input.tenantId)));
      return row ?? null;
    }),

  /**
   * Approve: single-consumption (concurrent approve/reject → CONFLICT).
   * Withdrawal/payout requests above WITHDRAWAL_STEPUP_THRESHOLD still
   * require a fresh step-up OTP here — composed, never bypassed. Execution
   * re-invokes the originating action via the registered executor.
   */
  approve: moneyProcedure
    .input(z.object({
      tenantId: z.string(),
      approvalId: z.string().uuid(),
      note: z.string().max(500).optional(),
      stepUpChallengeId: z.string().uuid().optional(),
      stepUpOtp: z.string().length(6).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");
      const result = await decideApproval(db, {
        tenantId: input.tenantId,
        approvalId: input.approvalId,
        approverUserId: ctx.user.id,
        approve: true,
        note: input.note,
        stepUpChallengeId: input.stepUpChallengeId,
        stepUpOtp: input.stepUpOtp,
      });
      return {
        ok: true,
        status: result.approval.status,
        executed: result.executed,
        execution: result.execution ?? null,
      };
    }),

  reject: moneyProcedure
    .input(z.object({
      tenantId: z.string(),
      approvalId: z.string().uuid(),
      note: z.string().max(500).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");
      const result = await decideApproval(db, {
        tenantId: input.tenantId,
        approvalId: input.approvalId,
        approverUserId: ctx.user.id,
        approve: false,
        note: input.note,
      });
      return { ok: true, status: result.approval.status };
    }),
});
