/**
 * W33 tax-statements (Coder A) — tenant-guarded supplier tax profiles +
 * annual statements router.
 *
 * Profiles CRUD and statement generate/send are financial-document actions
 * → moneyProcedure (owner|operator). Reads (list/get) → analystProcedure.
 * Aggregation runs against REAL payment records only (vendor-bill payment
 * events, paid wholesale orders, attributed payout wallet_tx) — no
 * fabricated figures; a supplier with no payments in the year is an honest
 * NO_PAYMENTS error, not a zero statement.
 */
import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { analystProcedure, moneyProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import { annualStatements, supplierTaxProfiles } from "../../drizzle/schema";
import {
  computeAnnualTotals,
  generateAnnualStatement,
  markStatementViewed,
  sendStatement,
  upsertSupplierTaxProfile,
  TAX_ID_TYPES,
} from "../services/supplierTaxStatements";

async function requireDb() {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
  return db;
}

/** Translate service-layer errors (code-tagged) into tRPC errors. */
function rethrow(err: any): never {
  if (err instanceof TRPCError) throw err;
  const code = ["NOT_FOUND", "CONFLICT", "FORBIDDEN"].includes(err?.code) ? err.code : "BAD_REQUEST";
  throw new TRPCError({ code, message: err?.message ?? String(err) });
}

const profileInput = {
  tenantId: z.string(),
  supplierTenantId: z.string().max(36).nullish(),
  vendorName: z.string().min(1).max(160),
  vendorRef: z.string().max(128).nullish(),
  taxId: z.string().max(64).nullish(),
  taxIdType: z.enum(TAX_ID_TYPES).nullish(),
  countryCode: z.string().length(2).nullish(),
  withholdingBps: z.number().int().min(0).max(10000).nullish(),
  phone: z.string().max(32).nullish(),
};

export const taxStatementsRouter = router({
  /** Create or update a supplier tax profile (upsert on supplier identity). */
  upsertProfile: moneyProcedure
    .input(z.object(profileInput))
    .mutation(async ({ ctx, input }) => {
      const db = await requireDb();
      try {
        const { phone, ...rest } = input;
        return await upsertSupplierTaxProfile(db, {
          ...rest,
          metadata: phone ? { phone } : undefined,
          actor: String(ctx.user.id),
        });
      } catch (e) { rethrow(e); }
    }),

  /** List the tenant's supplier tax profiles. Analyst read-only. */
  listProfiles: analystProcedure
    .input(z.object({ tenantId: z.string() }))
    .query(async ({ input }) => {
      const db = await requireDb();
      return db.select().from(supplierTaxProfiles)
        .where(eq(supplierTaxProfiles.tenantId, input.tenantId))
        .orderBy(desc(supplierTaxProfiles.createdAt));
    }),

  /** Delete a profile (never deletes generated statements). */
  deleteProfile: moneyProcedure
    .input(z.object({ tenantId: z.string(), profileId: z.string().uuid() }))
    .mutation(async ({ input }) => {
      const db = await requireDb();
      const [row] = await db.select().from(supplierTaxProfiles)
        .where(and(eq(supplierTaxProfiles.id, input.profileId), eq(supplierTaxProfiles.tenantId, input.tenantId)))
        .limit(1);
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Profile not found" });
      await db.delete(supplierTaxProfiles).where(eq(supplierTaxProfiles.id, row.id));
      return { deleted: true, profileId: row.id };
    }),

  /** Preview per-supplier annual totals (real payment records, per currency). */
  annualTotals: analystProcedure
    .input(z.object({ tenantId: z.string(), year: z.number().int().min(2000).max(2100) }))
    .query(async ({ input }) => {
      const db = await requireDb();
      return computeAnnualTotals(db, input.tenantId, input.year);
    }),

  /** Generate (idempotently regenerate) annual statement PDF(s) for a supplier. */
  generateAnnualStatement: moneyProcedure
    .input(z.object({
      tenantId: z.string(),
      supplierRef: z.string().min(1).max(128),
      year: z.number().int().min(2000).max(2100),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await requireDb();
      try {
        return await generateAnnualStatement(db, { ...input, actor: String(ctx.user.id) });
      } catch (e) { rethrow(e); }
    }),

  /** WhatsApp document push of a generated statement to the supplier. */
  sendStatement: moneyProcedure
    .input(z.object({
      tenantId: z.string(),
      statementId: z.string().uuid(),
      phone: z.string().max(32).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await requireDb();
      try {
        return await sendStatement(db, { ...input, actor: String(ctx.user.id) });
      } catch (e) { rethrow(e); }
    }),

  /** List generated statements for the tenant (payer side). Analyst read-only. */
  listStatements: analystProcedure
    .input(z.object({
      tenantId: z.string(),
      year: z.number().int().min(2000).max(2100).optional(),
      status: z.enum(["generated", "sent", "viewed"]).optional(),
    }))
    .query(async ({ input }) => {
      const db = await requireDb();
      const conds: any[] = [eq(annualStatements.tenantId, input.tenantId)];
      if (input.year) conds.push(eq(annualStatements.year, input.year));
      if (input.status) conds.push(eq(annualStatements.status, input.status));
      return db.select().from(annualStatements)
        .where(and(...conds))
        .orderBy(desc(annualStatements.generatedAt));
    }),

  /** Supplier-side inbox: statements addressed to the caller's tenant. */
  supplierInbox: analystProcedure
    .input(z.object({ tenantId: z.string() }))
    .query(async ({ input }) => {
      const db = await requireDb();
      return db.select().from(annualStatements)
        .where(eq(annualStatements.supplierTenantId, input.tenantId))
        .orderBy(desc(annualStatements.generatedAt));
    }),

  /** Supplier read → honest 'viewed' transition on a sent statement. */
  markViewed: analystProcedure
    .input(z.object({ tenantId: z.string(), statementId: z.string().uuid() }))
    .mutation(async ({ input }) => {
      const db = await requireDb();
      try {
        return await markStatementViewed(db, { statementId: input.statementId, supplierTenantId: input.tenantId });
      } catch (e) { rethrow(e); }
    }),
});
