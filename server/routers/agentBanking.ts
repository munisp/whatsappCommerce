// === W59 banking-pos ===
/**
 * W59 banking-pos (Feature 2) — agent banking router (moneyProcedure +
 * assertTenantAccess + capability flag settings.agentBanking.enabled).
 *
 *   cashIn / cashOut  — atomic CICO (see services/agentBanking.ts for the
 *                       money contract); reference is the idempotency key.
 *   transactions      — recent CICO ledger rows.
 *   floatSummary      — float balance, low-float flag, today totals.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { assertTenantAccess, moneyProcedure, router } from "../_core/trpc";
import { getDb } from "../db";

async function requireDb() {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
  return db;
}

const cicoInput = z.object({
  tenantId: z.string(), // the AGENT tenant
  customerPhone: z.string().min(7).max(20),
  amountCents: z.number().int().positive(),
  feeCents: z.number().int().min(0).optional(),
  reference: z.string().min(4).max(64), // client idempotency key (stored as CICO-<reference>)
});

export const agentBankingRouter = router({
  cashIn: moneyProcedure
    .input(cicoInput)
    .mutation(async ({ input, ctx }) => {
      const db = await requireDb();
      assertTenantAccess(ctx.user, input.tenantId);
      const { assertAgentBankingEnabled, executeCico } = await import("../services/agentBanking");
      await assertAgentBankingEnabled(db, input.tenantId);
      return executeCico(db, {
        agentTenantId: input.tenantId,
        customerPhone: input.customerPhone,
        kind: "cash_in",
        amountCents: input.amountCents,
        feeCents: input.feeCents,
        clientRef: input.reference,
      });
    }),

  cashOut: moneyProcedure
    .input(cicoInput)
    .mutation(async ({ input, ctx }) => {
      const db = await requireDb();
      assertTenantAccess(ctx.user, input.tenantId);
      const { assertAgentBankingEnabled, executeCico } = await import("../services/agentBanking");
      await assertAgentBankingEnabled(db, input.tenantId);
      return executeCico(db, {
        agentTenantId: input.tenantId,
        customerPhone: input.customerPhone,
        kind: "cash_out",
        amountCents: input.amountCents,
        feeCents: input.feeCents,
        clientRef: input.reference,
      });
    }),

  transactions: moneyProcedure
    .input(z.object({ tenantId: z.string(), limit: z.number().int().min(1).max(200).default(50) }))
    .query(async ({ input, ctx }) => {
      const db = await requireDb();
      assertTenantAccess(ctx.user, input.tenantId);
      const { listCicoTransactions } = await import("../services/agentBanking");
      return listCicoTransactions(db, input.tenantId, input.limit);
    }),

  floatSummary: moneyProcedure
    .input(z.object({ tenantId: z.string() }))
    .query(async ({ input, ctx }) => {
      const db = await requireDb();
      assertTenantAccess(ctx.user, input.tenantId);
      const { floatSummary } = await import("../services/agentBanking");
      return floatSummary(db, input.tenantId);
    }),
});
