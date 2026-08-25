/**
 * === W33 ai-qa-forecast (Coder B) ===
 * `cashflow` router — dashboard surface for the cash-flow calendar/forecast.
 * Read-only: every figure is computed from real rows by
 * server/services/cashflowForecast.ts (no fabricated numbers; a tenant with
 * no data gets the honest "No data yet" empty state). analyst-readable;
 * snapshot persistence happens in the weekly cron, never from a read.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, analystProcedure } from "../_core/trpc";
import { getDb } from "../db";

export const cashflowRouter = router({
  /** Compute the 30/60/90-day projection with per-line sources. */
  forecast: analystProcedure
    .input(z.object({
      tenantId: z.string(),
      horizonDays: z.union([z.literal(30), z.literal(60), z.literal(90)]).optional(),
    }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const svc = await import("../services/cashflowForecast");
      const f = await svc.computeForecast(db, input.tenantId, input.horizonDays ?? 30);
      if (f.empty) {
        // W30-style honest empty state — no zero-filled fabrication.
        return { empty: true as const, message: "No data yet", tenantId: input.tenantId, horizonDays: f.horizonDays, currency: f.currency };
      }
      return {
        empty: false as const,
        tenantId: f.tenantId,
        horizonDays: f.horizonDays,
        generatedAt: f.generatedAt,
        currency: f.currency,
        startingBalanceCents: f.startingBalanceCents,
        inflowCents: f.inflowCents,
        outflowCents: f.outflowCents,
        netCents: f.netCents,
        shortfallAt: f.shortfallAt,
        skippedCurrencies: f.skippedCurrencies,
        lines: f.lines,
      };
    }),

  /** Latest stored snapshots (from the weekly cron) for the tenant. */
  snapshots: analystProcedure
    .input(z.object({
      tenantId: z.string(),
      limit: z.number().int().min(1).max(30).optional(),
    }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const { cashflowForecasts } = await import("../../drizzle/schema");
      const { and, eq, desc } = await import("drizzle-orm");
      const rows = await db.select().from(cashflowForecasts)
        .where(and(eq(cashflowForecasts.tenantId, input.tenantId)))
        .orderBy(desc(cashflowForecasts.generatedAt))
        .limit(input.limit ?? 10);
      return rows.map((r: any) => ({
        id: r.id, horizonDays: r.horizonDays, generatedAt: r.generatedAt,
        inflowCents: r.inflowCents, outflowCents: r.outflowCents, netCents: r.netCents,
        currency: r.currency, shortfallAt: r.shortfallAt,
      }));
    }),
});
// === END W33 ai-qa-forecast ===
