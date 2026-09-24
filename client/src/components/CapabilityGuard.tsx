import React from "react";
import { useCapability } from "@/hooks/useCapability";
import { Badge } from "@/components/ui/badge";
import { Lock } from "lucide-react";
import type { Capability, MembershipRole } from "@shared/capabilities";

const CAPABILITY_LABEL: Record<Capability, string> = {
  finance: "Finance",
  catalog: "Catalog",
  orders: "Orders",
  reports: "Reports",
};

const ROLE_LABEL: Record<MembershipRole, string> = {
  owner: "Owner",
  operator: "Operator",
  analyst: "Analyst",
  finance: "Finance",
  catalog: "Catalog",
};

type CapabilityGuardProps =
  | { cap: Capability; roles?: never; children: React.ReactNode }
  | { roles: readonly MembershipRole[]; cap?: never; children: React.ReactNode };

/**
 * Principle of least access: a tenant staff role (owner/operator/analyst/
 * finance/catalog) only sees the pages its scope actually covers — hiding
 * the nav link was never enough on its own (same lesson as the
 * platform-admin pages earlier this session: a hidden link still leaves the
 * page reachable, and readable, by direct URL). This is the real boundary
 * for the pages listed against a scope in DashboardLayout's
 * TENANT_NAV_GROUPS (requiresCapability / requiresRoles) — analogous to
 * AdminGuard, but for the tenant-role axis instead of the platform-admin
 * one.
 *
 * Two ways to specify what's required:
 *   cap    — one of the server's 4 defined capabilities (shared/capabilities.ts),
 *            matching what moneyProcedure/assertCapabilityAccess actually enforce.
 *   roles  — an explicit role allowlist, for areas with no clean single-capability
 *            fit (e.g. tenant configuration, which is really "whoever manages this
 *            business" rather than any one of finance/catalog/orders/reports).
 */
export function CapabilityGuard(props: CapabilityGuardProps) {
  const { role, has, loading } = useCapability();
  if (loading) return <div className="p-8 text-center text-muted-foreground">Loading...</div>;

  const allowed = props.cap ? has(props.cap) : role != null && props.roles.includes(role);
  if (!allowed) {
    const requirement = props.cap
      ? `the "${CAPABILITY_LABEL[props.cap]}" capability`
      : props.roles.map((r) => ROLE_LABEL[r]).join(" or ");
    return (
      <div className="p-8 text-center">
        <Lock className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
        <h2 className="text-xl font-semibold mb-2">Access Restricted</h2>
        <p className="text-muted-foreground">This page requires {requirement}.</p>
        {role && <Badge variant="outline" className="mt-2">Your role: {role}</Badge>}
      </div>
    );
  }
  return <>{props.children}</>;
}
