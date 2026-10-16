// === W57 risk-shield ===
/**
 * creditInsurance router — Feature 3 (credit insurance adapter) + Feature 4
 * (first-loss provision fund) tRPC surface.
 *
 * Guards (compose, never bypass):
 *   - moneyProcedure on tenant mutations (owner|operator|finance membership;
 *     platform admin bypass) + assertTenantAccess on the tenantId input;
 *   - adminProcedure for provision-fund DRAWS (money movement out of the
 *     fund) with the W31 approvals threshold gate, additive kind
 *     'provision_draw' (executor registered below — replays THIS exact
 *     draw with the SAME parameters);
 *   - services stay fail-open for transport (insurance outage never blocks
 *     credit) and fail-closed for money (insufficient provision balance
 *     refuses the draw).
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { adminProcedure, moneyProcedure, router, assertTenantAccess } from "../_core/trpc";
import { getDb } from "../db";
import {
  bindPolicy,
  fileClaim,
  listClaims,
  listPolicies,
  quotePremium,
  resolveClaim,
} from "../services/creditInsurance";
import {
  accrueFromFeeEvent,
  drawFromFund,
  getProvisionBalance,
  getProvisionFundBps,
  listProvisionLedger,
  ProvisionError,
  recoveryCredit,
} from "../services/provisionFund";
import { registerApprovalExecutor, requireApprovalIfNeeded } from "../services/approvals";
import { writeAuditLog } from "./audit";

async function requireDb() {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
  return db;
}

function rethrowProvision(err: unknown): never {
  if (err instanceof ProvisionError) {
    throw new TRPCError({
      code: err.code === "INSUFFICIENT_FUNDS" ? "PRECONDITION_FAILED" : err.code,
      message: err.message,
    });
  }
  throw err;
}

const gradeSchema = z.enum(["A", "B", "C", "D", "E"]);

// W31 executor-map contract: exactly ONE registration per kind, at module
// scope of the OWNING router. An approved provision draw replays THIS exact
// draw (same tenant/amount/ref) — audit + notify identical to a direct call.
registerApprovalExecutor("provision_draw", async ({ db, approval, actorId }) => {
  const md = (approval.metadata ?? {}) as any;
  if (md.action !== "provision_draw" || typeof md.ref !== "string") {
    return { ok: false, detail: "unsupported provision_draw approval payload" };
  }
  try {
    const res = await drawFromFund(db, {
      tenantId: md.tenantId ?? null,
      amountCents: Number(md.amountCents),
      ref: md.ref,
      reason: typeof md.reason === "string" ? md.reason : "approved provision draw",
      actorId,
    });
    await writeAuditLog({
      actorId,
      actorRole: "admin",
      action: "provision.draw_executed",
      entityType: "provision_fund_ledger",
      entityId: md.ref,
      tenantId: md.tenantId ?? null,
      summary: `Provision draw ${md.amountCents} cents (ref ${md.ref}) executed after approval ${approval.id}`,
      after: { amountCents: Number(md.amountCents), ref: md.ref, balanceAfter: res.balanceAfter },
    }).catch(() => {});
    return { ok: true, reference: md.ref, detail: `balance after ${res.balanceAfter} cents` };
  } catch (err: any) {
    return { ok: false, detail: err?.message ?? String(err) };
  }
});

export const creditInsuranceRouter = router({
  /** Deterministic premium quote (integer cents, grade band table). */
  quote: moneyProcedure
    .input(z.object({
      tenantId: z.string(),
      principalCents: z.number().int().positive(),
      grade: gradeSchema,
    }))
    .query(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      return quotePremium(input.principalCents, input.grade);
    }),

  /** Bind cover on a facility (idempotent per tenant+facility). Fail-open. */
  bind: moneyProcedure
    .input(z.object({
      tenantId: z.string(),
      facilityRef: z.string().min(1).max(64),
      principalCents: z.number().int().positive(),
      grade: gradeSchema,
    }))
    .mutation(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await requireDb();
      const res = await bindPolicy(db, {
        tenantId: input.tenantId,
        facilityRef: input.facilityRef,
        principalCents: input.principalCents,
        grade: input.grade,
      });
      if (!res.ok) throw new TRPCError({ code: "PRECONDITION_FAILED", message: res.error ?? "bind failed" });
      return res;
    }),

  policies: moneyProcedure
    .input(z.object({ tenantId: z.string() }))
    .query(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await requireDb();
      return listPolicies(db, input.tenantId);
    }),

  claims: moneyProcedure
    .input(z.object({ tenantId: z.string() }))
    .query(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await requireDb();
      return listClaims(db, input.tenantId);
    }),

  /** File a claim for a default (idempotent). Fail-open on transport. */
  fileClaim: moneyProcedure
    .input(z.object({
      tenantId: z.string(),
      policyId: z.string().uuid(),
      defaultRef: z.string().min(1).max(64),
      evidence: z.object({
        ledgerRefs: z.array(z.string()).max(50).optional(),
        dunningMarkers: z.array(z.string()).max(50).optional(),
      }).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await requireDb();
      const res = await fileClaim(db, {
        tenantId: input.tenantId,
        policyId: input.policyId,
        defaultRef: input.defaultRef,
        evidence: input.evidence ?? {},
      });
      if (!res.ok) throw new TRPCError({ code: "PRECONDITION_FAILED", message: res.error ?? "claim failed" });
      return res;
    }),

  /** Resolve an under_review claim (admin adjudication; claim-first). */
  resolveClaim: adminProcedure
    .input(z.object({
      tenantId: z.string(),
      claimId: z.string().uuid(),
      decision: z.enum(["paid", "rejected"]),
      payoutCents: z.number().int().positive().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await requireDb();
      const res = await resolveClaim(db, {
        claimId: input.claimId,
        tenantId: input.tenantId,
        decision: input.decision,
        payoutCents: input.payoutCents,
      });
      if (!res.ok) throw new TRPCError({ code: "NOT_FOUND", message: "claim not found" });
      if (res.changed) {
        await writeAuditLog({
          actorId: String(ctx.user.id),
          actorRole: "admin",
          action: `credit_insurance.claim_${input.decision}`,
          entityType: "credit_insurance_claim",
          entityId: input.claimId,
          tenantId: input.tenantId,
          summary: `Claim ${input.claimId} resolved ${input.decision}${input.payoutCents ? ` (${input.payoutCents} cents)` : ""}`,
          after: { decision: input.decision, payoutCents: input.payoutCents ?? null },
        }).catch(() => {});
      }
      return res;
    }),

  // ── Feature 4: provision fund ────────────────────────────────────────────

  /** Fund balance + accrual config (tenant view). */
  provisionFund: moneyProcedure
    .input(z.object({ tenantId: z.string() }))
    .query(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await requireDb();
      const [balance, bps, ledger] = await Promise.all([
        getProvisionBalance(db, input.tenantId),
        getProvisionFundBps(db),
        listProvisionLedger(db, input.tenantId),
      ]);
      return { balanceCents: balance, accrualBps: bps, ledger };
    }),

  /**
   * Accrue into the fund from a fee event (post-commit seam helper exposed
   * for ops/reconciliation; idempotent by feeRef).
   */
  provisionAccrue: moneyProcedure
    .input(z.object({
      tenantId: z.string(),
      feeRef: z.string().min(1).max(100),
      feeCents: z.number().int().positive(),
    }))
    .mutation(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await requireDb();
      return accrueFromFeeEvent(db, { tenantId: input.tenantId, feeRef: input.feeRef, feeCents: input.feeCents });
    }),

  /**
   * Draw from the provision fund (admin-approved write-off / claim
   * shortfall). W31 threshold gate (kind 'provision_draw'); fail-closed on
   * insufficient balance; audited; admin notified.
   */
  provisionDraw: adminProcedure
    .input(z.object({
      tenantId: z.string().nullable(),
      amountCents: z.number().int().positive(),
      ref: z.string().min(1).max(100),
      reason: z.string().min(1).max(255),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await requireDb();
      try {
        // W31 threshold gate — parked requests carry the full parameter set
        // so the executor replays THIS exact draw.
        if (input.tenantId) {
          const gate = await requireApprovalIfNeeded(
            input.tenantId,
            "provision_draw",
            input.amountCents,
            input.ref,
            db,
            {
              requestedBy: String(ctx.user.id),
              reference: `prov-draw:${input.ref}`,
              metadata: {
                action: "provision_draw",
                tenantId: input.tenantId,
                amountCents: input.amountCents,
                ref: input.ref,
                reason: input.reason,
              },
            },
          );
          if (gate.approvalRequired) {
            return { pendingApproval: true as const, approvalId: gate.approvalId };
          }
        }
        const res = await drawFromFund(db, {
          tenantId: input.tenantId,
          amountCents: input.amountCents,
          ref: input.ref,
          reason: input.reason,
          actorId: String(ctx.user.id),
        });
        if (!res.duplicate) {
          await writeAuditLog({
            actorId: String(ctx.user.id),
            actorRole: "admin",
            action: "provision.draw",
            entityType: "provision_fund_ledger",
            entityId: input.ref,
            tenantId: input.tenantId,
            summary: `Provision draw ${input.amountCents} cents: ${input.reason.trim()}`,
            after: { amountCents: input.amountCents, ref: input.ref, balanceAfter: res.balanceAfter },
          }).catch(() => {});
          // Ops alert — fail-open.
          if (input.tenantId) {
            try {
              const { notifyTenantAdminWhatsApp } = await import("../services/adminAlerts");
              await notifyTenantAdminWhatsApp(db as any, input.tenantId,
                `📉 Provision fund draw of ₦${(input.amountCents / 100).toFixed(2)} approved (${input.ref}). Reason: ${input.reason.trim()}`);
            } catch { /* fail-open */ }
          }
        }
        return { pendingApproval: false as const, ...res };
      } catch (err) {
        rethrowProvision(err);
      }
    }),

  /** Post-default recovery credits the fund (idempotent). */
  provisionRecovery: moneyProcedure
    .input(z.object({
      tenantId: z.string().nullable(),
      amountCents: z.number().int().positive(),
      ref: z.string().min(1).max(100),
      note: z.string().max(500).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      if (input.tenantId) assertTenantAccess(ctx.user, input.tenantId);
      const db = await requireDb();
      return recoveryCredit(db, {
        tenantId: input.tenantId,
        amountCents: input.amountCents,
        ref: input.ref,
        note: input.note,
      });
    }),
});
// === END W57 risk-shield ===
