// === W56 credit ===
/**
 * creditServicing router — mid-flight servicing admin workflows over
 * services/creditServicing.ts (Feature 3).
 *
 * Guards (compose, never bypass):
 *   - moneyProcedure on every mutation (owner|operator|finance membership;
 *     platform admin bypass) + assertTenantAccess on the tenantId input;
 *   - supplier-ownership: fee/grace actions require the caller's tenant to
 *     be the facility's SUPPLIER (the lender side); reschedule requires the
 *     caller's tenant to own the installment plan;
 *   - W31 approvals threshold gate: a reschedule whose remaining unpaid
 *     total meets the tenant policy parks as kind "credit_servicing"
 *     (registered below — executor re-invokes the SAME service call with
 *     the SAME parameters stored on the approval row);
 *   - reason is mandatory everywhere (service enforces too).
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { desc, eq } from "drizzle-orm";
import { moneyProcedure, analystProcedure, router, assertTenantAccess } from "../_core/trpc";
import { getDb } from "../db";
import { creditAccounts, creditLedger } from "../../drizzle/schema";
import {
  adjustFeeBps,
  getPlanUnpaidTotals,
  gracePeriod,
  rescheduleInstallments,
  ServicingError,
} from "../services/creditServicing";
import { registerApprovalExecutor, requireApprovalIfNeeded } from "../services/approvals";

async function requireDb() {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
  return db;
}

function rethrowKnown(err: unknown): never {
  if (err instanceof ServicingError) {
    throw new TRPCError({ code: err.code, message: err.message });
  }
  throw err;
}

// W31 executor-map contract: exactly ONE registration per kind, at module
// scope of the OWNING router. Execution re-invokes the originating action
// with the parameters stored on the approval row — the money path, audit
// and notification are identical to a direct call.
registerApprovalExecutor("credit_servicing", async ({ db, approval, actorId }) => {
  const md = (approval.metadata ?? {}) as any;
  if (md.action !== "reschedule_installments" || typeof md.planId !== "string") {
    return { ok: false, detail: "unsupported credit_servicing approval payload" };
  }
  try {
    const res = await rescheduleInstallments(db, {
      planId: md.planId,
      graceDays: md.graceDays ?? undefined,
      newSchedule: md.newSchedule ?? undefined,
      reason: typeof md.reason === "string" ? md.reason : "approved servicing reschedule",
      actorId,
    });
    return { ok: true, reference: `svc-resched:${res.planId}`, detail: `fee delta ${res.feeDeltaCents} cents` };
  } catch (err: any) {
    return { ok: false, detail: err?.message ?? String(err) };
  }
});

const newSlice = z.object({
  dueAt: z.string().min(4),
  principalCents: z.number().int().min(0),
  feeCents: z.number().int().min(0),
});

export const creditServicingRouter = router({
  /**
   * Adjust the facility fee (basis points). FUTURE-ONLY: applies to
   * unbilled/future fee accruals; settled/posted ledger rows are never
   * rewritten. Reason required.
   */
  adjustFee: moneyProcedure
    .input(z.object({
      tenantId: z.string(),
      accountId: z.string().uuid(),
      newFeeBps: z.number().int().min(0).max(10_000),
      reason: z.string().min(1).max(255),
    }))
    .mutation(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await requireDb();
      try {
        const [account] = await db
          .select({ supplierTenantId: creditAccounts.supplierTenantId })
          .from(creditAccounts)
          .where(eq(creditAccounts.id, input.accountId))
          .limit(1);
        if (!account) throw new ServicingError("NOT_FOUND", `credit account ${input.accountId} not found`);
        if (account.supplierTenantId !== input.tenantId) {
          throw new TRPCError({ code: "FORBIDDEN", message: "Only the supplier side of the facility can adjust its fee" });
        }
        return await adjustFeeBps(db, {
          accountId: input.accountId,
          newFeeBps: input.newFeeBps,
          reason: input.reason,
          actorId: String(ctx.user.id),
        });
      } catch (err) {
        rethrowKnown(err);
      }
    }),

  /**
   * Reschedule the future unpaid installments of an ACTIVE pay-over-time
   * plan — either shift all unpaid slices by graceDays, or replace them
   * with newSchedule (principal sum invariant enforced). Above the tenant's
   * approval-policy threshold the action parks as a "credit_servicing"
   * approval instead of executing.
   */
  reschedule: moneyProcedure
    .input(z.object({
      tenantId: z.string(),
      planId: z.string().uuid(),
      graceDays: z.number().int().min(1).max(90).optional(),
      newSchedule: z.array(newSlice).min(1).max(60).optional(),
      reason: z.string().min(1).max(255),
    }))
    .mutation(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await requireDb();
      try {
        const totals = await getPlanUnpaidTotals(db, input.planId);
        if (totals.tenantId !== input.tenantId) {
          throw new TRPCError({ code: "FORBIDDEN", message: "Only the plan's tenant can reschedule it" });
        }
        // W31 threshold gate for large changes: the parked request carries
        // the full parameter set so the executor replays THIS exact action.
        const gate = await requireApprovalIfNeeded(
          input.tenantId,
          "credit_servicing",
          totals.amountCents,
          input.planId,
          db,
          {
            requestedBy: String(ctx.user.id),
            reference: `svc-resched:${input.planId}`,
            metadata: {
              action: "reschedule_installments",
              planId: input.planId,
              graceDays: input.graceDays ?? null,
              newSchedule: input.newSchedule ?? null,
              reason: input.reason,
            },
          },
        );
        if (gate.approvalRequired) {
          return { pendingApproval: true as const, approvalId: gate.approvalId };
        }
        const res = await rescheduleInstallments(db, {
          planId: input.planId,
          graceDays: input.graceDays,
          newSchedule: input.newSchedule,
          reason: input.reason,
          actorId: String(ctx.user.id),
        });
        return { pendingApproval: false as const, ...res };
      } catch (err) {
        rethrowKnown(err);
      }
    }),

  /**
   * Grant a grace period: extend due dates on the facility's OPEN draws by
   * N days (never voids rows; dunning reads due_date live). actionRef is an
   * optional idempotency key — a retry with the same key extends nothing.
   */
  gracePeriod: moneyProcedure
    .input(z.object({
      tenantId: z.string(),
      accountId: z.string().uuid(),
      days: z.number().int().min(1).max(90),
      reason: z.string().min(1).max(255),
      actionRef: z.string().min(4).max(64).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await requireDb();
      try {
        const [account] = await db
          .select({ supplierTenantId: creditAccounts.supplierTenantId })
          .from(creditAccounts)
          .where(eq(creditAccounts.id, input.accountId))
          .limit(1);
        if (!account) throw new ServicingError("NOT_FOUND", `credit account ${input.accountId} not found`);
        if (account.supplierTenantId !== input.tenantId) {
          throw new TRPCError({ code: "FORBIDDEN", message: "Only the supplier side of the facility can grant a grace period" });
        }
        return await gracePeriod(db, {
          accountId: input.accountId,
          days: input.days,
          reason: input.reason,
          actorId: String(ctx.user.id),
          actionRef: input.actionRef,
        });
      } catch (err) {
        rethrowKnown(err);
      }
    }),

  /** Append-only servicing audit trail for one credit account (adjustment rows). */
  servicingHistory: analystProcedure
    .input(z.object({
      tenantId: z.string(),
      accountId: z.string().uuid(),
      limit: z.number().int().min(1).max(200).default(50),
    }))
    .query(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await requireDb();
      const [account] = await db
        .select({ supplierTenantId: creditAccounts.supplierTenantId, buyerTenantId: creditAccounts.buyerTenantId })
        .from(creditAccounts)
        .where(eq(creditAccounts.id, input.accountId))
        .limit(1);
      if (!account) throw new TRPCError({ code: "NOT_FOUND", message: "credit account not found" });
      if (account.supplierTenantId !== input.tenantId && account.buyerTenantId !== input.tenantId) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Not a party to this facility" });
      }
      return db
        .select()
        .from(creditLedger)
        .where(eq(creditLedger.creditAccountId, input.accountId))
        .orderBy(desc(creditLedger.createdAt))
        .limit(input.limit);
    }),
});
// === END W56 credit ===
