import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { router, protectedProcedure } from "../_core/trpc";
import { getDb } from "../db";
import { taxFilings, cacRegistrations, procurementBids, governmentContracts } from "../../drizzle/schema";
import { randomUUID } from "crypto";

export const complianceRouter = router({
  // ── FIRS Tax Filings ─────────────────────────────────────────────────────
  listTaxFilings: protectedProcedure
    .input(z.object({ tenantId: z.string(), status: z.string().optional(), limit: z.number().default(50) }))
    .query(async ({ input }) => {
      const db = (await getDb())!;
      const conds = [eq(taxFilings.tenantId, input.tenantId)];
      if (input.status) conds.push(eq(taxFilings.status, input.status as "draft" | "submitted" | "accepted" | "rejected" | "under_review"));
      return db.select().from(taxFilings).where(and(...conds)).orderBy(desc(taxFilings.createdAt)).limit(input.limit);
    }),

  createTaxFiling: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      filingType: z.string().default("vat"),
      taxAuthority: z.string().default("firs"),
      periodStart: z.string(),
      periodEnd: z.string(),
      grossRevenue: z.string(),
      taxableAmount: z.string(),
      taxAmount: z.string(),
      currency: z.string().default("NGN"),
    }))
    .mutation(async ({ input }) => {
      const db = (await getDb())!;
      const id = randomUUID();
      const now = new Date();
      await db.insert(taxFilings).values({
        id, ...input,
        periodStart: new Date(input.periodStart),
        periodEnd: new Date(input.periodEnd),
        status: "draft", documents: [], createdAt: now, updatedAt: now,
      });
      return { id };
    }),

  submitTaxFiling: protectedProcedure
    .input(z.object({ id: z.string(), referenceNumber: z.string().optional() }))
    .mutation(async ({ input }) => {
      const db = (await getDb())!;
      await db.update(taxFilings).set({
        status: "submitted",
        referenceNumber: input.referenceNumber ?? `FIRS-${Date.now().toString(36).toUpperCase()}`,
        submittedAt: new Date(),
        updatedAt: new Date(),
      }).where(eq(taxFilings.id, input.id));
      return { ok: true };
    }),

  // ── CAC Business Registration ────────────────────────────────────────────
  listCacRegistrations: protectedProcedure
    .input(z.object({ tenantId: z.string(), limit: z.number().default(50) }))
    .query(async ({ input }) => {
      const db = (await getDb())!;
      return db.select().from(cacRegistrations).where(eq(cacRegistrations.tenantId, input.tenantId)).orderBy(desc(cacRegistrations.createdAt)).limit(input.limit);
    }),

  createCacRegistration: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      businessName: z.string().min(2),
      businessType: z.string().default("sole_proprietorship"),
      rcNumber: z.string().optional(),
      tinNumber: z.string().optional(),
    }))
    .mutation(async ({ input }) => {
      const db = (await getDb())!;
      const id = randomUUID();
      const now = new Date();
      await db.insert(cacRegistrations).values({ id, ...input, status: "pending", documents: [], createdAt: now, updatedAt: now });
      return { id };
    }),

  updateCacStatus: protectedProcedure
    .input(z.object({ id: z.string(), status: z.string(), rcNumber: z.string().optional() }))
    .mutation(async ({ input }) => {
      const db = (await getDb())!;
      await db.update(cacRegistrations).set({
        status: input.status,
        rcNumber: input.rcNumber,
        approvedAt: input.status === "approved" ? new Date() : undefined,
        updatedAt: new Date(),
      }).where(eq(cacRegistrations.id, input.id));
      return { ok: true };
    }),

  // ── B2G Procurement Bids ─────────────────────────────────────────────────
  listProcurementBids: protectedProcedure
    .input(z.object({ tenantId: z.string(), status: z.string().optional(), limit: z.number().default(50) }))
    .query(async ({ input }) => {
      const db = (await getDb())!;
      const conds = [eq(procurementBids.tenantId, input.tenantId)];
      if (input.status) conds.push(eq(procurementBids.status, input.status as "draft" | "submitted" | "shortlisted" | "awarded" | "rejected" | "withdrawn"));
      return db.select().from(procurementBids).where(and(...conds)).orderBy(desc(procurementBids.createdAt)).limit(input.limit);
    }),

  createProcurementBid: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      contractTitle: z.string().min(5),
      procuringEntity: z.string().min(2),
      contractValue: z.string(),
      currency: z.string().default("NGN"),
      deadline: z.string().optional(),
      technicalProposal: z.string().optional(),
      financialProposal: z.string().optional(),
    }))
    .mutation(async ({ input }) => {
      const db = (await getDb())!;
      const id = randomUUID();
      const now = new Date();
      await db.insert(procurementBids).values({
        id, ...input,
        deadline: input.deadline ? new Date(input.deadline) : undefined,
        status: "draft", documents: [], createdAt: now, updatedAt: now,
      });
      return { id };
    }),

  submitProcurementBid: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      const db = (await getDb())!;
      await db.update(procurementBids).set({ status: "submitted", submittedAt: new Date(), updatedAt: new Date() }).where(eq(procurementBids.id, input.id));
      return { ok: true };
    }),

  // ── Government Contracts ─────────────────────────────────────────────────
  listGovernmentContracts: protectedProcedure
    .input(z.object({ tenantId: z.string(), limit: z.number().default(50) }))
    .query(async ({ input }) => {
      const db = (await getDb())!;
      return db.select().from(governmentContracts).where(eq(governmentContracts.tenantId, input.tenantId)).orderBy(desc(governmentContracts.createdAt)).limit(input.limit);
    }),

  // ── Compliance Summary ───────────────────────────────────────────────────
  complianceSummary: protectedProcedure
    .input(z.object({ tenantId: z.string() }))
    .query(async ({ input }) => {
      const db = (await getDb())!;
      const [filings, cacs, bids] = await Promise.all([
        db.select().from(taxFilings).where(eq(taxFilings.tenantId, input.tenantId)),
        db.select().from(cacRegistrations).where(eq(cacRegistrations.tenantId, input.tenantId)),
        db.select().from(procurementBids).where(eq(procurementBids.tenantId, input.tenantId)),
      ]);
      return {
        taxFilings: { total: filings.length, submitted: filings.filter(f => f.status !== "draft").length, accepted: filings.filter(f => f.status === "accepted").length },
        cacRegistrations: { total: cacs.length, approved: cacs.filter(c => c.status === "approved").length },
        procurementBids: { total: bids.length, submitted: bids.filter(b => b.status !== "draft").length, awarded: bids.filter(b => b.status === "awarded").length },
      };
    }),
});

