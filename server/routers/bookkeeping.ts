/**
 * W27 bookkeeping router — tenant-guarded merchant bookkeeping surface:
 * sales summaries (daily/weekly), expense records, digest opt-in prefs, and
 * tax-ready CSV/PDF export. All procedures are scoped to the session tenant
 * (ctx.user.tenantId — never caller-supplied), mirroring tenantPortal.ts.
 */
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { router, protectedProcedure } from "../_core/trpc";
import { getDb } from "../db";
import { expenses } from "../../drizzle/schema";
import {
  addManualExpense,
  buildBookkeepingExport,
  computeSalesSummary,
  exportToCsv,
  exportToPdf,
  getDigestPref,
  listExpenses,
  renderDigestMessage,
  setDigestPref,
  toCents,
} from "../services/bookkeeping";

const tenantScopedProcedure = protectedProcedure.use(async ({ ctx, next }) => {
  if (!ctx.user.tenantId) {
    throw new TRPCError({ code: "FORBIDDEN", message: "No tenant associated with this account" });
  }
  return next({ ctx: { ...ctx, tenantId: ctx.user.tenantId } });
});

async function requireDb() {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
  return db;
}

const frequencySchema = z.enum(["daily", "weekly"]);
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

function parseDay(s: string, endOfDay = false): Date {
  const d = new Date(`${s}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) throw new TRPCError({ code: "BAD_REQUEST", message: `Invalid date: ${s}` });
  return endOfDay ? new Date(d.getTime() + 24 * 3600 * 1000) : d;
}

export const bookkeepingRouter = router({
  /** Daily/weekly sales summary incl. previous-period comparison. */
  summary: tenantScopedProcedure
    .input(z.object({ frequency: frequencySchema.default("weekly") }))
    .query(async ({ ctx, input }) => {
      const db = await requireDb();
      const s = await computeSalesSummary(db, ctx.tenantId, input.frequency, new Date());
      return { ...s, message: renderDigestMessage(s) };
    }),

  // ── Expenses ────────────────────────────────────────────────────────────
  expenses: router({
    list: tenantScopedProcedure
      .input(z.object({
        from: dateSchema.optional(),
        to: dateSchema.optional(),
        limit: z.number().int().min(1).max(1000).default(200),
      }).optional())
      .query(async ({ ctx, input }) => {
        const db = await requireDb();
        return listExpenses(db, ctx.tenantId, {
          from: input?.from ? parseDay(input.from) : undefined,
          to: input?.to ? parseDay(input.to, true) : undefined,
          limit: input?.limit,
        });
      }),

    add: tenantScopedProcedure
      .input(z.object({
        amount: z.union([z.string(), z.number()]), // major units, converted to integer cents
        vendor: z.string().max(160).optional(),
        category: z.string().max(64).optional(),
        date: dateSchema.optional(),
        note: z.string().max(500).optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        const db = await requireDb();
        const amountCents = toCents(input.amount);
        if (amountCents <= 0) throw new TRPCError({ code: "BAD_REQUEST", message: "Amount must be positive" });
        return addManualExpense(db, ctx.tenantId, {
          amountCents,
          vendor: input.vendor,
          category: input.category,
          date: input.date ? parseDay(input.date) : undefined,
          note: input.note,
        });
      }),

    remove: tenantScopedProcedure
      .input(z.object({ id: z.string().uuid() }))
      .mutation(async ({ ctx, input }) => {
        const db = await requireDb();
        // Tenant-scoped delete — the WHERE clause carries the tenant guard.
        await db.delete(expenses)
          .where(and(eq(expenses.id, input.id), eq(expenses.tenantId, ctx.tenantId)));
        return { ok: true };
      }),
  }),

  // ── Digest prefs ────────────────────────────────────────────────────────
  digest: router({
    get: tenantScopedProcedure
      .input(z.object({ phone: z.string().min(5).max(32) }))
      .query(async ({ ctx, input }) => {
        const db = await requireDb();
        return getDigestPref(db, ctx.tenantId, input.phone);
      }),

    set: tenantScopedProcedure
      .input(z.object({
        phone: z.string().min(5).max(32),
        frequency: frequencySchema.optional(),
        optedIn: z.boolean(),
      }))
      .mutation(async ({ ctx, input }) => {
        const db = await requireDb();
        return setDigestPref(db, ctx.tenantId, input.phone, {
          frequency: input.frequency,
          optedIn: input.optedIn,
        });
      }),
  }),

  // ── Tax-ready export ────────────────────────────────────────────────────
  export: router({
    /** Row-level data + totals (for portal preview). */
    data: tenantScopedProcedure
      .input(z.object({ from: dateSchema, to: dateSchema }))
      .query(async ({ ctx, input }) => {
        const db = await requireDb();
        return buildBookkeepingExport(db, ctx.tenantId, parseDay(input.from), parseDay(input.to, true));
      }),

    csv: tenantScopedProcedure
      .input(z.object({ from: dateSchema, to: dateSchema }))
      .query(async ({ ctx, input }) => {
        const db = await requireDb();
        const x = await buildBookkeepingExport(db, ctx.tenantId, parseDay(input.from), parseDay(input.to, true));
        return { filename: `bookkeeping_${input.from}_${input.to}.csv`, csv: exportToCsv(x) };
      }),

    pdf: tenantScopedProcedure
      .input(z.object({ from: dateSchema, to: dateSchema }))
      .query(async ({ ctx, input }) => {
        const db = await requireDb();
        const x = await buildBookkeepingExport(db, ctx.tenantId, parseDay(input.from), parseDay(input.to, true));
        return {
          filename: `bookkeeping_${input.from}_${input.to}.pdf`,
          pdfBase64: exportToPdf(x).toString("base64"),
        };
      }),
  }),
});
