/**
 * W15 catalogBootstrap router (roadmap F5) — tenant-scoped (NOT admin).
 *
 * Procedures:
 *   bootstrapFromImage — photo → extraction → pending draft
 *   getDraft           — load one draft (tenant-isolated; NOT_FOUND cross-tenant)
 *   confirmDraft       — publish approved items to products (idempotent)
 *   rejectDraft        — abandon a draft
 *
 * WhatsApp/copilot handoff: inbound WhatsApp media lands in whatsappMediaFiles
 * (see routers/mediaAssets / services/receiptVision for the media-intake
 * path). The copilot intent registry lives in services/onboardingCopilot/
 * tools.ts, owned by C1 this wave — wiring is intentionally NOT done here;
 * the copilot should call bootstrapCatalogFromImage() with the media file's
 * imageUrl and then surface catalogBootstrap.confirmDraft for merchant review.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, protectedProcedure, assertTenantAccess } from "../_core/trpc";
import {
  bootstrapCatalogFromImage,
  confirmCatalogDraft,
  getCatalogDraft,
  rejectCatalogDraft,
} from "../services/catalogBootstrap";

function toTrpcError(error: string): TRPCError {
  if (error === "draft_not_found") return new TRPCError({ code: "NOT_FOUND", message: error });
  if (error === "extraction_disabled")
    return new TRPCError({ code: "PRECONDITION_FAILED", message: error });
  // W15.1: a concurrent confirm holds the claim — caller should retry/poll.
  if (error === "confirm_in_progress") return new TRPCError({ code: "CONFLICT", message: error });
  return new TRPCError({ code: "BAD_REQUEST", message: error });
}

export const catalogBootstrapRouter = router({
  bootstrapFromImage: protectedProcedure
    .input(
      z.object({
        tenantId: z.string(),
        imageUrl: z.string().url().optional(),
        imageBase64: z.string().max(8_000_000).optional(),
        mimeType: z.string().max(100).optional(),
        currency: z.string().length(3).optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const res = await bootstrapCatalogFromImage(input);
      if (!res.ok) throw toTrpcError(res.error);
      return res;
    }),

  getDraft: protectedProcedure
    .input(z.object({ tenantId: z.string(), draftId: z.string() }))
    .query(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const res = await getCatalogDraft(input);
      if (!res.ok) throw toTrpcError(res.error);
      return res.draft;
    }),

  confirmDraft: protectedProcedure
    .input(
      z.object({
        tenantId: z.string(),
        draftId: z.string(),
        approveItemIds: z.array(z.string()).optional(),
        edits: z
          .record(
            z.string(),
            z.object({
              name: z.string().max(255).optional(),
              // W15.1: same upper bound as extraction (1e9 cents; literal so
              // router tests that mock the service module keep working).
              priceCents: z.number().int().min(50).max(1_000_000_000).optional(),
              sku: z.string().max(100).optional(),
              unit: z.string().max(30).optional(),
            }),
          )
          .optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const res = await confirmCatalogDraft(input);
      if (!res.ok) throw toTrpcError(res.error);
      return res;
    }),

  rejectDraft: protectedProcedure
    .input(
      z.object({
        tenantId: z.string(),
        draftId: z.string(),
        reason: z.string().max(200).optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const res = await rejectCatalogDraft(input);
      if (!res.ok) throw toTrpcError(res.error);
      return res;
    }),
});
