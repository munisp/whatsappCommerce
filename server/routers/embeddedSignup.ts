/**
 * W16 embeddedSignup router (roadmap F9).
 *
 *   exchange  — operator mutation: exchange the Meta embedded-signup `code`,
 *               resolve the WABA + phone-number assignment and persist it on
 *               the tenant's existing WhatsApp credential storage.
 *               Idempotent per (tenant, code).
 *   complete  — operator query: current onboarding/coexistence state plus
 *               the coexistence limitation report for the operator UI.
 *
 * Structured failure taxonomy (surfaced as BAD_REQUEST with `code` in the
 * message prefix): expired_code | permission_denied | no_waba_selected |
 * meta_api_error.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { operatorProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import {
  completeEmbeddedSignup,
  EmbeddedSignupError,
} from "../services/embeddedSignup";
import {
  coexistenceLimitations,
  readCredentialState,
} from "../services/embeddedSignup/coexistence";
import { tenants } from "../../drizzle/schema";
import { eq } from "drizzle-orm";

const tenantInput = z.object({ tenantId: z.string().min(1).max(36) });

function toTrpcError(err: unknown): TRPCError {
  if (err instanceof EmbeddedSignupError) {
    return new TRPCError({
      code: err.code === "permission_denied" ? "FORBIDDEN" : "BAD_REQUEST",
      message: `${err.code}: ${err.message}`,
    });
  }
  return new TRPCError({
    code: "INTERNAL_SERVER_ERROR",
    message: String((err as any)?.message ?? err).slice(0, 300),
  });
}

export const embeddedSignupRouter = router({
  /**
   * Exchange the embedded-signup code and persist WABA/phone credentials.
   * Replaying the same code returns the stored record (replayed=true).
   */
  exchange: operatorProcedure
    .input(
      tenantInput.extend({
        code: z.string().min(1).max(2048),
        wabaId: z.string().max(64).optional(),
        phoneNumberId: z.string().max(64).optional(),
        displayPhoneNumber: z.string().max(32).optional(),
        coexistence: z.boolean().optional().default(false),
      }),
    )
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      try {
        const { record, replayed } = await completeEmbeddedSignup(db, {
          tenantId: input.tenantId,
          code: input.code,
          wabaId: input.wabaId,
          phoneNumberId: input.phoneNumberId,
          displayPhoneNumber: input.displayPhoneNumber,
          coexistence: input.coexistence,
        });
        const state = readCredentialState({
          whatsapp: {
            wabaId: record.wabaId,
            phoneNumberId: record.phoneNumberId,
            displayPhoneNumber: record.displayPhoneNumber,
            coexistence: record.coexistence,
            onboardingStatus: "completed",
          },
        });
        return {
          replayed,
          wabaId: record.wabaId,
          phoneNumberId: record.phoneNumberId,
          displayPhoneNumber: record.displayPhoneNumber,
          coexistence: record.coexistence,
          onboardingStatus: record.onboardingStatus,
          limitations: coexistenceLimitations(state),
        };
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Current onboarding/coexistence state + limitation report. Read-only but
   * operator-gated (it reveals credential identifiers).
   */
  complete: operatorProcedure.input(tenantInput).query(async ({ input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
    const [tenant] = await db
      .select({ settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, input.tenantId))
      .limit(1)
      .catch(() => []);
    if (!tenant) throw new TRPCError({ code: "NOT_FOUND", message: "Tenant not found" });
    const state = readCredentialState(tenant.settings);
    return { ...state, limitations: coexistenceLimitations(state) };
  }),
});
