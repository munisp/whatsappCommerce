/**
 * Usage metering + plan quotas (admin).
 *
 * Read the tenant's current-period usage counters and plan, and update the
 * plan limits (stored in tenants.settings.plan — see services/metering.ts).
 */
import { z } from "zod";
import { adminProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import {
  currentPeriod, DEFAULT_PLAN, getPlan, getUsage, setPlan,
} from "../services/metering";

const tenantInput = z.object({
  tenantId: z.string().min(1).max(36).optional(),
  period: z.string().regex(/^\d{6}$/, "period must be yyyymm").optional(),
});

export const meteringRouter = router({
  /** Current-period usage counters for a tenant (admin). */
  getUsage: adminProcedure
    .input(tenantInput)
    .query(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) return { period: input.period ?? currentPeriod(), counters: [] };
      const tenantId = input.tenantId ?? (ctx.user as any)?.tenantId ?? "default";
      const period = input.period ?? currentPeriod();
      const counters = await getUsage(db, tenantId, period);
      return { tenantId, period, counters };
    }),

  /** Resolved plan (settings.plan merged over DEFAULT_PLAN). */
  getPlan: adminProcedure
    .input(z.object({ tenantId: z.string().min(1).max(36).optional() }))
    .query(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) return { tenantId: input.tenantId ?? null, plan: DEFAULT_PLAN };
      const tenantId = input.tenantId ?? (ctx.user as any)?.tenantId ?? "default";
      const plan = await getPlan(db, tenantId);
      return { tenantId, plan };
    }),

  /** Set/replace the tenant's plan tier + monthly limits. */
  setPlan: adminProcedure
    .input(z.object({
      tenantId: z.string().min(1).max(36),
      tier: z.string().trim().min(1).max(40),
      limits: z.object({
        messagesPerMonth: z.number().int().min(0),
        ordersPerMonth: z.number().int().min(0),
      }),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");
      const plan = { tier: input.tier, limits: input.limits };
      await setPlan(db, input.tenantId, plan);
      return { ok: true, tenantId: input.tenantId, plan };
    }),
});
