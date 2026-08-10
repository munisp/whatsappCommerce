/**
 * server/routers/onboardingCopilot.ts — admin-channel API for the agentic
 * onboarding copilot. Thin wrapper over server/services/onboardingCopilot:
 * every procedure is protected, and once a session has a tenantId the caller
 * must have access to that tenant (assertTenantAccess).
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, protectedProcedure, assertTenantAccess } from "../_core/trpc";
import * as copilot from "../services/onboardingCopilot";
import type { OnboardingSession } from "../services/onboardingCopilot";

function assertSessionAccess(
  user: { role: string; tenantId?: string | null },
  session: OnboardingSession | null,
): asserts session is OnboardingSession {
  if (!session) throw new TRPCError({ code: "NOT_FOUND", message: "Onboarding session not found" });
  if (session.tenantId) assertTenantAccess(user, session.tenantId);
}

/** Wrap service errors as tRPC errors (checkpoint refusals → PRECONDITION_FAILED). */
function asTrpcError(e: unknown): TRPCError {
  if (e instanceof TRPCError) return e;
  const msg = e instanceof Error ? e.message : String(e);
  if (/not found/i.test(msg)) return new TRPCError({ code: "NOT_FOUND", message: msg });
  if (/not been approved|was rejected|cannot go live|checkpoint/i.test(msg)) {
    return new TRPCError({ code: "PRECONDITION_FAILED", message: msg });
  }
  if (/invalid|failed contract|Unknown proposal kind|cannot be edited/i.test(msg)) {
    return new TRPCError({ code: "BAD_REQUEST", message: msg });
  }
  return new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: msg });
}

export const onboardingCopilotRouter = router({
  /** Start an onboarding copilot session (admin dashboard channel). */
  startSession: protectedProcedure
    .input(
      z.object({
        channel: z.enum(["admin", "whatsapp"]).default("admin"),
        tenantId: z.string().optional(),
        phone: z.string().max(30).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (input.tenantId) assertTenantAccess(ctx.user, input.tenantId);
      try {
        return await copilot.startSession({
          channel: input.channel,
          tenantId: input.tenantId,
          phone: input.phone,
        });
      } catch (e) {
        throw asTrpcError(e);
      }
    }),

  /** Send a user message into the session; returns the agent's replies. */
  postMessage: protectedProcedure
    .input(z.object({ sessionId: z.string(), text: z.string().min(1).max(4000) }))
    .mutation(async ({ ctx, input }) => {
      try {
        const session = await copilot.getSession(input.sessionId);
        assertSessionAccess(ctx.user, session);
        return await copilot.postMessage({ sessionId: input.sessionId, text: input.text });
      } catch (e) {
        throw asTrpcError(e);
      }
    }),

  /** Approve (or reject) a proposal — the human checkpoint decision. */
  approveProposal: protectedProcedure
    .input(
      z.object({
        sessionId: z.string(),
        proposalId: z.string(),
        approve: z.boolean().default(true),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const session = await copilot.getSession(input.sessionId);
        assertSessionAccess(ctx.user, session);
        return await copilot.decideProposal({
          sessionId: input.sessionId,
          proposalId: input.proposalId,
          approve: input.approve,
        });
      } catch (e) {
        throw asTrpcError(e);
      }
    }),

  /** Approve with edits — the edited payload REPLACES the proposed one. */
  editProposal: protectedProcedure
    .input(
      z.object({
        sessionId: z.string(),
        proposalId: z.string(),
        payload: z.unknown(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const session = await copilot.getSession(input.sessionId);
        assertSessionAccess(ctx.user, session);
        return await copilot.decideProposal({
          sessionId: input.sessionId,
          proposalId: input.proposalId,
          approve: true,
          editedPayload: input.payload,
        });
      } catch (e) {
        throw asTrpcError(e);
      }
    }),

  getSession: protectedProcedure
    .input(z.object({ sessionId: z.string() }))
    .query(async ({ ctx, input }) => {
      try {
        const session = await copilot.getSession(input.sessionId);
        assertSessionAccess(ctx.user, session);
        return session;
      } catch (e) {
        throw asTrpcError(e);
      }
    }),

  listSessions: protectedProcedure
    .input(z.object({ tenantId: z.string().optional() }).optional())
    .query(async ({ ctx, input }) => {
      // Tenant admins only ever see their own tenant's sessions.
      let tenantId = input?.tenantId;
      if (ctx.user.role !== "admin") {
        tenantId = ctx.user.tenantId ?? undefined;
        if (!tenantId) return [];
      } else if (tenantId) {
        assertTenantAccess(ctx.user, tenantId);
      }
      try {
        return await copilot.listSessions(tenantId ? { tenantId } : undefined);
      } catch (e) {
        throw asTrpcError(e);
      }
    }),
});
