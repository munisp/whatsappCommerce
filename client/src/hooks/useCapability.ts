import { trpc } from "@/lib/trpc";
import { useActiveTenant } from "@/contexts/TenantContext";
import { roleHasCapability, type Capability, type MembershipRole } from "@shared/capabilities";

/**
 * QA follow-up: the UI had no way to know what a tenant role (owner/
 * operator/analyst/finance/catalog) could actually do, so every write
 * action rendered as clickable regardless of role — a non-owner/operator
 * account only found out it lacked permission after the server rejected the
 * request. This mirrors the same role→capability map the server enforces
 * (shared/capabilities.ts), so a disabled button here matches what the
 * server will actually allow, not a guess at it.
 */
export function useCapability(tenantIdOverride?: string) {
  // Most pages read the active tenant from TenantContext, but a few
  // money-moving pages (e.g. MerchantWallet) deliberately source their own
  // tenantId from a session-derived query instead, precisely to avoid a
  // stale/placeholder TenantContext value — pass that same id in here so
  // this hook checks the role for the SAME tenant the page actually acts on.
  const { activeTenantId } = useActiveTenant();
  const tenantId = tenantIdOverride ?? activeTenantId;
  const { data, isLoading } = trpc.membership.myRole.useQuery(
    { tenantId },
    { enabled: !!tenantId },
  );
  const role = (data?.role ?? null) as MembershipRole | null;
  const has = (cap: Capability) => role != null && roleHasCapability(role, cap);
  return { role, has, loading: !!activeTenantId && isLoading };
}
