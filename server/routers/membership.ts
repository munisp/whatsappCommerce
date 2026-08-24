/**
 * W12 tenancy — tenant membership (staff) router.
 *
 * This is the staff-invite path: an owner/operator (or platform admin)
 * directly adds a user to a tenant with a role. Magic-link invite
 * hardening (tenantInvite router) lands separately via W12-A's guard.
 *
 * All procedures require a `tenantId` in the input and are gated by
 * operatorProcedure (platform admins bypass; members need owner/operator).
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { operatorProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import * as membership from "../services/membership";

const roleEnum = z.enum(["owner", "operator", "analyst"]);
const tenantInput = z.object({ tenantId: z.string().min(1) });

export const membershipRouter = router({
  /** List all members of a tenant. */
  list: operatorProcedure
    .input(tenantInput)
    .query(({ input }) => membership.listMembers(input.tenantId)),

  /** My own membership in a tenant (role discovery for the UI). */
  myMembership: operatorProcedure
    .input(tenantInput)
    .query(({ ctx, input }) => membership.getMembership(ctx.user!.id, input.tenantId)),

  /**
   * Add a staff member to a tenant. The first member of a tenant is forced
   * to 'owner'. Re-adding an existing member updates their role.
   *
   * W30 (V2#12): ordinary grants are capped at ≤ operator — an operator must
   * never escalate anyone (including themselves) to owner. Granting owner
   * requires the caller to be an owner (or platform admin) AND a fresh
   * step-up OTP to the tenant admin phone (purpose "owner_grant").
   */
  add: operatorProcedure
    .input(
      tenantInput.extend({
        userId: z.union([z.string().min(1), z.number()]),
        role: roleEnum.optional(),
        stepUpChallengeId: z.string().uuid().optional(),
        stepUpOtp: z.string().length(6).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (input.role === "owner") {
        const callerRole = ctx.user!.role === "admin" ? "admin" : ctx.membership?.role;
        if (callerRole !== "admin" && callerRole !== "owner") {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Only an existing owner (or platform admin) can grant the owner role",
          });
        }
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
        const { requireStepUp } = await import("../services/stepUp");
        await requireStepUp(db, {
          required: true,
          tenantId: input.tenantId,
          userId: ctx.user!.id,
          purpose: "owner_grant",
          stepUpChallengeId: input.stepUpChallengeId,
          stepUpOtp: input.stepUpOtp,
        });
      }
      return membership.addMember({
        tenantId: input.tenantId,
        userId: input.userId,
        role: input.role,
        invitedBy: ctx.user!.id,
      });
    }),

  /** Remove a staff member. The last owner of a tenant cannot be removed. */
  remove: operatorProcedure
    .input(
      tenantInput.extend({
        userId: z.union([z.string().min(1), z.number()]),
      }),
    )
    .mutation(({ input }) => membership.removeMember(input.tenantId, input.userId)),
});

export type MembershipRouter = typeof membershipRouter;
