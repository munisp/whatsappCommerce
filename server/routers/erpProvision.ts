/**
 * server/routers/erpProvision.ts — ERP-aware agentic configuration API
 * (roadmap F5). Thin wrapper over server/services/erpProvision.
 *
 * Access model:
 *   - provision / applyConfig mutations: operatorProcedure (tenant membership
 *     role owner|operator; platform admin bypasses) — these mutate external
 *     ERPs and tenant settings.
 *   - reads (getState / listIntents): protectedProcedure + assertTenantAccess.
 * Safety: provisioning defaults to real application but supports dryRun;
 * applyConfig requires confirm: true to mutate (default = dry-run preview).
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import {
  router,
  protectedProcedure,
  operatorProcedure,
  assertTenantAccess,
} from "../_core/trpc";
import { getDb } from "../db";
import { tenants } from "../../drizzle/schema";
import { eq } from "drizzle-orm";
import {
  applyCopilotConfig,
  provisionErpTenantObjects,
  CONFIG_INTENTS,
  CONFIG_INTENT_CATALOG,
  type ConfigIntent,
  type ErpProvisionState,
} from "../services/erpProvision";
import { ZodError } from "zod";

function asTrpcError(e: unknown): TRPCError {
  if (e instanceof TRPCError) return e;
  if (e instanceof ZodError) {
    return new TRPCError({ code: "BAD_REQUEST", message: e.issues.map((i) => i.message).join("; ") });
  }
  const msg = e instanceof Error ? e.message : String(e);
  if (/not found/i.test(msg)) return new TRPCError({ code: "NOT_FOUND", message: msg });
  if (/not configured|Unknown config intent|duplicate pipeline/i.test(msg)) {
    return new TRPCError({ code: "BAD_REQUEST", message: msg });
  }
  return new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: msg });
}

export const erpProvisionRouter = router({
  /**
   * Provision standard tenant objects in all connected ERPs (idempotent).
   * dryRun: true previews without touching external systems or state.
   */
  provision: operatorProcedure
    .input(z.object({ tenantId: z.string().min(1), dryRun: z.boolean().default(false) }))
    .mutation(async ({ input }) => {
      try {
        return await provisionErpTenantObjects({ tenantId: input.tenantId }, { dryRun: input.dryRun });
      } catch (e) {
        throw asTrpcError(e);
      }
    }),

  /** Current provisioning state (persisted under tenants.settings.erpProvision). */
  getState: protectedProcedure
    .input(z.object({ tenantId: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      const [tenant] = await db
        .select({ settings: tenants.settings })
        .from(tenants)
        .where(eq(tenants.id, input.tenantId))
        .limit(1);
      if (!tenant) throw new TRPCError({ code: "NOT_FOUND", message: "Tenant not found" });
      const raw = ((tenant.settings ?? {}) as Record<string, unknown>).erpProvision;
      return (raw ?? null) as ErpProvisionState | null;
    }),

  /** Catalog of supported ongoing configuration intents. */
  listIntents: protectedProcedure.query(() => CONFIG_INTENT_CATALOG),

  /**
   * Apply an ongoing copilot configuration intent. confirm: true is required
   * to mutate tenant settings; otherwise returns a dry-run preview.
   */
  applyConfig: operatorProcedure
    .input(
      z.object({
        tenantId: z.string().min(1),
        intent: z.enum(CONFIG_INTENTS as unknown as [ConfigIntent, ...ConfigIntent[]]),
        params: z.unknown(),
        confirm: z.boolean().default(false),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await applyCopilotConfig({
          tenantId: input.tenantId,
          intent: input.intent,
          params: input.params,
          confirm: input.confirm,
          actorId: String(ctx.user.id),
        });
      } catch (e) {
        throw asTrpcError(e);
      }
    }),
});
