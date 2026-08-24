/**
 * server/routers/savings.ts — W27 (Coder G) routers:
 *   stokvel  — group savings circles (tenant-guarded mgmt + HMAC-token member views)
 *   insurance — micro-insurance products/quotes/policies/claims
 *   vouchers — government/NGO voucher programs, issuance, redemption, issuer reports
 *
 * Authz: every tenant procedure is protectedProcedure + tenantId in input +
 * assertTenantAccess. Public procedures follow the tracking.ts exemplar:
 * bearer capability tokens (HMAC, timing-safe) returning minimal views; a
 * voucher code is itself a 128-bit bearer secret and is only ever acted on
 * together with the registered recipient phone.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { adminProcedure, assertTenantAccess, protectedProcedure, publicProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import { orders } from "../../drizzle/schema";
import * as stokvel from "../services/stokvel";
import * as insurance from "../services/insurance";
import * as vouchers from "../services/vouchers";
import { VoucherError } from "../services/vouchers";

const tenantInput = { tenantId: z.string().min(1).max(36) };
const phone = z.string().regex(/^\+?\d{7,15}$/, "invalid phone");

async function dbOrThrow() {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
  return db;
}

function voucherTrpcError(e: unknown): never {
  if (e instanceof VoucherError) {
    const code = e.code === "NOT_FOUND" ? "NOT_FOUND"
      : e.code === "BAD_INPUT" || e.code === "BUDGET" ? "BAD_REQUEST"
      : e.code === "REDEEMED" || e.code === "INELIGIBLE" || e.code === "CATEGORY" || e.code === "EXPIRED" || e.code === "INACTIVE"
        ? "FORBIDDEN" : "INTERNAL_SERVER_ERROR";
    throw new TRPCError({ code, message: e.message });
  }
  throw e;
}

function svcError(e: unknown): never {
  if (e instanceof VoucherError) voucherTrpcError(e);
  const msg = e instanceof Error ? e.message : String(e);
  if (/not found|unknown/i.test(msg)) throw new TRPCError({ code: "NOT_FOUND", message: msg });
  throw new TRPCError({ code: "BAD_REQUEST", message: msg });
}

// ── Stokvel circles ──────────────────────────────────────────────────────────
export const stokvelRouter = router({
  createCircle: protectedProcedure
    .input(z.object({
      ...tenantInput,
      name: z.string().min(1).max(160),
      contributionAmountCents: z.number().int().positive(),
      frequency: z.enum(["weekly", "monthly"]),
      currency: z.string().length(3).optional(),
      members: z.array(z.object({ phone, name: z.string().max(160).optional() })).min(2).max(50),
      createdByPhone: phone.optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      try {
        return await stokvel.createCircle(await dbOrThrow(), input);
      } catch (e) { svcError(e); }
    }),

  listCircles: protectedProcedure
    .input(z.object(tenantInput))
    .query(async ({ ctx, input }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await dbOrThrow();
      const { stokvelCircles } = await import("../../drizzle/schema");
      return db.select().from(stokvelCircles).where(eq(stokvelCircles.tenantId, input.tenantId));
    }),

  statement: protectedProcedure
    .input(z.object({ ...tenantInput, circleId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const s = await stokvel.circleStatement(await dbOrThrow(), input.tenantId, input.circleId);
      if (!s) throw new TRPCError({ code: "NOT_FOUND", message: "circle not found" });
      return s;
    }),

  recordContribution: protectedProcedure
    .input(z.object({
      ...tenantInput, circleId: z.string().uuid(), phone, paymentRef: z.string().max(128).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      try {
        return await stokvel.recordContribution(await dbOrThrow(), input);
      } catch (e) { svcError(e); }
    }),

  markMissed: protectedProcedure
    .input(z.object({ ...tenantInput }))
    .mutation(async ({ ctx, input }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      return { missed: await stokvel.markMissedContributions(await dbOrThrow(), { tenantId: input.tenantId }) };
    }),

  /** W30 (V1#1): reconciliation surface — retry payouts whose wallet credit failed. */
  retryPendingPayouts: protectedProcedure
    .input(z.object({ ...tenantInput }))
    .mutation(async ({ ctx, input }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const r = await stokvel.retryPendingPayouts(await dbOrThrow(), { tenantId: input.tenantId });
      return { settled: r.settled.length, stillPending: r.stillPending.length };
    }),

  /** Member capability token for public statement views (tenant staff only). */
  memberToken: protectedProcedure
    .input(z.object({ ...tenantInput, memberId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      return { token: stokvel.generateMemberToken(input.memberId) };
    }),

  /**
   * PUBLIC (hardened, tracking.ts exemplar): member statement by HMAC bearer
   * token. Returns the member's own circle view — no other members' data
   * beyond name/phone mask-free rotation order (phones are the circle's
   * shared knowledge by design of a stokvel; nothing else is exposed).
   */
  memberStatement: publicProcedure
    .input(z.object({ token: z.string().min(10).max(128) }))
    .query(async ({ input }) => {
      const memberId = stokvel.verifyMemberToken(input.token);
      if (!memberId) throw new TRPCError({ code: "NOT_FOUND", message: "Invalid circle link" });
      const db = await dbOrThrow();
      const { stokvelMembers } = await import("../../drizzle/schema");
      const [member] = await db.select().from(stokvelMembers).where(eq(stokvelMembers.id, memberId)).limit(1);
      if (!member) throw new TRPCError({ code: "NOT_FOUND", message: "Invalid circle link" });
      const s = await stokvel.circleStatement(db, member.tenantId, member.circleId);
      if (!s) throw new TRPCError({ code: "NOT_FOUND", message: "circle not found" });
      return {
        circleName: s.circle.name,
        status: s.circle.status,
        contributionAmountCents: s.circle.contributionAmountCents,
        currency: s.circle.currency,
        frequency: s.circle.frequency,
        currentCycle: s.circle.currentCycle,
        members: s.members.map((m: any) => ({ rotationPosition: m.rotationPosition, name: m.name, phone: m.phone, status: m.status })),
        myContributions: s.contributions.filter((c: any) => c.memberId === memberId),
        payouts: s.payouts.map((p: any) => ({ cycle: p.cycle, phone: p.phone, amountCents: p.amountCents, status: p.status })),
      };
    }),
});

