/**
 * CreditSummaryWidget — dashboard card: total outstanding across the tenant's
 * buyer-side credit accounts, next due date and utilization %. Links to the
 * Credit Accounts page.
 */
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useActiveTenant } from "@/contexts/TenantContext";
import { useCreditAccounts } from "@/lib/b2b";
import { dueCountdown, formatDate, formatNaira, summarizeCreditAccounts } from "@/lib/b2bLogic";
import { Wallet } from "lucide-react";
import { useLocation } from "wouter";

export function CreditSummaryWidget() {
  const { activeTenantId: tenantId } = useActiveTenant();
  const { data: accounts, isLoading, error } = useCreditAccounts({ tenantId, side: "buyer" });
  const [, setLocation] = useLocation();

  const summary = summarizeCreditAccounts(accounts ?? []);
  const due = dueCountdown(summary.nextDueDate);

  return (
    <Card className="bg-card border-border">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
            <Wallet className="w-4 h-4 text-primary" /> Supplier Credit
          </CardTitle>
          <Button variant="ghost" size="sm" className="text-xs h-7 text-muted-foreground" onClick={() => setLocation("/credit-accounts")}>
            View all →
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <p className="text-sm text-muted-foreground py-3">Loading credit summary…</p>
        ) : error || summary.accountCount === 0 ? (
          <p className="text-sm text-muted-foreground py-3">
            No supplier credit accounts yet.
          </p>
        ) : (
          <div className="grid grid-cols-3 gap-4">
            <div className="p-3 rounded-lg bg-accent/30 border border-border">
              <p className="text-xs text-muted-foreground">Outstanding</p>
              <p className="text-lg font-bold mt-1 text-foreground">{formatNaira(summary.totalOutstanding)}</p>
            </div>
            <div className="p-3 rounded-lg bg-accent/30 border border-border">
              <p className="text-xs text-muted-foreground">Next due</p>
              <p className="text-lg font-bold mt-1 text-foreground">{formatDate(summary.nextDueDate)}</p>
              {summary.nextDueDate && (
                <p className={`text-[11px] ${due.tone === "danger" ? "text-red-400" : due.tone === "warn" ? "text-amber-400" : "text-muted-foreground"}`}>
                  {due.label}
                </p>
              )}
            </div>
            <div className="p-3 rounded-lg bg-accent/30 border border-border">
              <p className="text-xs text-muted-foreground">Utilization</p>
              <p className={`text-lg font-bold mt-1 ${summary.utilizationPct >= 90 ? "text-red-400" : summary.utilizationPct >= 70 ? "text-amber-400" : "text-emerald-400"}`}>
                {summary.utilizationPct}%
              </p>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
