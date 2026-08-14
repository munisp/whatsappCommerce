/**
 * A2-02 fixture: deliberately-evasive router source. This file is NOT a real
 * router — it is scanned by authzCoverage.test.ts to prove the strengthened
 * ratchet catches the three historical evasion classes. It must never be
 * imported at runtime.
 */
import { z } from "zod";

// The fixture is scanned as SOURCE TEXT by the ratchet; the procedure
// identifiers are declared (never wired to real tRPC) so tsc stays happy.
declare const protectedProcedure: any;
declare const assertTenantAccess: any;

// Evasion class 1: tenantId hidden inside a module-level schema const.
const HermesLikeConfigInput = z.object({
  tenantId: z.string(),
  apiKey: z.string().optional(),
});

export const evasionFixtureRouter = {
  // FLAG: module-level-schema unguarded saveConfig pattern (A2-01 class)
  saveConfig: protectedProcedure
    .input(HermesLikeConfigInput)
    .mutation(async ({ input }: any) => {
      return { ok: true, tenantId: input.tenantId };
    }),

  // FLAG: id-keyed input (no tenantId anywhere) with no guard (A2-03 class)
  deletePriceTier: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }: any) => {
      return { deleted: input.id };
    }),

  // FLAG: comment-only guard — stripped source has no real assertTenantAccess
  updateSettings: protectedProcedure
    .input(z.object({ tenantId: z.string(), value: z.string() }))
    .mutation(async ({ input }: any) => {
      // assertTenantAccess(ctx.user, input.tenantId) is enforced here
      return { ok: true, tenantId: input.tenantId };
    }),

  // OK: real guard on a module-level schema — must NOT be flagged
  saveConfigGuarded: protectedProcedure
    .input(HermesLikeConfigInput)
    .mutation(async ({ input, ctx }: any) => {
      assertTenantAccess(ctx.user, input.tenantId);
      return { ok: true };
    }),

  // OK: parsed exemption marker — must NOT be flagged
  publicWebhookish: protectedProcedure
    // authz:exempt fixture: proves marker parsing works
    .input(z.object({ orderId: z.string() }))
    .mutation(async ({ input }: any) => {
      return { ok: true, id: input.orderId };
    }),
} as unknown as Record<string, unknown>;
