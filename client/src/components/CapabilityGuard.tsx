import React from "react";
import { useCapability } from "@/hooks/useCapability";
import { Badge } from "@/components/ui/badge";
import { Lock } from "lucide-react";
import type { Capability } from "@shared/capabilities";

const CAPABILITY_LABEL: Record<Capability, string> = {
  finance: "Finance",
  catalog: "Catalog",
  orders: "Orders",
  reports: "Reports",
};

/**
 * Principle of least access: a tenant staff role (owner/operator/analyst/
 * finance/catalog) only sees the pages its capability map actually grants —
 * hiding the nav link was never enough on its own (same lesson as the
 * platform-admin pages earlier this session: a hidden link still leaves the
 * page reachable, and readable, by direct URL). This is the real boundary
 * for the pages listed against a capability in DashboardLayout's
 * TENANT_NAV_GROUPS (requiresCapability) — analogous to AdminGuard, but for
 * the tenant-role axis instead of the platform-admin one.
 */
export function CapabilityGuard({ cap, children }: { cap: Capability; children: React.ReactNode }) {
  const { role, has, loading } = useCapability();
  if (loading) return <div className="p-8 text-center text-muted-foreground">Loading...</div>;
  if (!has(cap)) {
    return (
      <div className="p-8 text-center">
        <Lock className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
        <h2 className="text-xl font-semibold mb-2">Access Restricted</h2>
        <p className="text-muted-foreground">This page requires the "{CAPABILITY_LABEL[cap]}" capability.</p>
        {role && <Badge variant="outline" className="mt-2">Your role: {role}</Badge>}
      </div>
    );
  }
  return <>{children}</>;
}
