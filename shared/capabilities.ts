/**
 * === W46 kyc === TEN-9 — scoped staff capability model.
 *
 * The single source of truth for tenant_memberships.role → capability,
 * shared between server (server/services/capabilities.ts enforces it) and
 * client (QA follow-up: the UI had no way to know what a role could do,
 * so every write action rendered as clickable regardless of role — this
 * lets the client match, not guess, what the server will actually allow).
 *
 *   owner    — all capabilities (tenant administrator)
 *   operator — catalog + orders (day-to-day) — plus finance for legacy
 *              compatibility at the moneyProcedure/assertMoneyAccess gates
 *              (they admit owner|operator|finance); tightening operator out
 *              of finance is a follow-up behind tenant opt-in.
 *   analyst  — read-only reporting
 *   finance  — finance ONLY (withdrawals, refunds, escrow release, payouts)
 *   catalog  — catalog ONLY (product create/update/import)
 */
export const membershipRoleEnum = ["owner", "operator", "analyst", "finance", "catalog"] as const;
export type MembershipRole = (typeof membershipRoleEnum)[number];

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
