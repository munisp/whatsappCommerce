/**
 * Trade credit tRPC router — supplier-side facility administration and
 * buyer-side self-service views.
 *
 * TENANT ISOLATION: every procedure is gated by assertTenantAccess —
 * supplier ops require ctx.user.tenantId === supplierTenantId, buyer ops
 * require ctx.user.tenantId === buyerTenantId. Account-level mutations are
 * additionally claim-first scoped to the owning supplier inside the service
 * layer (update/setStatus include supplier_tenant_id in the WHERE), so a
 * cross-tenant account id can never be mutated even if the input tenantId
 * check were bypassed.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { adminProcedure, protectedProcedure, router, assertTenantAccess } from "../_core/trpc";
import { getDb } from "../db";
import {
  approveCreditAccountTx,
  createCreditAccountTx,
  getCreditAccountByIdTx,
  getCreditAccountTx,
  listCreditAccountsWithAgingTx,
  listLedgerTx,
  requestCreditAccountTx,
  requestLimitIncreaseTx,
  setCreditAccountStatusTx,
  updateCreditAccountTx,
  CreditAccountExistsError,
  BureauPullDeclinedError,
  applyRepaymentTx,
  suggestLimitTx,
  requestRepayment,
  FLOOR_LIMIT_CENTS,
} from "../services/tradeCredit";
import {
  confirmMandateTx,
  createMandateForTenant,
  getActiveMandateForTenantTx,
  getMandateByIdTx,
  revokeMandate,
} from "../services/payments/mandates";
import { createRepaymentLink, CreditRepayError } from "../services/creditRepayLink";
import { retrySettlement, reconcilePendingMandateCharges } from "../services/tradeCredit/capture";
import { creditAccounts } from "../../drizzle/schema";
import { and, eq, isNull } from "drizzle-orm";
import { requireApprovedKyb } from "../services/kycGate";
import { termsForScore } from "../services/tradeCredit/terms";

async function requireDb() {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
  return db;
}

/** Fetch + ownership-check an account for the supplier side. */
async function requireSupplierAccount(db: any, accountId: string, supplierTenantId: string) {
  const account = await getCreditAccountByIdTx(db, accountId);
  if (!account || account.supplierTenantId !== supplierTenantId) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Credit account not found" });
  }
  return account;
}

/** Fetch + ownership-check an account for the buyer side. */
async function requireBuyerAccount(db: any, accountId: string, buyerTenantId: string) {
  const account = await getCreditAccountByIdTx(db, accountId);
  if (!account || account.buyerTenantId !== buyerTenantId) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Credit account not found" });
  }
  return account;
}

/**
 * Resolve an ACTIVE mandate for a facility: the linked mandate when already
 * active, otherwise the buyer tenant's latest active mandate (linked to the
 * account as a side effect). Null when the buyer has no active mandate.
 */
async function resolveActiveMandate(db: any, account: { id: string; buyerTenantId: string; mandateId: string | null }) {
  if (account.mandateId) {
    const linked = await getMandateByIdTx(db, account.mandateId);
    if (linked && linked.tenantId === account.buyerTenantId && linked.status === "active") return linked;
  }
  const active = await getActiveMandateForTenantTx(db, account.buyerTenantId);
  if (active) {
    await db
      .update(creditAccounts)
      .set({ mandateId: active.id, updatedAt: new Date() })
      .where(
        and(
          eq(creditAccounts.id, account.id),
          account.mandateId
            ? eq(creditAccounts.mandateId, account.mandateId)
            : isNull(creditAccounts.mandateId),
        ),
      );
  }
  return active ?? null;
}

