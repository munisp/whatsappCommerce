/**
 * === W46 kyc === TEN-9 — scoped staff capability model.
 *
 * The 3-role model (owner/operator/analyst) let ANY operator move money.
 * W46 adds two scoped roles (stored on tenant_memberships.role, varchar —
 * no DB enum change) and a static role→capability map enforced at the
 * procedure layer:
 *
 *   owner    — all capabilities (tenant administrator)
 *   operator — catalog + orders (day-to-day) — plus finance for legacy
 *              compatibility at the moneyProcedure/assertMoneyAccess gates
 *              (they admit owner|operator|finance); tightening operator out
 *              of finance is a follow-up behind tenant opt-in.
 *   analyst  — read-only reporting
 *   finance  — finance ONLY (withdrawals, refunds, escrow release, payouts)
 *   catalog  — catalog ONLY (product create/update/import)
 *
 * Enforcement points:
 *   - moneyProcedure + assertMoneyAccess (server/_core/trpc.ts) admit the
 *     scoped "finance" role; "catalog"/"analyst" can NEVER move money.
 *   - Catalog mutations (product.create/update/importCsv) call
 *     assertCapabilityAccess(..., "catalog") — a finance-only role is
 *     refused; the scoped "catalog" role passes without any money access.
 *
 * Legacy fallback (unchanged from assertMoneyAccess semantics): when NO
 * tenant_memberships row exists, the legacy users.tenantId / memberships
 * shortcuts pass — single-user legacy merchants are unaffected. The moment
 * a staff row exists, the capability map is authoritative.
 *
 * DEFERRED (documented honestly): full per-tenant Permify capability
 * graphs (user-defined custom roles, relation-based scoping) are NOT
 * implemented — the map above is static per role. Permify remains
 * defense-in-depth on adminProcedure only.
 */
import { TRPCError } from "@trpc/server";
import { getMembership, hasAnyMembership, membershipRoleEnum } from "./membership";
import type { MembershipRole } from "../../drizzle/schema";

export type Capability = "finance" | "catalog" | "orders" | "reports";

export const ROLE_CAPABILITIES: Record<MembershipRole, readonly Capability[]> = {
  owner: ["finance", "catalog", "orders", "reports"],
  operator: ["finance", "catalog", "orders"], // finance retained as legacy compat (see header)
  analyst: ["reports"],
  finance: ["finance"],
  catalog: ["catalog"],
};

/** Does this membership role hold the given capability? */
export function roleHasCapability(role: MembershipRole, cap: Capability): boolean {
  return (ROLE_CAPABILITIES[role] ?? []).includes(cap);
}

/**
 * Require `cap` for `tenantId`. Semantics mirror assertMoneyAccess:
 *   - platform admins bypass;
 *   - a tenant_memberships row must hold the capability (scoped roles are
 *     authoritative — a finance-only row fails a catalog check);
 *   - with no membership row, the legacy users.tenantId / memberships
 *     shortcuts pass exactly as assertTenantAccess allows.
 */
export async function assertCapabilityAccess(
  user: {
    id: string | number;
    role: string;
    tenantId?: string | null;
    memberships?: readonly string[] | null;
  },
  tenantId: string,
  cap: Capability,
): Promise<void> {
  if (user.role === "admin") return;
  let membership = null as Awaited<ReturnType<typeof getMembership>>;
  let lookupFailed = false;
  try {
    membership = await getMembership(user.id, tenantId);
  } catch (err) {
    lookupFailed = true;
    console.error(`[assertCapabilityAccess:${cap}] membership lookup failed:`, (err as Error)?.message);
    membership = null;
  }
  // A row without a valid role is malformed (or a stubbed lookup leaking an
  // unrelated row) — the column is NOT NULL in the real schema, so treat it
  // as no membership and fall through to the checks below.
  if (membership && (membershipRoleEnum as readonly string[]).includes(membership.role)) {
    if (roleHasCapability(membership.role, cap)) return;
    throw new TRPCError({
      code: "FORBIDDEN",
      message: `This action requires the "${cap}" capability (your role "${membership.role}" does not grant it)`,
    });
  }
  // === W47 stakeholders === ONB-S-6/S-7: fail CLOSED.
  // - When the tenant HAS membership rows, the capability map is
  //   authoritative — the legacy users.tenantId / memberships shortcuts do
  //   NOT pass (a removed staffer with an intact users.tenantId regains
  //   nothing).
  // - When the membership lookup failed and we cannot even determine
  //   whether rows exist, deny (loudly) instead of falling through to the
  //   legacy shortcuts during a DB wobble.
  const anyRows = await hasAnyMembership(tenantId);
  if (anyRows === null && lookupFailed) {
    console.error(`[assertCapabilityAccess:${cap}] FAIL-CLOSED: membership lookup failed for user ${user.id} on tenant ${tenantId}`);
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Membership lookup failed — access denied (fail closed). Retry shortly.",
    });
  }
  if (anyRows === true) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: `This action requires the "${cap}" capability via a tenant membership (legacy shortcuts are disabled once a tenant has staff roles)`,
    });
  }
  // === END W47 stakeholders ===
  if (user.tenantId && user.tenantId === tenantId) return;
  if (Array.isArray(user.memberships) && user.memberships.includes(tenantId)) return;
  throw new TRPCError({
    code: "FORBIDDEN",
    message: "You can only access your own tenant's data",
  });
}
// === END W46 kyc ===
