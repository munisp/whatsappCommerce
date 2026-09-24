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
import { and, eq, isNull } from "drizzle-orm";
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
  let result: TenantMembership;
  if (current) {
    // Already a member: update role if a different one was requested.
    if (input.role && input.role !== current.role) {
      const updated = await db
        .update(tenantMemberships)
        .set({ role: input.role })
        .where(eq(tenantMemberships.id, current.id))
        .returning();
      result = updated[0] ?? { ...current, role: input.role };
    } else {
      result = current;
    }
  } else {
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
    result = inserted[0];
    // QA follow-up: removeMember() unconditionally sets a 24h "revoke every
    // future session" marker for whoever it removes. Re-adding that same
    // person here never cleared it, so every one of their NEW logins kept
    // silently failing isSessionRevoked() for up to 24h — the raw
    // /api/auth/me route (no revocation check) showed them signed in while
    // every tRPC call (which does check) treated them as signed out, with
    // nothing logged anywhere to explain why. Only on a genuine re-add (this
    // branch, not the role-update branch above) — an admin's explicit
    // kill-switch on someone who NEVER left the tenant must not be silently
    // undone by an unrelated role change.
    const { clearUserSessionRevocation } = await import("../_core/sdk");
    await clearUserSessionRevocation(input.userId).catch((err) =>
      console.error("[membership.addMember] clearing session revocation failed:", (err as Error)?.message),
    );
  }
  // QA follow-up: a staff member granted ONLY here (tenant_memberships) still
  // had users.tenantId = null — and the client's "does this user have a
  // business yet" gate (needsBusinessSetup, client/src/lib/tenantAccess.ts)
  // looks at users.tenantId alone, not tenant_memberships, so an invited
  // teammate kept landing on the "set up your business" wizard forever, even
  // once they were a real member. Mirrors what removeMember already does
  // symmetrically on the way out. Only sets it when currently unset — never
  // override an existing home tenant for someone who already has one.
  const numericId = Number(userId);
  if (Number.isInteger(numericId)) {
    const { users } = await import("../../drizzle/schema");
    await db.update(users)
      .set({ tenantId: input.tenantId, updatedAt: new Date() })
      .where(and(eq(users.id, numericId), isNull(users.tenantId)));
  }
  return result;
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

  // === W46 kyc === TEN-10 access kill (best-effort after the row delete —
  // the membership row is already gone, so a failure here can only delay,
  // never grant, access). Previously the removed user's sessions and cached
  // membership snapshot kept working for up to 60s (and users.tenantId kept
  // the legacy shortcut alive indefinitely).
  try {
    const { users } = await import("../../drizzle/schema");
    const numericId = Number(userId);
    if (Number.isInteger(numericId)) {
      // users.id is a serial — only clear the legacy shortcut when the
      // membership userId maps to a users row.
      await db.update(users)
        .set({ tenantId: null, updatedAt: new Date() })
        .where(and(eq(users.id, numericId), eq(users.tenantId, tenantId)));
    }
  } catch (err) {
    console.error("[membership.removeMember] clearing users.tenantId failed:", (err as Error)?.message);
  }
  try {
    const sdk = await import("../_core/sdk");
    await sdk.revokeAllUserSessions(userId);
    sdk.invalidateMembershipCache(userId);
  } catch (err) {
    console.error("[membership.removeMember] session revocation failed:", (err as Error)?.message);
  }
  // === END W46 kyc ===
  return { removed: true };
}
