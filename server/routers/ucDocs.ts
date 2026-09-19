// === W46 uc-docs ===
/**
 * W46 uc-docs (Coder D) — UC-12 customer statements, UC-19 proforma
 * invoices, UC-20 agents/commissions, UC-18 tier-pricing quote helper.
 *
 * Mutations → moneyProcedure (owner|operator); reads → analystProcedure.
 * Every state mutation additionally gates on assertTenantActive (tenant
 * lifecycle) after resolving the tenant row. Service-layer code-tagged
 * errors are translated into tRPC errors (same pattern as taxStatements).
 */
import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { analystProcedure, moneyProcedure, publicProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import { agentCommissions, agentCommissionStatements, agents, customerStatements, proformaInvoices, tenants } from "../../drizzle/schema";

async function requireDb() {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
  return db;
}

function rethrow(err: any): never {
  if (err instanceof TRPCError) throw err;
  const code = ["NOT_FOUND", "CONFLICT", "FORBIDDEN"].includes(err?.code) ? err.code : "BAD_REQUEST";
  throw new TRPCError({ code, message: err?.message ?? String(err) });
}

/** assertTenantActive on state mutations (W46 cross-cutting invariant). */
async function assertActive(db: any, tenantId: string) {
  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  if (!tenant) throw new TRPCError({ code: "NOT_FOUND", message: "tenant not found" });
  const { assertTenantActive } = await import("../services/tenantGuard");
  assertTenantActive(tenant);
}

const periodInput = { from: z.coerce.date(), to: z.coerce.date() };

export const ucDocsRouter = router({
  // ── UC-12: customer statements of account ────────────────────────────────
  generateCustomerStatement: moneyProcedure
    .input(z.object({ tenantId: z.string(), customerPhone: z.string().min(3), customerName: z.string().optional(), ...periodInput }))
    .mutation(async ({ input }) => {
      const db = await requireDb();
      await assertActive(db, input.tenantId);
      try {
        const { generateCustomerStatement } = await import("../services/customerStatements");
        return await generateCustomerStatement(db, input);
      } catch (e) { rethrow(e); }
    }),

  sendCustomerStatement: moneyProcedure
    .input(z.object({ tenantId: z.string(), statementId: z.string(), phone: z.string().optional() }))
    .mutation(async ({ input }) => {
      const db = await requireDb();
      await assertActive(db, input.tenantId);
      try {
        const { sendCustomerStatement } = await import("../services/customerStatements");
        return await sendCustomerStatement(db, input);
      } catch (e) { rethrow(e); }
    }),

  listCustomerStatements: analystProcedure
    .input(z.object({ tenantId: z.string(), customerPhone: z.string().optional(), limit: z.number().int().min(1).max(200).default(50) }))
    .query(async ({ input }) => {
      const db = await requireDb();
      const conds = [eq(customerStatements.tenantId, input.tenantId)];
      if (input.customerPhone) conds.push(eq(customerStatements.customerPhone, input.customerPhone));
      return db.select().from(customerStatements).where(and(...conds)).orderBy(desc(customerStatements.createdAt)).limit(input.limit);
    }),

  // ── UC-19: proforma invoices ─────────────────────────────────────────────
  createProforma: moneyProcedure
    .input(z.object({
      tenantId: z.string(),
      customerName: z.string().optional(),
      customerPhone: z.string().optional(),
      customerEmail: z.string().email().optional(),
      items: z.array(z.object({
        productId: z.string().nullish(),
        name: z.string().min(1),
        quantity: z.number().int().positive(),
        unitPriceCents: z.number().int().min(0),
      })).min(1),
      currency: z.string().length(3).default("NGN"),
      validDays: z.number().int().min(1).max(365).optional(),
      rfqId: z.string().nullish(),
      notes: z.string().optional(),
      metadata: z.record(z.string(), z.unknown()).nullish(),
    }))
    .mutation(async ({ input }) => {
      const db = await requireDb();
      await assertActive(db, input.tenantId);
      try {
        const { createProforma } = await import("../services/proformaInvoices");
        return await createProforma(db, input);
      } catch (e) { rethrow(e); }
    }),

  sendProforma: moneyProcedure
    .input(z.object({ tenantId: z.string(), proformaId: z.string(), phone: z.string().optional() }))
    .mutation(async ({ input }) => {
      const db = await requireDb();
      await assertActive(db, input.tenantId);
      try {
        const { sendProforma } = await import("../services/proformaInvoices");
        return await sendProforma(db, input);
      } catch (e) { rethrow(e); }
    }),

  acceptProforma: moneyProcedure
    .input(z.object({ tenantId: z.string(), proformaId: z.string() }))
    .mutation(async ({ input }) => {
      const db = await requireDb();
      await assertActive(db, input.tenantId);
      try {
        const { acceptProforma } = await import("../services/proformaInvoices");
        return await acceptProforma(db, input);
      } catch (e) { rethrow(e); }
    }),

  convertProforma: moneyProcedure
    .input(z.object({ tenantId: z.string(), proformaId: z.string() }))
    .mutation(async ({ input }) => {
      const db = await requireDb();
      await assertActive(db, input.tenantId);
      try {
        const { convertProformaToOrder } = await import("../services/proformaInvoices");
        return await convertProformaToOrder(db, input);
      } catch (e) { rethrow(e); }
    }),

  cancelProforma: moneyProcedure
    .input(z.object({ tenantId: z.string(), proformaId: z.string() }))
    .mutation(async ({ input }) => {
      const db = await requireDb();
      await assertActive(db, input.tenantId);
      try {
        const { cancelProforma } = await import("../services/proformaInvoices");
        return await cancelProforma(db, input);
      } catch (e) { rethrow(e); }
    }),

  listProformas: analystProcedure
    .input(z.object({ tenantId: z.string(), status: z.string().optional(), limit: z.number().int().min(1).max(200).default(50) }))
    .query(async ({ input }) => {
      const db = await requireDb();
      const conds = [eq(proformaInvoices.tenantId, input.tenantId)];
      if (input.status) conds.push(eq(proformaInvoices.status, input.status));
      return db.select().from(proformaInvoices).where(and(...conds)).orderBy(desc(proformaInvoices.createdAt)).limit(input.limit);
    }),

  expireProformas: moneyProcedure
    .input(z.object({ tenantId: z.string() }))
    .mutation(async ({ input }) => {
      const db = await requireDb();
      await assertActive(db, input.tenantId);
      const { expireProformas } = await import("../services/proformaInvoices");
      return { expired: await expireProformas(db) };
    }),

  // ── UC-20: agents / resellers ────────────────────────────────────────────
  upsertAgent: moneyProcedure
    .input(z.object({
      tenantId: z.string(),
      name: z.string().min(1),
      phone: z.string().min(3),
      code: z.string().min(2).max(32),
      commissionBps: z.number().int().min(0).max(10000),
      status: z.enum(["active", "suspended"]).optional(),
      metadata: z.record(z.string(), z.unknown()).nullish(),
      // === W47 stakeholders === ONB-S-11: payout-phone reroute step-up.
      stepUpChallengeId: z.string().uuid().optional(),
      stepUpOtp: z.string().length(6).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await requireDb();
      await assertActive(db, input.tenantId);
      try {
        // === W47 stakeholders === ONB-S-11: agent mint/update + payout are
        // OWNER-only (operators/finance managed them in W46 — that allowed
        // in-role self-dealing). Platform admins bypass.
        if (ctx.user.role !== "admin" && (ctx as any).membership?.role !== "owner") {
          throw new TRPCError({ code: "FORBIDDEN", message: "Agent management requires the tenant owner role" });
        }
        // Payout-reroute guard: changing the phone of an agent that already
        // has paid commissions requires a payout_change step-up OTP.
        const { findAgentByCode, phonesMatch } = await import("../services/agents");
        const existing = await findAgentByCode(db, input.tenantId, input.code);
        let phoneChangeAuthorized = false;
        if (existing && !phonesMatch(existing.phone, input.phone)) {
          const [paid] = await db.select({ id: agentCommissions.id }).from(agentCommissions)
            .where(and(eq(agentCommissions.agentId, existing.id), eq(agentCommissions.status, "paid"))).limit(1);
          if (paid) {
            const { requireStepUp } = await import("../services/stepUp");
            await requireStepUp(db, {
              required: true,
              tenantId: input.tenantId,
              userId: ctx.user.id,
              purpose: "payout_change",
              stepUpChallengeId: input.stepUpChallengeId,
              stepUpOtp: input.stepUpOtp,
            });
            phoneChangeAuthorized = true;
            const { writeAuditLog } = await import("./audit");
            await writeAuditLog({
              actorId: String(ctx.user.id), actorRole: ctx.user.role,
              action: "agent.payoutPhoneChanged", entityType: "agent", entityId: existing.id,
              tenantId: input.tenantId,
              summary: `Agent ${existing.code} payout phone changed after paid commissions (step-up verified)`,
              before: { phone: existing.phone }, after: { phone: input.phone },
            });
          }
        }
        // === END W47 stakeholders ===
        const { upsertAgent } = await import("../services/agents");
        return await upsertAgent(db, { ...input, phoneChangeAuthorized });
      } catch (e) { rethrow(e); }
    }),

  listAgents: analystProcedure
    .input(z.object({ tenantId: z.string() }))
    .query(async ({ input }) => {
      const db = await requireDb();
      return db.select().from(agents).where(eq(agents.tenantId, input.tenantId)).orderBy(desc(agents.createdAt));
    }),

  attributeOrderToAgent: moneyProcedure
    .input(z.object({ tenantId: z.string(), orderId: z.string(), agentCode: z.string() }))
    .mutation(async ({ input }) => {
      const db = await requireDb();
      await assertActive(db, input.tenantId);
      try {
        const { attributeOrderToAgent } = await import("../services/agents");
        return await attributeOrderToAgent(db, input);
      } catch (e) { rethrow(e); }
    }),

  sweepAgentCommissions: moneyProcedure
    .input(z.object({ tenantId: z.string() }))
    .mutation(async ({ input }) => {
      const db = await requireDb();
      await assertActive(db, input.tenantId);
      const { sweepAgentCommissions } = await import("../services/agents");
      return sweepAgentCommissions(db, input.tenantId);
    }),

  listAgentCommissions: analystProcedure
    .input(z.object({ tenantId: z.string(), agentId: z.string().optional(), status: z.string().optional(), limit: z.number().int().min(1).max(200).default(100) }))
    .query(async ({ input }) => {
      const db = await requireDb();
      const conds = [eq(agentCommissions.tenantId, input.tenantId)];
      if (input.agentId) conds.push(eq(agentCommissions.agentId, input.agentId));
      if (input.status) conds.push(eq(agentCommissions.status, input.status));
      return db.select().from(agentCommissions).where(and(...conds)).orderBy(desc(agentCommissions.createdAt)).limit(input.limit);
    }),

  generateCommissionStatement: moneyProcedure
    .input(z.object({ tenantId: z.string(), agentId: z.string(), ...periodInput }))
    .mutation(async ({ input }) => {
      const db = await requireDb();
      await assertActive(db, input.tenantId);
      try {
        const { generateCommissionStatement } = await import("../services/agents");
        return await generateCommissionStatement(db, input);
      } catch (e) { rethrow(e); }
    }),

  sendCommissionStatement: moneyProcedure
    .input(z.object({ tenantId: z.string(), statementId: z.string() }))
    .mutation(async ({ input }) => {
      const db = await requireDb();
      await assertActive(db, input.tenantId);
      try {
        const { sendCommissionStatement } = await import("../services/agents");
        return await sendCommissionStatement(db, input);
      } catch (e) { rethrow(e); }
    }),

  payCommissionStatement: moneyProcedure
    .input(z.object({ tenantId: z.string(), statementId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const db = await requireDb();
      await assertActive(db, input.tenantId);
      try {
        // === W47 stakeholders === ONB-S-11: commission payout is OWNER-only.
        if (ctx.user.role !== "admin" && (ctx as any).membership?.role !== "owner") {
          throw new TRPCError({ code: "FORBIDDEN", message: "Agent commission payout requires the tenant owner role" });
        }
        // === END W47 stakeholders ===
        const { payCommissionStatement } = await import("../services/agents");
        return await payCommissionStatement(db, input);
      } catch (e) { rethrow(e); }
    }),

  // === W47 stakeholders === ONB-S-12: agent-facing acknowledgment surface.
  /**
   * An agent queries their OWN commission statements with a phone_identity
   * proof (phoneAuth OTP) for their registered phone — agents no longer
   * need merchant staff to confirm what they're owed.
   */
  agentMyStatements: publicProcedure
    .input(z.object({ tenantId: z.string(), identityProof: z.string().min(10) }))
    .query(async ({ input }) => {
      const db = await requireDb();
      const jwt = (await import("jsonwebtoken")).default;
      const { ENV } = await import("../_core/env");
      let proof: any;
      try {
        proof = jwt.verify(input.identityProof, ENV.jwtSecret);
      } catch {
        throw new TRPCError({ code: "UNAUTHORIZED", message: "Identity proof is invalid or expired — re-verify your phone." });
      }
      if (proof?.type !== "phone_identity" || typeof proof.phone !== "string") {
        throw new TRPCError({ code: "UNAUTHORIZED", message: "Identity proof is not a phone-identity assertion." });
      }
      const digits = (p: string) => p.replace(/\D/g, "");
      const agentRows = await db.select().from(agents).where(eq(agents.tenantId, input.tenantId));
      const mine = agentRows.filter((a) => digits(a.phone) === digits(proof.phone));
      if (!mine.length) return { agent: null, statements: [] };
      const mineIds = mine.map((a) => a.id);
      const rows = await db.select().from(agentCommissionStatements)
        .where(and(eq(agentCommissionStatements.tenantId, input.tenantId)))
        .orderBy(desc(agentCommissionStatements.createdAt)).limit(100);
      return {
        agent: { name: mine[0].name, code: mine[0].code, status: mine[0].status },
        statements: rows.filter((r) => mineIds.includes(r.agentId)).map((r) => ({
          id: r.id, status: r.status, currency: r.currency, totalCents: r.totalCents,
          commissionCount: r.commissionCount, periodStart: r.periodStart, periodEnd: r.periodEnd, paidAt: r.paidAt,
        })),
      };
    }),
  // === END W47 stakeholders ===

  listCommissionStatements: analystProcedure
    .input(z.object({ tenantId: z.string(), agentId: z.string().optional(), limit: z.number().int().min(1).max(200).default(50) }))
    .query(async ({ input }) => {
      const db = await requireDb();
      const conds = [eq(agentCommissionStatements.tenantId, input.tenantId)];
      if (input.agentId) conds.push(eq(agentCommissionStatements.agentId, input.agentId));
      return db.select().from(agentCommissionStatements).where(and(...conds)).orderBy(desc(agentCommissionStatements.createdAt)).limit(input.limit);
    }),

  // ── UC-18: tier resolution at quote time ─────────────────────────────────
  quoteForBuyer: analystProcedure
    .input(z.object({
      tenantId: z.string(),
      phone: z.string().optional(),
      buyerType: z.enum(["retail", "wholesale", "distributor", "government"]).optional(),
      items: z.array(z.object({ productId: z.string(), quantity: z.number().int().positive() })).min(1),
    }))
    .query(async ({ input }) => {
      const db = await requireDb();
      const { quoteItemsForBuyer } = await import("../services/tierPricing");
      return quoteItemsForBuyer(db, input);
    }),
});
// === END W46 uc-docs ===