export const tradeCreditRouter = router({
  // ── Supplier-side ────────────────────────────────────────────────────────

  /** Create a credit facility for a buyer. Auto-scores when no explicit score given. */
  createAccount: protectedProcedure
    .input(z.object({
      supplierTenantId: z.string().min(1),
      buyerTenantId: z.string().min(1),
      limitCents: z.number().int().min(0),
      termsDays: z.number().int().min(1).max(365).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      assertTenantAccess(ctx.user, input.supplierTenantId);
      const db = await requireDb();
      try {
        return await createCreditAccountTx(db, input);
      } catch (err) {
        if (err instanceof CreditAccountExistsError) {
          throw new TRPCError({ code: "CONFLICT", message: err.message });
        }
        throw err;
      }
    }),

  /** Update limit and/or terms (claim-first scoped to the owning supplier). */
  updateAccount: protectedProcedure
    .input(z.object({
      supplierTenantId: z.string().min(1),
      accountId: z.string().min(1),
      limitCents: z.number().int().min(0).optional(),
      termsDays: z.number().int().min(1).max(365).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      assertTenantAccess(ctx.user, input.supplierTenantId);
      const db = await requireDb();
      const row = await updateCreditAccountTx(db, input);
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Credit account not found" });
      return row;
    }),

  /** Freeze / unfreeze / close a facility. */
  setAccountStatus: protectedProcedure
    .input(z.object({
      supplierTenantId: z.string().min(1),
      accountId: z.string().min(1),
      status: z.enum(["active", "frozen", "closed"]),
    }))
    .mutation(async ({ ctx, input }) => {
      assertTenantAccess(ctx.user, input.supplierTenantId);
      const db = await requireDb();
      const row = await setCreditAccountStatusTx(db, input);
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Credit account not found" });
      return row;
    }),

  /**
   * Approve a buyer-requested ('pending') facility: flips it to 'active',
   * optionally setting limit/terms in the same claim-first statement.
   * Only matches accounts the supplier owns that are still pending.
   */
  approveAccount: protectedProcedure
    .input(z.object({
      supplierTenantId: z.string().min(1),
      accountId: z.string().min(1),
      limitCents: z.number().int().min(0).optional(),
      termsDays: z.number().int().min(1).max(365).optional(),
      /**
       * W14: the buyer accepted the bureau-reporting terms
       * (BUREAU_CONSENT_TEXT in services/i18n). NOT a hard approval gate
       * (Nigeria legal review pending) — but non-consented accounts are
       * excluded from bureau reporting and a consent_missing warning is
       * emitted so ops can chase consent capture.
       */
      bureauConsent: z.boolean().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      assertTenantAccess(ctx.user, input.supplierTenantId);
      const db = await requireDb();
      // Hard KYB gate: BOTH sides of the facility must hold an approved KYB
      // application before credit is extended. The account row supplies the
      // buyer side (ownership-checked against the claiming supplier).
      const account = await requireSupplierAccount(db, input.accountId, input.supplierTenantId);
      await requireApprovedKyb(input.supplierTenantId, db);
      await requireApprovedKyb(account.buyerTenantId, db);
      // W13 mandate gate: activating a facility ABOVE the micro-credit floor
      // (₦50k) requires an ACTIVE repayment-at-source mandate from the buyer.
      // Floor-level facilities stay frictionless (no mandate needed).
      const effectiveLimit = input.limitCents ?? account.limitCents;
      if (effectiveLimit > FLOOR_LIMIT_CENTS) {
        const mandate = await resolveActiveMandate(db, account);
        if (!mandate) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message:
              "An active repayment mandate is required to activate a facility above " +
              `${FLOOR_LIMIT_CENTS / 100} naira. The buyer must complete ` +
              "tradeCredit.requestMandate + confirmMandate first.",
          });
        }
      }
      // W18: risk-based terms — when the supplier did not specify terms and
      // the account carries a scorer-produced score, derive tenor + fee from
      // the score band and snapshot them on approval. Explicit input always
      // wins; score-less accounts keep the wave-8 defaults.
      const derived = input.termsDays === undefined && account.score != null
        ? termsForScore(account.score)
        : null;
      // W18: bureau-pull gate lives inside approveCreditAccountTx
      // (BUREAU_PULL_REQUIRED=true). A hard decline surfaces as
      // PRECONDITION_FAILED with the decline reason; adapter failures never
      // reach here (fire-and-forget inside the service).
      let row: Awaited<ReturnType<typeof approveCreditAccountTx>>;
      try {
        row = await approveCreditAccountTx(db, {
          ...input,
          termsDays: input.termsDays ?? (derived && !derived.decline ? derived.tenorDays : undefined),
          feeBps: derived && !derived.decline ? derived.feeBps : undefined,
        });
      } catch (err) {
        if (err instanceof BureauPullDeclinedError) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message:
              err.reason === "consent_required"
                ? "Bureau consent is required to approve this facility (BUREAU_PULL_REQUIRED)."
                : `Facility approval declined by credit-bureau report: ${err.message}`,
          });
        }
        throw err;
      }
      if (!row) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Pending credit account not found" });
      }
      // W14: consent is advisory (not a gate) but MUST be visible — a
      // facility activated without bureau consent is excluded from bureau
      // reporting until the buyer accepts the terms.
      if (!row.bureauConsentAt) {
        console.warn(
          JSON.stringify({
            level: "warn",
            metric: "consent_missing",
            accountId: row.id,
            supplierTenantId: row.supplierTenantId,
            buyerTenantId: row.buyerTenantId,
            reason: "credit account activated without bureau-reporting consent",
          }),
        );
      }
      return { ...row, terms: termsForScore(row.score ?? 0) };
    }),

  /** Portfolio list with aging buckets. */
  listAccounts: protectedProcedure
    .input(z.object({ supplierTenantId: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      assertTenantAccess(ctx.user, input.supplierTenantId);
      const db = await requireDb();
      return listCreditAccountsWithAgingTx(db, input.supplierTenantId);
    }),

  /** Ledger for one of the supplier's accounts. */
  accountLedger: protectedProcedure
    .input(z.object({
      supplierTenantId: z.string().min(1),
      accountId: z.string().min(1),
      limit: z.number().int().min(1).max(500).optional(),
    }))
    .query(async ({ ctx, input }) => {
      assertTenantAccess(ctx.user, input.supplierTenantId);
      const db = await requireDb();
      await requireSupplierAccount(db, input.accountId, input.supplierTenantId);
      return listLedgerTx(db, input.accountId, input.limit);
    }),

  /** Deterministic limit suggestion for a buyer (see services/scoring). */
  suggestLimit: protectedProcedure
    .input(z.object({
      supplierTenantId: z.string().min(1),
      buyerTenantId: z.string().min(1),
    }))
    .query(async ({ ctx, input }) => {
      assertTenantAccess(ctx.user, input.supplierTenantId);
      const db = await requireDb();
      return suggestLimitTx(db, input.buyerTenantId, input.supplierTenantId);
    }),

  /**
   * W21: train (or retrain) this tenant's ML probability-of-default model
   * from its own credit book. Below the minimum-sample gate no model is
   * persisted and PD scoring keeps the rule proxy / global-model fallback.
   */
  trainPdModel: protectedProcedure
    .input(z.object({ tenantId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await requireDb();
      const { trainPdModelTx, PD_MODEL_PARAMS } = await import("../services/tradeCredit/mlPdScoring");
      const result = await trainPdModelTx(db, input.tenantId);
      return { ...result, minTrainSamples: PD_MODEL_PARAMS.minTrainSamples };
    }),

  /**
   * W21: latest trained PD model metadata for the tenant — its own model
   * when trained, otherwise whether the global corpus fallback is available.
   */
  pdModelStatus: protectedProcedure
    .input(z.object({ tenantId: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await requireDb();
      const { loadLatestPdModel, PD_MODEL_PARAMS } = await import("../services/tradeCredit/mlPdScoring");
      const model = await loadLatestPdModel(db, input.tenantId);
      const globalModel = model ? null : await loadLatestPdModel(db, null);
      const base = { minTrainSamples: PD_MODEL_PARAMS.minTrainSamples };
      if (model) {
        return {
          ...base,
          trained: true as const,
          scope: "tenant" as const,
          trainedAt: model.trainedAt,
          sampleCount: model.sampleCount,
          logloss: model.logloss,
          auc: model.auc,
          version: model.version,
        };
      }
      return {
        ...base,
        trained: false as const,
        scope: globalModel ? ("global" as const) : null,
        trainedAt: globalModel?.trainedAt ?? null,
        sampleCount: globalModel?.sampleCount ?? 0,
        logloss: globalModel?.logloss ?? null,
        auc: globalModel?.auc ?? null,
        version: globalModel?.version ?? null,
      };
    }),

  /** Record a buyer repayment (partial allowed; over-repayment refused). */
  recordRepayment: protectedProcedure
    .input(z.object({
      supplierTenantId: z.string().min(1),
      accountId: z.string().min(1),
      amountCents: z.number().int().positive(),
      ref: z.string().min(1).max(128),
    }))
    .mutation(async ({ ctx, input }) => {
      assertTenantAccess(ctx.user, input.supplierTenantId);
      const db = await requireDb();
      await requireSupplierAccount(db, input.accountId, input.supplierTenantId);
      const res = await applyRepaymentTx(db, {
        accountId: input.accountId,
        amountCents: input.amountCents,
        ref: input.ref,
      });
      if (!res.ok) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Repayment refused (exceeds outstanding balance)",
        });
      }
      return res;
    }),

  // ── Buyer-side ───────────────────────────────────────────────────────────

  /**
   * Buyer asks a supplier to open a credit facility: creates the account in
   * 'pending' status (zero limit — cannot be drawn on until the supplier
   * approves via approveAccount/updateAccount). CONFLICT when a facility
   * (of any status) already exists for the pair.
   */
  requestAccount: protectedProcedure
    .input(z.object({
      buyerTenantId: z.string().min(1),
      supplierTenantId: z.string().min(1),
      note: z.string().max(500).optional(),
      /** W14: buyer accepted the bureau-reporting terms (BUREAU_CONSENT_TEXT). */
      bureauConsent: z.boolean().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      assertTenantAccess(ctx.user, input.buyerTenantId);
      const db = await requireDb();
      try {
        return await requestCreditAccountTx(db, input);
      } catch (err) {
        if (err instanceof CreditAccountExistsError) {
          throw new TRPCError({ code: "CONFLICT", message: err.message });
        }
        throw err;
      }
    }),

  /** The buyer's own facilities across suppliers, with outstanding. */
  myAccounts: protectedProcedure
    .input(z.object({ buyerTenantId: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      assertTenantAccess(ctx.user, input.buyerTenantId);
      const db = await requireDb();
      return db
        .select()
        .from(creditAccounts)
        .where(eq(creditAccounts.buyerTenantId, input.buyerTenantId));
    }),

  /** One of the buyer's own accounts (single facility view). */
  myAccount: protectedProcedure
    .input(z.object({
      buyerTenantId: z.string().min(1),
      supplierTenantId: z.string().min(1),
    }))
    .query(async ({ ctx, input }) => {
      assertTenantAccess(ctx.user, input.buyerTenantId);
      const db = await requireDb();
      return getCreditAccountTx(db, input.supplierTenantId, input.buyerTenantId);
    }),

  /** Ledger for one of the buyer's own facilities. */
  myLedger: protectedProcedure
    .input(z.object({
      buyerTenantId: z.string().min(1),
      accountId: z.string().min(1),
      limit: z.number().int().min(1).max(500).optional(),
    }))
    .query(async ({ ctx, input }) => {
      assertTenantAccess(ctx.user, input.buyerTenantId);
      const db = await requireDb();
      await requireBuyerAccount(db, input.accountId, input.buyerTenantId);
      return listLedgerTx(db, input.accountId, input.limit);
    }),

  /**
   * Request a limit increase — writes a zero-amount 'adjustment' ledger note
   * (ref `limitreq:<ts>`) the supplier sees in their ledger view.
   */
  requestLimitIncrease: protectedProcedure
    .input(z.object({
      buyerTenantId: z.string().min(1),
      accountId: z.string().min(1),
      requestedLimitCents: z.number().int().positive(),
      note: z.string().max(500).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      assertTenantAccess(ctx.user, input.buyerTenantId);
      const db = await requireDb();
      const account = await requireBuyerAccount(db, input.accountId, input.buyerTenantId);
      if (account.status === "closed") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Credit account is closed" });
      }
      return requestLimitIncreaseTx(db, {
        accountId: input.accountId,
        requestedLimitCents: input.requestedLimitCents,
        note: input.note,
      });
    }),

  // ── W13: repayment-at-source mandates ────────────────────────────────────

  /**
   * Buyer starts a repayment mandate for one of their facilities: delegates
   * to the first mandate-capable payment provider, persists a 'pending'
   * payment_mandates row and links it to the facility. The mandate flips to
   * 'active' via confirmMandate (explicit confirm or authorization callback).
   */
  requestMandate: protectedProcedure
    .input(z.object({
      buyerTenantId: z.string().min(1),
      accountId: z.string().min(1),
      amountLimitCents: z.number().int().positive().optional(),
      email: z.string().email().optional(),
      phone: z.string().max(30).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      assertTenantAccess(ctx.user, input.buyerTenantId);
      const db = await requireDb();
      const account = await requireBuyerAccount(db, input.accountId, input.buyerTenantId);
      if (account.status === "closed") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Credit account is closed" });
      }
      const res = await createMandateForTenant(db, {
        tenantId: input.buyerTenantId,
        customerRef: account.id,
        amountLimitCents: input.amountLimitCents,
        email: input.email,
        phone: input.phone,
        metadata: { type: "credit_mandate", accountId: account.id },
      });
      if (!res.ok || !res.mandateId) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `Could not create a repayment mandate: ${res.error ?? "no mandate-capable provider"}`,
        });
      }
      // Link the mandate to the facility (claim-first on no prior link).
      await db
        .update(creditAccounts)
        .set({ mandateId: res.mandateId, updatedAt: new Date() })
        .where(and(eq(creditAccounts.id, account.id), isNull(creditAccounts.mandateId)));
      return res;
    }),

  /**
   * Buyer confirms a pending mandate after completing the provider's
   * authorization step (or the authorization callback lands): claim-first
   * pending → active.
   */
  confirmMandate: protectedProcedure
    .input(z.object({
      buyerTenantId: z.string().min(1),
      mandateId: z.string().min(1),
    }))
    .mutation(async ({ ctx, input }) => {
      assertTenantAccess(ctx.user, input.buyerTenantId);
      const db = await requireDb();
      const row = await confirmMandateTx(db, { tenantId: input.buyerTenantId, mandateId: input.mandateId });
      if (!row) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Pending mandate not found" });
      }
      return row;
    }),

  /** Buyer revokes their mandate (provider revoke best-effort + local flip). */
  revokeMandate: protectedProcedure
    .input(z.object({
      buyerTenantId: z.string().min(1),
      mandateId: z.string().min(1),
    }))
    .mutation(async ({ ctx, input }) => {
      assertTenantAccess(ctx.user, input.buyerTenantId);
      const db = await requireDb();
      const res = await revokeMandate(db, { tenantId: input.buyerTenantId, mandateId: input.mandateId });
      if (!res.ok) throw new TRPCError({ code: "NOT_FOUND", message: res.error ?? "Mandate not found" });
      // Detach from any facility linked to this mandate.
      await db
        .update(creditAccounts)
        .set({ mandateId: null, updatedAt: new Date() })
        .where(and(eq(creditAccounts.buyerTenantId, input.buyerTenantId), eq(creditAccounts.mandateId, input.mandateId)));
      return res;
    }),

  /**
   * Buyer-initiated repayment (W13): charges the linked mandate AT SOURCE
   * when active (exactly-once reference claim → FIFO settlement). On charge
   * failure — or when no mandate is linked — falls back to the payment-link
   * flow and returns the link for the buyer to pay manually.
   */
  initiateRepayment: protectedProcedure
    .input(z.object({
      buyerTenantId: z.string().min(1),
      accountId: z.string().min(1),
      amountCents: z.number().int().positive(),
      customerPhone: z.string().max(30).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      assertTenantAccess(ctx.user, input.buyerTenantId);
      const db = await requireDb();
      const account = await requireBuyerAccount(db, input.accountId, input.buyerTenantId);
      const res = await requestRepayment({
        accountId: input.accountId,
        amountCents: input.amountCents,
      });
      if (res.ok) return res;
      if (res.mode !== "fallback") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Repayment refused: ${res.reason}${res.error ? ` (${res.error})` : ""}`,
        });
      }
      // Payment-link fallback (charge failed or no mandate linked).
      try {
        const link = await createRepaymentLink(db, {
          buyerTenantId: input.buyerTenantId,
          accountId: account.id,
          amountCents: input.amountCents,
          customerPhone: input.customerPhone ?? null,
        });
        return {
          mode: "payment_link" as const,
          reason: res.reason,
          mandateError: res.error ?? null,
          paymentUrl: link.paymentUrl,
          instructions: link.instructions,
          provider: link.provider,
          reference: link.reference,
          outstandingAfter: account.outstandingCents,
        };
      } catch (err) {
        if (err instanceof CreditRepayError) {
          throw new TRPCError({ code: "BAD_REQUEST", message: err.message });
        }
        throw err;
      }
    }),

  // ── W14: platform ops ────────────────────────────────────────────────────

  /**
   * Admin (platform-ops): re-attempt settlement for a repayment whose mandate
   * charge SUCCEEDED but whose FIFO settlement failed (money moved, no
   * settlement — surfaced as a CRITICAL capture + a durable settlement_retry
   * ledger marker). Exactly-once: a reference that already has a repayment
   * ledger row is a no-op ('already_settled'); the pending marker is claimed
   * first so concurrent retries cannot settle twice.
   */
  retrySettlement: adminProcedure
    .input(z.object({
      accountId: z.string().min(1),
      reference: z.string().min(1).max(128),
      amountCents: z.number().int().positive().optional(),
    }))
    .mutation(async ({ input }) => {
      const db = await requireDb();
      return retrySettlement(db, input);
    }),

  /**
   * Admin (platform-ops): sweep pending mandate charges (A1-02/F-03). For
   * each pending mandate_charges row the provider's READ-ONLY fetchStatus is
   * probed — success settles exactly once via the claim-first FIFO path
   * (0052 backstop), failure releases the exactly-once claim and notifies
   * the buyer, unknown/pending is left for the next sweep. The charge is
   * NEVER blind-retried. Scheduler wiring is owned separately (R4).
   */
  reconcileMandateCharges: adminProcedure
    .input(z.object({ limit: z.number().int().min(1).max(500).optional() }).optional())
    .mutation(async ({ input }) => {
      const db = await requireDb();
      return reconcilePendingMandateCharges(db, { limit: input?.limit });
    }),
});
