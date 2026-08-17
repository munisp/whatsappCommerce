/**
 * W17 F11 CRM page — commerce-native lead pipeline on top of Twenty.
 *
 * Pipeline summary cards (stage buckets + total value), band distribution,
 * at-risk win-back list with a one-click draft broadcast CTA (links into the
 * existing /broadcast flow), and a per-customer lead-score breakdown drawer
 * listing every explainable factor delta. Mobile-responsive (cards stack,
 * drawer is full-width on small screens).
 */
import { useState } from "react";
import { Link } from "wouter";
import DashboardLayout from "@/components/DashboardLayout";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { toast } from "sonner";
import {
  Users, Flame, Thermometer, Snowflake, RefreshCw, Loader2,
  AlertTriangle, Megaphone, TrendingUp, BrainCircuit,
} from "lucide-react";

/** W20: ML propensity % + source badge. */
function PropensityBadge({ propensity, scoreSource }: { propensity?: number | null; scoreSource?: "ml" | "rules" | null }) {
  if (propensity == null) return null;
  const pct = Math.round(propensity * 100);
  return (
    <span className="flex items-center gap-1">
      <span className="text-xs font-semibold text-emerald-400">{pct}%</span>
      <span
        className={`text-[10px] px-1.5 py-0.5 rounded border font-medium uppercase ${
          scoreSource === "ml"
            ? "bg-violet-500/20 text-violet-400 border-violet-500/30"
            : "bg-muted text-muted-foreground border-border"
        }`}
        title={scoreSource === "ml" ? "ML propensity model" : "Rule-based score (ML model not trained yet)"}
      >
        {scoreSource === "ml" ? "ML" : "Rules"}
      </span>
    </span>
  );
}

const STAGE_LABELS: Record<string, string> = {
  new_lead: "New leads",
  engaged: "Engaged",
  first_order: "First order",
  repeat: "Repeat buyers",
  vip: "VIP",
  at_risk: "At risk",
};

const BAND_STYLES: Record<string, string> = {
  hot: "bg-red-500/20 text-red-400 border-red-500/30",
  warm: "bg-amber-500/20 text-amber-400 border-amber-500/30",
  cold: "bg-sky-500/20 text-sky-400 border-sky-500/30",
};