// ── Micro-insurance ──────────────────────────────────────────────────────────
export const insuranceRouter = router({
  upsertProduct: protectedProcedure
    .input(z.object({
      ...tenantInput,
      id: z.string().min(1).max(64),
      name: z.string().min(1).max(160),
      description: z.string().max(2000).optional(),
      premiumBps: z.number().int().min(0).max(10_000).optional(),
      flatPremiumCents: z.number().int().min(0).optional(),
      coverageCents: z.number().int().positive(),
      active: z.boolean().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      try { return await insurance.upsertProduct(await dbOrThrow(), input); } catch (e) { svcError(e); }
    }),

  listProducts: protectedProcedure
    .input(z.object({ ...tenantInput, activeOnly: z.boolean().default(true) }))
    .query(async ({ ctx, input }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      return insurance.listProducts(await dbOrThrow(), input.tenantId, input.activeOnly);
    }),

  quote: protectedProcedure
    .input(z.object({
      ...tenantInput,
      productId: z.string().min(1).max(64),
      orderId: z.string().max(36).optional(),
      holderPhone: phone.optional(),
      orderAmountCents: z.number().int().min(0),
      currency: z.string().length(3).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      try { return await insurance.quoteForOrder(await dbOrThrow(), input); } catch (e) { svcError(e); }
    }),

  bind: protectedProcedure
    .input(z.object({ ...tenantInput, quoteId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      try { return await insurance.bindQuote(await dbOrThrow(), input); } catch (e) { svcError(e); }
    }),

  fileClaim: protectedProcedure
    .input(z.object({ ...tenantInput, policyId: z.string().uuid(), reason: z.string().min(1).max(1000) }))
    .mutation(async ({ ctx, input }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      try { return await insurance.fileClaim(await dbOrThrow(), { ...input, trigger: "manual" }); } catch (e) { svcError(e); }
    }),

  /**
   * Parametric event hook. W30 (V1#2): admin-only — a parametric event can
   * file full-coverage claims against any active policy in the tenant, so it
   * must never be callable by an ordinary tenant user. Real event sources
   * (courier/weather webhooks) should call services/insurance
   * .handleParametricEvent directly server-side.
   */
  parametricEvent: adminProcedure
    .input(z.object({
      ...tenantInput,
      event: z.object({ type: z.string().min(1).max(64), orderId: z.string().max(36).optional() }),
    }))
    .mutation(async ({ input }) => {
      try { return await insurance.handleParametricEvent(await dbOrThrow(), input); } catch (e) { svcError(e); }
    }),

  /**
   * W30 (V1#2): manual ops payout confirm. Claims are never auto-paid — an
   * approved claim sits at `pending_payout` until ops has actually disbursed
   * (evidence note required) and confirms here. Guarded single flip.
   */
  confirmPayout: adminProcedure
    .input(z.object({
      ...tenantInput,
      claimId: z.string().uuid(),
      note: z.string().min(4).max(200),
    }))
    .mutation(async ({ input }) => {
      try { return await insurance.confirmClaimPayout(await dbOrThrow(), input); } catch (e) { svcError(e); }
    }),

  listPolicies: protectedProcedure
    .input(z.object({ ...tenantInput, holderPhone: phone.optional() }))
    .query(async ({ ctx, input }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      return insurance.listPolicies(await dbOrThrow(), input.tenantId, input.holderPhone);
    }),

  listClaims: protectedProcedure
    .input(z.object({ ...tenantInput, policyId: z.string().uuid().optional() }))
    .query(async ({ ctx, input }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      return insurance.listClaims(await dbOrThrow(), input.tenantId, input.policyId);
    }),
});

// ── Voucher rails ────────────────────────────────────────────────────────────
export const vouchersRouter = router({
  createProgram: protectedProcedure
    .input(z.object({
      ...tenantInput,
      issuer: z.string().min(1).max(160),
      name: z.string().min(1).max(160),
      budgetCents: z.number().int().positive(),
      currency: z.string().length(3).optional(),
      eligiblePhones: z.array(phone).nullable().optional(),
      eligibleCategories: z.array(z.string().min(1).max(80)).nullable().optional(),
      expiresAt: z.coerce.date().nullable().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      try { return await vouchers.createProgram(await dbOrThrow(), input); } catch (e) { svcError(e); }
    }),

  listPrograms: protectedProcedure
    .input(z.object(tenantInput))
    .query(async ({ ctx, input }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      return vouchers.listPrograms(await dbOrThrow(), input.tenantId);
    }),

  issue: protectedProcedure
    .input(z.object({
      ...tenantInput,
      programId: z.string().uuid(),
      recipients: z.array(phone).min(1).max(5000),
      amountCents: z.number().int().positive(),
      currency: z.string().length(3).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      try { return await vouchers.issueVouchers(await dbOrThrow(), input); } catch (e) { svcError(e); }
    }),

  /**
   * Redeem at checkout (tenant-side POS / portal path). Validates program
   * eligibility + purchased categories and claims the voucher transactionally.
   */
  redeem: protectedProcedure
    .input(z.object({
      ...tenantInput,
      code: z.string().min(6).max(32),
      orderId: z.string().max(36),
      phone,
      purchasedCategories: z.array(z.string().max(80)).max(200).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await dbOrThrow();
      // Tenant guard: the order must belong to this tenant.
      const [order] = await db.select({ id: orders.id, tenantId: orders.tenantId })
        .from(orders).where(eq(orders.id, input.orderId)).limit(1).catch(() => []);
      if (!order || order.tenantId !== input.tenantId) {
        throw new TRPCError({ code: "NOT_FOUND", message: "order not found" });
      }
      try {
        return await vouchers.redeemVoucher(db, input.code, input.orderId, {
          phone: input.phone, purchasedCategories: input.purchasedCategories,
        });
      } catch (e) { svcError(e); }
    }),

  report: protectedProcedure
    .input(z.object({ ...tenantInput, programId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      try { return await vouchers.issuerReport(await dbOrThrow(), input.tenantId, input.programId); } catch (e) { svcError(e); }
    }),

  reportCsv: protectedProcedure
    .input(z.object({ ...tenantInput, programId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      try {
        const report = await vouchers.issuerReport(await dbOrThrow(), input.tenantId, input.programId);
        return { csv: vouchers.issuerReportCsv(report) };
      } catch (e) { svcError(e); }
    }),

  /**
   * PUBLIC (hardened): recipient checks a voucher by code + registered phone.
   * The code is a 128-bit bearer secret; pairing it with the phone prevents
   * enumeration and leaks nothing beyond the voucher's own face values.
   */
  checkByCode: publicProcedure
    .input(z.object({ code: z.string().min(6).max(32), phone }))
    .query(async ({ input }) => {
      const db = await dbOrThrow();
      const { vouchers: vouchersTable } = await import("../../drizzle/schema");
      const [v] = await db.select().from(vouchersTable)
        .where(eq(vouchersTable.code, input.code.trim().toUpperCase())).limit(1);
      if (!v || v.recipientPhone !== input.phone) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Voucher not found" });
      }
      return {
        amountCents: v.amountCents, currency: v.currency, status: v.status,
        expiresAt: v.expiresAt, redeemedAt: v.redeemedAt,
      };
    }),
});
