/**
 * PendingPoApprovalsWidget — dashboard card: count of supplier-side POs
 * awaiting my approval, with a link to the approvals inbox.
 */
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useActiveTenant } from "@/contexts/TenantContext";
import { usePos } from "@/lib/b2b";
import { countPendingApprovals } from "@/lib/b2bLogic";
import { ClipboardCheck } from "lucide-react";
import { useLocation } from "wouter";

export function PendingPoApprovalsWidget() {
  const { activeTenantId: tenantId } = useActiveTenant();
  const { data: pos, isLoading, error } = usePos({ tenantId, side: "supplier", status: "submitted" });
  const [, setLocation] = useLocation();

  const count = countPendingApprovals(pos ?? []);
  const hasPending = count > 0;

  return (
    <Card className={`border ${hasPending ? "border-amber-500/40 bg-amber-500/5" : "bg-card border-border"}`}>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
            <ClipboardCheck className={`w-4 h-4 ${hasPending ? "text-amber-400" : "text-primary"}`} />
            PO Approvals
          </CardTitle>
          <Button variant="ghost" size="sm" className="text-xs h-7 text-muted-foreground" onClick={() => setLocation("/supplier-approvals")}>
            Open inbox →
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <p className="text-sm text-muted-foreground py-3">Loading approvals…</p>
        ) : error ? (
          <p className="text-sm text-muted-foreground py-3">Approvals inbox unavailable.</p>
        ) : (
          <div className="flex items-end justify-between">
            <div>
              <p className={`text-3xl font-bold ${hasPending ? "text-amber-400" : "text-foreground"}`}>{count}</p>
              <p className="text-xs text-muted-foreground mt-1">
                {hasPending ? "purchase orders waiting on your decision" : "no purchase orders waiting"}
              </p>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