function BandBadge({ band }: { band?: string | null }) {
  const b = band ?? "cold";
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full border font-medium capitalize ${BAND_STYLES[b] ?? "bg-muted text-muted-foreground border-border"}`}>
      {band ?? "unscored"}
    </span>
  );
}

export default function Crm() {
  const { user } = useAuth();
  const [tenantId, setTenantId] = useState<string>("");
  const { data: tenantsData } = trpc.tenant.list.useQuery(undefined, { enabled: !!user });
  const tenants = (tenantsData as any)?.tenants ?? tenantsData ?? [];
  const activeTenantId = tenantId || (Array.isArray(tenants) && tenants.length > 0 ? tenants[0]?.id : "");
  const enabled = !!activeTenantId && !!user;

  const [breakdownFor, setBreakdownFor] = useState<string | null>(null);

  const summaryQ = trpc.crm.pipelineSummary.useQuery({ tenantId: activeTenantId }, { enabled });
  const atRiskQ = trpc.crm.atRiskList.useQuery({ tenantId: activeTenantId, limit: 50 }, { enabled });
  const breakdownQ = trpc.crm.getScoreBreakdown.useQuery(
    { tenantId: activeTenantId, customerId: breakdownFor! },
    { enabled: enabled && !!breakdownFor },
  );

  const refresh = trpc.crm.refreshScores.useMutation({
    onSuccess: (d) => {
      toast.success(`Refreshed lead scores for ${d.refreshed} customers`);
      summaryQ.refetch();
      atRiskQ.refetch();
    },
    onError: (e) => toast.error(e.message),
  });
  const winBack = trpc.crm.createWinBackCampaign.useMutation({
    onSuccess: () => toast.success("Win-back draft campaign created — review & send it from Broadcasts"),
    onError: (e) => toast.error(e.message),
  });

  // W20: ML propensity model — status line + manual retrain.
  const modelStatusQ = trpc.crm.leadModelStatus.useQuery({ tenantId: activeTenantId }, { enabled });
  const trainModel = trpc.crm.trainLeadModel.useMutation({
    onSuccess: (d) => {
      if (d.trained) toast.success(`ML model v${d.version} trained on ${d.sampleCount} customers (logloss ${d.logloss?.toFixed(3)})`);
      else toast.info(`Not enough history to train (${d.sampleCount}/${d.minTrainSamples} labeled customers) — rule-based scoring stays active`);
      modelStatusQ.refetch();
      atRiskQ.refetch();
    },
    onError: (e) => toast.error(e.message),
  });
  const modelStatus = modelStatusQ.data;

  const summary = summaryQ.data;
  const atRisk = atRiskQ.data ?? [];
  const stages = summary?.stages ?? {};
  const bands = summary?.bands ?? { hot: 0, warm: 0, cold: 0 };
  const bandTotal = Math.max(1, (bands.hot ?? 0) + (bands.warm ?? 0) + (bands.cold ?? 0));

  return (
    <DashboardLayout>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-emerald-500/20 border border-emerald-500/30 flex items-center justify-center shrink-0">
              <TrendingUp className="w-5 h-5 text-emerald-400" />
            </div>
            <div>
              <h1 className="text-xl sm:text-2xl font-bold text-foreground">CRM Pipeline</h1>
              <p className="text-sm text-muted-foreground">Lead scores from your commerce events — Twenty stays the system of record.</p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {Array.isArray(tenants) && tenants.length > 1 && (
              <select
                className="h-9 rounded-md border border-border bg-background px-2 text-sm"
                value={activeTenantId}
                onChange={(e) => setTenantId(e.target.value)}
              >
                {tenants.map((t: any) => (
                  <option key={t.id} value={t.id}>{t.name ?? t.id}</option>
                ))}
              </select>
            )}
            <Button
              variant="outline" size="sm" className="gap-2 border-border"
              disabled={!enabled || refresh.isPending}
              onClick={() => refresh.mutate({ tenantId: activeTenantId })}
            >
              {refresh.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
              Refresh scores
            </Button>
            <Button
              variant="outline" size="sm" className="gap-2 border-border"
              disabled={!enabled || trainModel.isPending}
              onClick={() => trainModel.mutate({ tenantId: activeTenantId })}
            >
              {trainModel.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <BrainCircuit className="w-4 h-4" />}
              Train model
            </Button>
          </div>
        </div>

        {/* W20: ML model status line */}
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <BrainCircuit className="w-3.5 h-3.5 text-violet-400" />
          {modelStatus?.trained ? (
            <span>
              ML propensity model v{modelStatus.version} — trained {modelStatus.trainedAt ? new Date(modelStatus.trainedAt).toLocaleString() : "—"}
              {" · "}{modelStatus.sampleCount} customers{modelStatus.logloss != null ? ` · logloss ${modelStatus.logloss.toFixed(3)}` : ""}
            </span>
          ) : (
            <span>
              ML model not trained yet (needs {modelStatus?.minTrainSamples ?? 50} customers with order history) — using rule-based scores.
            </span>
          )}
        </div>

        {/* Band distribution */}
        <Card className="bg-card border-border">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2"><Users className="w-4 h-4" /> Lead bands</CardTitle>
            <CardDescription>{summary?.total ?? 0} scored customers</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-3 gap-2 sm:gap-4 mb-3">
              {([["hot", Flame, "text-red-400"], ["warm", Thermometer, "text-amber-400"], ["cold", Snowflake, "text-sky-400"]] as const).map(([b, Icon, cls]) => (
                <div key={b} className="rounded-lg border border-border bg-background p-3 text-center">
                  <Icon className={`w-4 h-4 mx-auto mb-1 ${cls}`} />
                  <div className="text-lg sm:text-2xl font-bold">{bands[b] ?? 0}</div>
                  <div className="text-xs text-muted-foreground capitalize">{b}</div>
                </div>
              ))}
            </div>
            <div className="flex h-2 rounded-full overflow-hidden bg-muted">
              <div className="bg-red-500" style={{ width: `${((bands.hot ?? 0) / bandTotal) * 100}%` }} />
              <div className="bg-amber-500" style={{ width: `${((bands.warm ?? 0) / bandTotal) * 100}%` }} />
              <div className="bg-sky-500" style={{ width: `${((bands.cold ?? 0) / bandTotal) * 100}%` }} />
            </div>
          </CardContent>
        </Card>

        {/* Pipeline stage cards — stack on mobile, 3-up on desktop */}
        <div className="grid grid-cols-2 md:grid-cols-3 gap-2 sm:gap-4">
          {Object.entries(STAGE_LABELS).map(([key, label]) => {
            const s = (stages as any)[key] ?? { count: 0, totalValue: 0 };
            return (
              <Card key={key} className={`bg-card border-border ${key === "at_risk" && s.count > 0 ? "border-amber-500/50" : ""}`}>
                <CardContent className="p-3 sm:p-4">
                  <div className="text-xs text-muted-foreground">{label}</div>
                  <div className="text-xl sm:text-2xl font-bold">{s.count}</div>
                  <div className="text-xs text-muted-foreground truncate">
                    {s.totalValue.toLocaleString(undefined, { maximumFractionDigits: 0 })} lifetime value
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>

        {/* At-risk win-back list */}
        <Card className="bg-card border-border">
          <CardHeader className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 space-y-0">
            <div>
              <CardTitle className="text-base flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-amber-400" /> Win-back candidates
              </CardTitle>
              <CardDescription>Repeat buyers with no order in 30+ days.</CardDescription>
            </div>
            <div className="flex gap-2">
              <Button
                size="sm" className="gap-2"
                disabled={!enabled || atRisk.length === 0 || winBack.isPending}
                onClick={() => winBack.mutate({ tenantId: activeTenantId, name: "Win-back campaign" })}
              >
                {winBack.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Megaphone className="w-4 h-4" />}
                Create win-back broadcast
              </Button>
              {winBack.isSuccess && (
                <Link href="/broadcast">
                  <Button size="sm" variant="outline" className="border-border">Open Broadcasts</Button>
                </Link>
              )}
            </div>
          </CardHeader>
          <CardContent>
            {atRiskQ.isLoading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</div>
            ) : atRisk.length === 0 ? (
              <p className="text-sm text-muted-foreground">No at-risk customers — your repeat buyers are active.</p>
            ) : (
              <div className="divide-y divide-border">
                {atRisk.map((c: any) => (
                  <button
                    key={c.customerId}
                    onClick={() => setBreakdownFor(c.customerId)}
                    className="w-full flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-3 py-3 text-left hover:bg-muted/40 px-1 rounded"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="font-medium truncate">{c.name ?? c.whatsappPhone}</div>
                      <div className="text-xs text-muted-foreground">
                        {c.totalOrders} orders · {Number(c.totalSpent).toLocaleString()} spent · last order {c.daysSinceLastOrder}d ago
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <PropensityBadge propensity={c.propensity} scoreSource={c.scoreSource} />
                      <BandBadge band={c.band} />
                      {c.score != null && <Badge variant="outline" className="border-border">{c.score}</Badge>}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Score breakdown drawer */}
        <Sheet open={!!breakdownFor} onOpenChange={(open) => !open && setBreakdownFor(null)}>
          <SheetContent side="right" className="w-full sm:max-w-md bg-card border-border overflow-y-auto">
            <SheetHeader>
              <SheetTitle>Lead score breakdown</SheetTitle>
              <SheetDescription>Every signal that moved this customer's score.</SheetDescription>
            </SheetHeader>
            {breakdownQ.isLoading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground pt-6"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</div>
            ) : breakdownQ.data ? (
              <div className="pt-6 space-y-4">
                <div className="flex items-center gap-3">
                  <div className="text-3xl font-bold">{breakdownQ.data.score}</div>
                  <BandBadge band={breakdownQ.data.band} />
                  <span className="text-xs text-muted-foreground capitalize">{String(breakdownQ.data.stage).replace("_", " ")}</span>
                </div>
                <div className="space-y-2">
                  {(breakdownQ.data.factors as { factor: string; delta: number }[]).map((f) => (
                    <div key={f.factor} className="flex items-center justify-between rounded-md border border-border bg-background px-3 py-2">
                      <span className="text-sm">{f.factor.replaceAll(":", " · ").replaceAll("_", " ")}</span>
                      <span className={`text-sm font-semibold ${f.delta >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                        {f.delta >= 0 ? `+${f.delta}` : f.delta}
                      </span>
                    </div>
                  ))}
                  {breakdownQ.data.factors.length === 0 && (
                    <p className="text-sm text-muted-foreground">No scoring signals yet for this customer.</p>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  Computed {breakdownQ.data.computedAt ? new Date(breakdownQ.data.computedAt).toLocaleString() : "—"}
                </p>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground pt-6">No score computed yet — run “Refresh scores”.</p>
            )}
          </SheetContent>
        </Sheet>
      </div>
    </DashboardLayout>
  );
}
