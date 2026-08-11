/**
 * W12 tenancy — multi-user tenant membership service.
 *
 * tenant_memberships is the authoritative staff mapping for a tenant:
 *   owner    — full control (first member of a tenant auto-becomes owner)
 *   operator — day-to-day operations (orders, products, conversations)
 *   analyst  — read-only analytics/BI
 *
 * users.tenantId remains the "home tenant" shortcut for legacy callers;
 * assertTenantAccess (server/_core/trpc.ts) falls back to this table so
 * staff who belong to a tenant WITHOUT users.tenantId set still pass.
 * Platform admins (users.role = 'admin') bypass all membership checks.
 */
import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { getDb } from "../db";
import {
  tenantMemberships,
  membershipRoleEnum,
  type MembershipRole,
  type TenantMembership,
} from "../../drizzle/schema";

export { membershipRoleEnum };
export type { MembershipRole, TenantMembership };

const FORBIDDEN = (message: string) =>
  new TRPCError({ code: "FORBIDDEN", message });

function toUserKey(userId: string | number): string {
  return String(userId);
}

/** Fetch the membership row for (userId, tenantId), or null. */
export async function getMembership(
  userId: string | number,
  tenantId: string,
): Promise<TenantMembership | null> {
  const db = await getDb();
  if (!db) return null;
  const rows = await db
    .select()
    .from(tenantMemberships)
    .where(
      and(
        eq(tenantMemberships.userId, toUserKey(userId)),
        eq(tenantMemberships.tenantId, tenantId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Require the user to hold one of `roles` in `tenantId`.
 * Admin bypass is preserved (returns a synthetic owner membership).
 * Throws FORBIDDEN for non-members and insufficient roles.
 */
export async function requireRole(
  user: { id: string | number; role: string },
  tenantId: string,
  roles: readonly MembershipRole[],
): Promise<TenantMembership> {
  if (user.role === "admin") {
    return {
      id: "admin-bypass",
      tenantId,
      userId: toUserKey(user.id),
      role: "owner",
      invitedBy: null,
      createdAt: new Date(0),
    };
  }
  const membership = await getMembership(user.id, tenantId);
  if (!membership) {
    throw FORBIDDEN("You are not a member of this tenant");
  }
  if (!roles.includes(membership.role)) {
    throw FORBIDDEN(
      `This action requires one of: ${roles.join(", ")} (you are ${membership.role})`,
    );
  }
  return membership;
}

/** List all members of a tenant (any role). */
export async function listMembers(tenantId: string): Promise<TenantMembership[]> {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(tenantMemberships)
    .where(eq(tenantMemberships.tenantId, tenantId));
}

/**
 * Add a member to a tenant (direct staff-add by an owner/admin — this is the
 * staff-invite path until W12-A's magic-link invite guard lands).
 * The FIRST member of a tenant is always forced to 'owner'.
 * Re-adding an existing member updates their role (upsert semantics).
 */
export async function addMember(input: {
  tenantId: string;
  userId: string | number;
  role?: MembershipRole;
  invitedBy?: string | number | null;
}): Promise<TenantMembership> {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
  const userId = toUserKey(input.userId);
  const existing = await listMembers(input.tenantId);
  const current = existing.find((m) => m.userId === userId);
  if (current) {
    // Already a member: update role if a different one was requested.
    if (input.role && input.role !== current.role) {
      const updated = await db
        .update(tenantMemberships)
        .set({ role: input.role })
        .where(eq(tenantMemberships.id, current.id))
        .returning();
      return updated[0] ?? { ...current, role: input.role };
    }
    return current;
  }
  const role: MembershipRole =
    existing.length === 0 ? "owner" : (input.role ?? "operator");
  const inserted = await db
    .insert(tenantMemberships)
    .values({
      tenantId: input.tenantId,
      userId,
      role,
      invitedBy: input.invitedBy != null ? toUserKey(input.invitedBy) : null,
    })
    .returning();
  return inserted[0];
}

/**
 * Remove a member from a tenant. The LAST owner of a tenant cannot be
 * removed (a tenant must always have at least one owner).
 */
export async function removeMember(
  tenantId: string,
  userId: string | number,
): Promise<{ removed: true }> {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
  const membership = await getMembership(userId, tenantId);
  if (!membership) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Membership not found" });
  }
  if (membership.role === "owner") {
    const owners = (await listMembers(tenantId)).filter((m) => m.role === "owner");
    if (owners.length <= 1) {
      throw FORBIDDEN("Cannot remove the last owner of a tenant");
    }
  }
  await db.delete(tenantMemberships).where(eq(tenantMemberships.id, membership.id));
  return { removed: true };
}
