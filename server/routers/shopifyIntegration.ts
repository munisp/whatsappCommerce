/**
 * server/routers/shopifyIntegration.ts — Shopify app connector API
 * (roadmap F7). Thin wrapper over server/services/shopifyIntegration.
 *
 * Access model:
 *   - connect / callback / disconnect / syncNow: operatorProcedure (tenant
 *     membership role owner|operator) — these mutate external state.
 *   - status / health: protectedProcedure + assertTenantAccess.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import {
  router,
  protectedProcedure,
  operatorProcedure,
  assertTenantAccess,
} from "../_core/trpc";
import {
  buildInstallUrl,
  handleOAuthCallback,
  uninstallShopify,
  syncCatalogToShopify,
  getShopifyStatus,
  shopifyConnector,
} from "../services/shopifyIntegration";

function asTrpcError(e: unknown): TRPCError {
  if (e instanceof TRPCError) return e;
  const msg = e instanceof Error ? e.message : String(e);
  if (/not found/i.test(msg)) return new TRPCError({ code: "NOT_FOUND", message: msg });
  if (/not configured|not connected|invalid|malformed|expired|nonce/i.test(msg)) {
    return new TRPCError({ code: "BAD_REQUEST", message: msg });
  }
  return new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: msg });
}

export const shopifyIntegrationRouter = router({
  /** Start OAuth: returns the Shopify authorize URL (null when app creds unset). */
  connect: operatorProcedure
    .input(z.object({ tenantId: z.string().min(1), shop: z.string().optional() }))
    .mutation(async ({ input }) => {
      try {
        const installUrl = await buildInstallUrl(input.tenantId, { shop: input.shop });
        return { installUrl };
      } catch (e) {
        throw asTrpcError(e);
      }
    }),

  /**
   * Complete OAuth from an SPA-style flow (the browser-redirect endpoint is
   * GET /api/shopify/callback; this mutation exists for clients that capture
   * the redirect params themselves).
   */
  callback: operatorProcedure
    .input(z.object({
      tenantId: z.string().min(1),
      shop: z.string().min(1),
      code: z.string().min(1),
      state: z.string().min(1),
    }))
    .mutation(async ({ input }) => {
      const result = await handleOAuthCallback({
        shop: input.shop,
        code: input.code,
        state: input.state,
      });
      if (!result.ok) throw asTrpcError(new Error(result.error));
      if (result.tenantId !== input.tenantId) {
        throw new TRPCError({ code: "FORBIDDEN", message: "state tenant mismatch" });
      }
      return result;
    }),

  /** Uninstall: revoke the token at Shopify + clear connection state. */
  disconnect: operatorProcedure
    .input(z.object({ tenantId: z.string().min(1) }))
    .mutation(async ({ input }) => {
      try {
        return await uninstallShopify(input.tenantId);
      } catch (e) {
        throw asTrpcError(e);
      }
    }),

  /** Push platform products → Shopify (idempotent; dryRun previews). */
  syncNow: operatorProcedure
    .input(z.object({ tenantId: z.string().min(1), dryRun: z.boolean().default(false) }))
    .mutation(async ({ input }) => {
      try {
        return await syncCatalogToShopify(input.tenantId, { dryRun: input.dryRun });
      } catch (e) {
        throw asTrpcError(e);
      }
    }),

  /** Connection + sync status (no secrets). */
  status: protectedProcedure
    .input(z.object({ tenantId: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      try {
        return await getShopifyStatus(input.tenantId);
      } catch (e) {
        throw asTrpcError(e);
      }
    }),

  /** Live connectivity check against the shop. */
  health: protectedProcedure
    .input(z.object({ tenantId: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      return shopifyConnector.healthCheck(input.tenantId);
    }),
});
