// === W64 intelligence (R4) ===
/**
 * Prefill router — exposes the KYC OCR prefill bundle (services/prefillService)
 * to the web confirm-edit forms (payout account setup, POS terminal
 * registration, credit applications). Read-only; NEVER auto-submits — the
 * client renders an editable form and the user confirms via the EXISTING
 * mutations.
 */
import { z } from "zod";
import { protectedProcedure, router, assertTenantAccess } from "../_core/trpc";
import { getDb } from "../db";
import { getKycPrefill } from "../services/prefillService";

export const prefillRouter = router({
  /** Latest approved-KYC prefill bundle for the tenant (fail-open). */
  kyc: protectedProcedure
    .input(z.object({ tenantId: z.string().min(1).max(36) }))
    .query(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) return { available: false as const };
      return getKycPrefill(db, input.tenantId);
    }),
});
// === END W64 intelligence (R4) ===
