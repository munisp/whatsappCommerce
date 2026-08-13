/**
 * SupplierCard — directory card for a supplier tenant: categories, MOQ, lead
 * time, terms chips, the viewer's credit position (if an account exists) and
 * Request-credit / Start-PO CTAs.
 */
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { LimitGauge } from "@/components/b2b/LimitGauge";
import { formatNaira, suspensionBadge, suspensionBlockReason, type SupplierSummary } from "@/lib/b2bLogic";
import { Ban, Building2, Clock, HandCoins, ShoppingCart } from "lucide-react";

export function SupplierCard({
  supplier,
  onRequestCredit,
  onStartPo,
  requestingCredit = false,
}: {
  supplier: SupplierSummary;
  onRequestCredit: (supplier: SupplierSummary) => void;
  onStartPo: (supplier: SupplierSummary) => void;
  requestingCredit?: boolean;
}) {
  const account = supplier.myAccount ?? null;
  const suspendedBadge = suspensionBadge(account);
  const blockReason = suspensionBlockReason(account);
  return (
    <Card className="flex flex-col">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Building2 className="w-4 h-4 text-primary shrink-0" />
          <span className="truncate">{supplier.businessName}</span>
        </CardTitle>
        {supplier.categories.length > 0 && (
          <div className="flex flex-wrap gap-1 pt-1">
            {supplier.categories.slice(0, 4).map((c) => (
              <Badge key={c} variant="secondary" className="text-[10px] font-normal">{c}</Badge>
            ))}
            {supplier.categories.length > 4 && (
              <Badge variant="secondary" className="text-[10px] font-normal">+{supplier.categories.length - 4}</Badge>
            )}
          </div>
        )}
      </CardHeader>
      <CardContent className="flex-1 flex flex-col gap-3 text-sm">
        <div className="flex items-center justify-between text-muted-foreground">
          <span>Min order</span>
          <span className="text-foreground font-medium">{formatNaira(supplier.moq)}</span>
        </div>
        <div className="flex items-center justify-between text-muted-foreground">
          <span className="flex items-center gap-1"><Clock className="w-3.5 h-3.5" /> Lead time</span>
          <span className="text-foreground font-medium">{supplier.leadTimeDays}d</span>
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-muted-foreground">Terms</span>
          <div className="flex gap-1 flex-wrap justify-end">
            {supplier.termsDays.length > 0 ? (
              supplier.termsDays.map((d) => (
                <Badge key={d} variant="outline" className="text-[10px] font-normal text-muted-foreground">net {d}d</Badge>
              ))
            ) : (
              <span className="text-xs text-muted-foreground">pay on delivery</span>
            )}
          </div>
        </div>

        {account && (
          <div className="rounded-lg border border-border p-2.5 space-y-1.5">
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">Your credit</span>
              <div className="flex items-center gap-1">
                {suspendedBadge && (
                  <Badge variant="outline" className={`text-[10px] font-normal gap-1 ${suspendedBadge.className}`}>
                    <Ban className="w-3 h-3" /> {suspendedBadge.label}
                  </Badge>
                )}
                <Badge
                  variant="outline"
                  className={`text-[10px] font-normal ${account.status === "active" ? "border-emerald-500/40 text-emerald-400" : "border-red-500/40 text-red-400"}`}
                >
                  {account.status}
                </Badge>
              </div>
            </div>
            <LimitGauge used={account.outstanding} limit={account.limit} compact />
            {blockReason && (
              <p className="text-[11px] text-red-400/90 leading-snug">{blockReason}</p>
            )}
          </div>
        )}

        <div className="mt-auto flex gap-2 pt-1">
          {!account && (
            <Button
              variant="outline"
              size="sm"
              className="flex-1 gap-1.5"
              disabled={requestingCredit}
              onClick={() => onRequestCredit(supplier)}
            >
              <HandCoins className="w-3.5 h-3.5" /> Request credit
            </Button>
          )}
          <Button
            size="sm"
            className="flex-1 gap-1.5"
            disabled={!!blockReason}
            title={blockReason ?? undefined}
            onClick={() => onStartPo(supplier)}
          >
            {blockReason ? <Ban className="w-3.5 h-3.5" /> : <ShoppingCart className="w-3.5 h-3.5" />}
            {blockReason ? "Ordering suspended" : "Start PO"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
