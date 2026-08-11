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
import { operatorProcedure, router } from "../_core/trpc";
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
   */
  add: operatorProcedure
    .input(
      tenantInput.extend({
        userId: z.union([z.string().min(1), z.number()]),
        role: roleEnum.optional(),
      }),
    )
    .mutation(({ ctx, input }) =>
      membership.addMember({
        tenantId: input.tenantId,
        userId: input.userId,
        role: input.role,
        invitedBy: ctx.user!.id,
      }),
    ),

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
