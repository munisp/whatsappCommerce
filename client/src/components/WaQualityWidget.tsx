/**
 * WaQualityWidget — WhatsApp messaging-quality card for the platform
 * dashboard, backed by metering.getWaQuality ({refresh?} → cached
 * settings.waQuality snapshot: rating HIGH/MEDIUM/LOW, messaging tier,
 * checkedAt, lastError). A LOW rating blocks template/broadcast sends, so we
 * surface a warning callout.
 */
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { trpc } from "@/lib/trpc";
import { useActiveTenant } from "@/contexts/TenantContext";
import { waQualityBadge } from "@/lib/waOps";
import { AlertTriangle, HeartPulse, Loader2, RefreshCw } from "lucide-react";

export default function WaQualityWidget() {
  const { activeTenantId } = useActiveTenant();
  const tenantId = activeTenantId;
  const utils = trpc.useUtils();

  const { data, isLoading } = trpc.metering.getWaQuality.useQuery({ tenantId });
  const refresh = trpc.metering.getWaQuality.useQuery(
    { tenantId, refresh: true },
    { enabled: false },
  );

  const onRefresh = async () => {
    const r = await refresh.refetch();
    if (r.error) {
      // Surface but keep cached view.
      console.warn("[waQuality] refresh failed", r.error);
    }
    utils.metering.getWaQuality.invalidate({ tenantId });
  };

  const quality = data?.quality ?? null;
  const badge = waQualityBadge(quality?.rating ?? "UNKNOWN");
  const refreshing = refresh.isFetching;

  return (
    <Card className="bg-card border-border">
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
          <HeartPulse className="w-4 h-4" />
          WhatsApp quality
        </CardTitle>
        <Button variant="ghost" size="sm" className="h-7 gap-1.5" onClick={onRefresh} disabled={refreshing || isLoading}>
          {refreshing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          Refresh
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading ? (
          <div className="flex items-center gap-2 text-muted-foreground text-sm">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading…
          </div>
        ) : !quality ? (
          <p className="text-sm text-muted-foreground">
            No quality data yet — hit Refresh to pull the current rating from Meta.
          </p>
        ) : (
          <>
            <div className="flex items-center gap-3 flex-wrap">
              <Badge variant="outline" className={badge.className}>
                {badge.label} quality
              </Badge>
              {quality.tier && (
                <span className="text-sm text-muted-foreground">
                  Tier: <span className="font-medium text-foreground">{quality.tier}</span>
                </span>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              Checked {quality.checkedAt ? new Date(quality.checkedAt).toLocaleString() : "never"}
            </p>
            {quality.rating === "LOW" && (
              <div className="flex items-start gap-2 rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-400">
                <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                Broadcasts blocked until rating recovers. Reduce template volume and resolve recent
                user blocks/reports to lift the rating.
              </div>
            )}
            {quality.lastError && (
              <p className="text-xs text-red-400">Last check error: {quality.lastError}</p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
