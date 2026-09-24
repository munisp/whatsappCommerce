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
import { eq, inArray } from "drizzle-orm";
import { operatorProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import { users } from "../../drizzle/schema";
import * as membership from "../services/membership";
import { writeAuditLog } from "./audit";

// === W46 kyc === TEN-9: scoped finance/catalog roles are grantable.
const roleEnum = z.enum(["owner", "operator", "analyst", "finance", "catalog"]);
const tenantInput = z.object({ tenantId: z.string().min(1) });

export const membershipRouter = router({
  /**
   * List all members of a tenant, enriched with name/email — the raw
   * tenant_memberships row only carries userId, which isn't something a
   * team-management UI can show a human.
   */
  list: operatorProcedure
    .input(tenantInput)
    .query(async ({ input }) => {
      const members = await membership.listMembers(input.tenantId);
      if (members.length === 0) return [];
      const db = await getDb();
      if (!db) return members.map((m) => ({ ...m, email: null, name: null }));
      const numericIds = members
        .map((m) => Number(m.userId))
        .filter((id) => Number.isInteger(id));
      const rows = numericIds.length
        ? await db
            .select({ id: users.id, email: users.email, name: users.name })
            .from(users)
            .where(inArray(users.id, numericIds))
        : [];
      const byId = new Map(rows.map((r) => [String(r.id), r]));
      return members.map((m) => ({
        ...m,
        email: byId.get(m.userId)?.email ?? null,
        name: byId.get(m.userId)?.name ?? null,
      }));
    }),

  /**
   * Look up a user by exact email, so an owner/operator can invite someone
   * they already know without needing their raw numeric user id. Only an
   * exact match is returned (no partial/fuzzy search) to avoid turning this
   * into a directory-harvesting tool — the caller must already know the
   * teammate's real email.
   */
  findUserByEmail: operatorProcedure
    .input(tenantInput.extend({ email: z.string().email() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      const rows = await db
        .select({ id: users.id, email: users.email, name: users.name })
        .from(users)
        .where(eq(users.email, input.email))
        .limit(1);
      return rows[0] ?? null;
    }),

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
      const result = await membership.addMember({
        tenantId: input.tenantId,
        userId: input.userId,
        role: input.role,
        invitedBy: ctx.user!.id,
      });
      // W40 (TEN-4): staff grants (incl. owner escalation) are audited.
      await writeAuditLog({
        actorId: String(ctx.user!.id),
        actorRole: ctx.user!.role,
        action: "membership.add",
        entityType: "tenant_membership",
        entityId: `${input.tenantId}:${input.userId}`,
        tenantId: input.tenantId,
        summary: `User ${input.userId} granted role ${input.role ?? "default"} on tenant ${input.tenantId} by ${ctx.user!.id}`,
        before: null,
        after: { userId: String(input.userId), role: input.role ?? "default" },
      });
      return result;
    }),

  /** Remove a staff member. The last owner of a tenant cannot be removed. */
  remove: operatorProcedure
    .input(
      tenantInput.extend({
        userId: z.union([z.string().min(1), z.number()]),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const result = await membership.removeMember(input.tenantId, input.userId);
      // W40 (TEN-4): staff removals are audited.
      await writeAuditLog({
        actorId: String(ctx.user!.id),
        actorRole: ctx.user!.role,
        action: "membership.remove",
        entityType: "tenant_membership",
        entityId: `${input.tenantId}:${input.userId}`,
        tenantId: input.tenantId,
        summary: `User ${input.userId} removed from tenant ${input.tenantId} by ${ctx.user!.id}`,
        before: { userId: String(input.userId) },
        after: null,
      });
      return result;
    }),
});

export type MembershipRouter = typeof membershipRouter;
