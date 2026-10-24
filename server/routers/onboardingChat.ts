// === W65 conversational ===
/**
 * server/routers/onboardingChat.ts — R2 chat-first web onboarding.
 *
 * Thin web-wizard-shaped facade over the EXISTING onboarding copilot service
 * (server/services/onboardingCopilot — the same agent/tools that power
 * WhatsApp onboarding via waOnboarding.ts). Sessions live in the existing
 * DB-backed onboarding_sessions table (channel 'admin'), so no new table is
 * needed and the copilot's checkpoint invariant (human approval before
 * apply/go-live) is enforced by the service layer exactly as on WhatsApp.
 *
 *   onboardingChat.start  — start (or resume) a chat session
 *   onboardingChat.step   — send one user message; returns agent replies
 *                           (text + confirmable proposal cards) and state
 *   onboardingChat.reset  — abandon the active session and start fresh
 *
 * The final "review & edit" + tenant creation still goes through the
 * EXISTING tenant creation path (tenant.create / copilot goLive) — this
 * router adds nothing money-adjacent.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, protectedProcedure } from "../_core/trpc";
import * as copilot from "../services/onboardingCopilot";

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

/** Session snapshot the wizard renders (transcript + confirmable cards). */
async function snapshot(sessionId: string) {
  const session = await copilot.getSession(sessionId);
  if (!session) throw new TRPCError({ code: "NOT_FOUND", message: "Onboarding chat session not found" });
  return {
    sessionId: session.id,
    state: session.state,
    tenantId: session.tenantId,
    transcript: session.transcript,
    proposals: session.proposals,
    intake: session.intake,
    terminal: copilot.TERMINAL_STATES.includes(session.state),
  };
}

export const onboardingChatRouter = router({
  /** Start a chat-first onboarding session (or return the active one). */
  start: protectedProcedure
    .input(
      z.object({
        tenantId: z.string().optional(),
        language: z.string().max(20).optional(),
        resume: z.boolean().default(true),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        if (input.resume) {
          const sessions = await copilot.listSessions();
          const active = sessions.find((s) => s.channel === "admin" && !copilot.TERMINAL_STATES.includes(s.state));
          if (active) return { ...(await snapshot(active.id)), greeting: null as string | null, resumed: true };
        }
        const { sessionId, greeting } = await copilot.startSession({
          channel: "admin",
          tenantId: input.tenantId,
          language: (input.language as copilot.CopilotLanguage | undefined),
        });
        return { ...(await snapshot(sessionId)), greeting, resumed: false };
      } catch (e) {
        throw asTrpcError(e);
      }
    }),

  /** Send one wizard answer / free-text message; returns the agent's replies. */
  step: protectedProcedure
    .input(z.object({ sessionId: z.string(), text: z.string().min(1).max(4000) }))
    .mutation(async ({ ctx, input }) => {
      try {
        const session = await copilot.getSession(input.sessionId);
        if (!session) throw new TRPCError({ code: "NOT_FOUND", message: "Onboarding chat session not found" });
        const { replies } = await copilot.postMessage({ sessionId: input.sessionId, text: input.text });
        return { ...(await snapshot(input.sessionId)), replies };
      } catch (e) {
        throw asTrpcError(e);
      }
    }),

  /** Decide on a proposal card (confirm/edit/reject) — the human checkpoint. */
  decide: protectedProcedure
    .input(
      z.object({
        sessionId: z.string(),
        proposalId: z.string(),
        approve: z.boolean().default(true),
        editedPayload: z.unknown().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const session = await copilot.getSession(input.sessionId);
        if (!session) throw new TRPCError({ code: "NOT_FOUND", message: "Onboarding chat session not found" });
        await copilot.decideProposal({
          sessionId: input.sessionId,
          proposalId: input.proposalId,
          approve: input.approve,
          editedPayload: input.editedPayload,
        });
        return snapshot(input.sessionId);
      } catch (e) {
        throw asTrpcError(e);
      }
    }),

  /** Abandon the active session and start a fresh one. */
  reset: protectedProcedure
    .input(z.object({ sessionId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      try {
        const session = await copilot.getSession(input.sessionId);
        if (!session) throw new TRPCError({ code: "NOT_FOUND", message: "Onboarding chat session not found" });
        if (!copilot.TERMINAL_STATES.includes(session.state)) {
          await copilot.abandonSession(input.sessionId);
        }
        const { sessionId, greeting } = await copilot.startSession({ channel: "admin" });
        return { ...(await snapshot(sessionId)), greeting };
      } catch (e) {
        throw asTrpcError(e);
      }
    }),
});
