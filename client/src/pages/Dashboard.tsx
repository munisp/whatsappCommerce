import { useActiveTenant } from "@/contexts/TenantContext";
import { useAuth } from "@/_core/hooks/useAuth";
import UsagePlanWidget from "@/components/UsagePlanWidget";
import WaQualityWidget from "@/components/WaQualityWidget";
import { CreditSummaryWidget } from "@/components/b2b/CreditSummaryWidget";
import { CopilotAskWidget } from "@/components/CopilotAsk";
import { PendingPoApprovalsWidget } from "@/components/b2b/PendingPoApprovalsWidget";
import DashboardLayout from "@/components/DashboardLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { trpc } from "@/lib/trpc";
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, BarChart, Bar } from "recharts";
import { AlertTriangle, Building2, Bot, MessageSquare, ShoppingCart, TrendingUp, Users, CheckCircle2 } from "lucide-react";
import { Siren } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useLocation } from "wouter";


// W30 (V3#6): charts are fed by real analytics queries — never hardcoded
// series. When a query returns no points we render an explicit empty state.

function ChartEmptyState({ label }: { label: string }) {
  return (
    <div className="h-[200px] flex flex-col items-center justify-center text-muted-foreground gap-1">
      <TrendingUp className="w-6 h-6 opacity-40" />
      <p className="text-sm font-medium">No data yet</p>
      <p className="text-xs">{label}</p>
    </div>
  );
}

export default function Dashboard() {
  const { activeTenantId: DEMO_TENANT } = useActiveTenant();
  const { user } = useAuth();
  // Found live 2026-09-26, aggressive dashboard QA sweep: platformOverview/revenueTrend/conversationSplitTrend/
  // escalationSlaStats are all `adminProcedure` — PLATFORM admin only — but were fetched unconditionally for
  // EVERY signed-in user. A tenant owner (not a platform admin) got a real 403 on all four, which the UI
  // silently rendered as genuine "0" data: "0 of 0 tenants", "$0 revenue", "0 orders" — indistinguishable from
  // an actually-empty platform, and seriously misleading for a real business owner. Gated behind the same
  // `user?.role === "admin"` check already used for the UsagePlanWidget/WaQualityWidget below, so a non-admin
  // never fires (or renders) requests they're not allowed to see, and sees their own real tenant numbers
  // (already correctly shown in the "Tenant Metrics" section further down) instead.
  const isPlatformAdmin = user?.role === "admin";
  // Found live 2026-09-26: this section's header was hardcoded to literally say "Demo Tenant", regardless of
  // whose real data was actually being shown (a leftover from when this page was built against a fixed demo
  // tenant, before it was wired to the real signed-in tenant elsewhere) — confusing for any real merchant.
  const { data: myTenant } = trpc.tenant.myTenant.useQuery(undefined, { enabled: !!DEMO_TENANT });
  const { data: overview } = trpc.analytics.platformOverview.useQuery(undefined, { enabled: isPlatformAdmin });
  const { data: tenantDash } = trpc.analytics.tenantDashboard.useQuery({ tenantId: DEMO_TENANT });
  const { data: escalationSla } = trpc.escrowDispute.escalationSlaStats.useQuery(undefined, { enabled: isPlatformAdmin });
  const { data: stockData } = trpc.inventory.getStockLevels.useQuery(
    { tenantId: DEMO_TENANT },
    { enabled: !!DEMO_TENANT }
  );
  const { data: funnelData } = trpc.onboardingProgress.getFunnelAnalytics.useQuery();
  const revenueTrendQ = trpc.analytics.revenueTrend.useQuery(undefined, { enabled: isPlatformAdmin });
  const convSplitQ = trpc.analytics.conversationSplitTrend.useQuery(undefined, { enabled: isPlatformAdmin });
  const revenueData = revenueTrendQ.data?.points ?? [];
  const convData = convSplitQ.data?.points ?? [];
  const [, setLocation] = useLocation();
  const lowStockCount = stockData?.filter((s: { stockStatus: string }) => s.stockStatus === "low_stock").length ?? 0;
  const outOfStockCount = stockData?.filter((s: { stockStatus: string }) => s.stockStatus === "out_of_stock").length ?? 0;

  // Platform-wide (cross-tenant) — only meaningful, and only fetched, for a real platform admin (see the
  // `isPlatformAdmin`-gated queries above). "Customers" is tenant-scoped and real for everyone.
  const kpis = [
    ...(isPlatformAdmin ? [
      { label: "Active Tenants", value: overview?.tenants?.active ?? 0, icon: Building2, color: "text-primary", sub: `of ${overview?.tenants?.total ?? 0} total` },
      {
        // Found live 2026-09-26 (user: "i still see dollars here"): hardcoded "$" summing every
        // tenant's orders regardless of currency — see db.ts's getPlatformOverview fix.
        label: "Total Revenue",
        value: overview && overview.revenueByCurrency.length > 0
          ? overview.revenueByCurrency.map((r) => `${r.currency} ${r.amount.toLocaleString()}`).join(" · ")
          : "0",
        icon: TrendingUp, color: "text-green-400", sub: "all-time completed",
      },
      { label: "Conversations", value: (overview?.conversations ?? 0).toLocaleString(), icon: MessageSquare, color: "text-blue-400", sub: "all tenants" },
      { label: "Orders", value: (overview?.orders ?? 0).toLocaleString(), icon: ShoppingCart, color: "text-purple-400", sub: "paid orders" },
      { label: "AI Interactions", value: (overview?.agentInteractions ?? 0).toLocaleString(), icon: Bot, color: "text-yellow-400", sub: "agent events" },
    ] : []),
    { label: "Customers", value: (tenantDash?.customers ?? 0).toLocaleString(), icon: Users, color: "text-cyan-400", sub: "registered" },
  ];

  const alertColor = outOfStockCount > 0 ? "text-red-400" : lowStockCount > 0 ? "text-amber-400" : "text-green-400";
  const alertCount = outOfStockCount > 0 ? outOfStockCount : lowStockCount;

  return (
    <DashboardLayout>
      <div className="p-6 space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{isPlatformAdmin ? "Platform Overview" : "Dashboard"}</h1>
          <p className="text-muted-foreground mt-1">
            {isPlatformAdmin ? "Real-time metrics across all tenants and services" : "Real-time metrics for your business"}
          </p>
        </div>

        {/* KPI Grid */}
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
        {kpis.map((kpi) => (
            <Card key={kpi.label} className="bg-card border-border">
              <CardContent className="p-4">
                <div className="flex items-start justify-between">
                  <div>
                    <p className="text-xs text-muted-foreground">{kpi.label}</p>
                    <p className={`text-2xl font-bold mt-1 ${kpi.color}`}>{kpi.value}</p>
                    <p className="text-xs text-muted-foreground mt-1">{kpi.sub}</p>
                  </div>
                  <kpi.icon className={`w-8 h-8 ${kpi.color} opacity-50 mt-1`} />
                </div>
              </CardContent>
            </Card>
          ))}
        {/* Usage vs plan + WhatsApp quality (metering APIs are admin-only) */}
        {user?.role === "admin" && (
          <>
            <UsagePlanWidget />
            <WaQualityWidget />
          </>
        )}

          {/* Inventory Alert Card */}
          <Card
            className={`border cursor-pointer transition-colors hover:bg-accent/30 ${outOfStockCount > 0 ? "border-red-500/40 bg-red-500/5" : lowStockCount > 0 ? "border-amber-500/40 bg-amber-500/5" : "bg-card border-border"}`}
            onClick={() => setLocation("/inventory")}
          >
            <CardContent className="p-4">
              <div className="flex items-start justify-between">
                <div>
                  <p className="text-xs text-muted-foreground">Inventory Alerts</p>
                  <p className={`text-2xl font-bold mt-1 ${alertColor}`}>{alertCount}</p>
                  <div className="flex gap-1 mt-1 flex-wrap">
                    {outOfStockCount > 0 && <Badge variant="outline" className="text-[10px] text-red-400 border-red-400/30 px-1 py-0">out of stock</Badge>}
                    {lowStockCount > 0 && <Badge variant="outline" className="text-[10px] text-amber-400 border-amber-400/30 px-1 py-0">low stock</Badge>}
                    {lowStockCount === 0 && outOfStockCount === 0 && <span className="text-xs text-green-400">all stocked</span>}
                  </div>
                </div>
                <AlertTriangle className={`w-8 h-8 opacity-50 mt-1 ${alertColor}`} />
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Supply-chain: supplier credit position + PO approvals inbox */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <CreditSummaryWidget />
          <PendingPoApprovalsWidget />
        </div>

        {/* Charts — platform-wide (cross-tenant) aggregates, admin-only; see isPlatformAdmin note above */}
        {isPlatformAdmin && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Card className="bg-card border-border">
            <CardHeader><CardTitle className="text-sm font-medium text-muted-foreground">Revenue Trend (USD)</CardTitle></CardHeader>
            <CardContent>
              {revenueData.length === 0 ? (
                <ChartEmptyState label="Completed (paid) order revenue for the last 7 months will appear here." />
              ) : (
              <ResponsiveContainer width="100%" height={200}>
                <AreaChart data={revenueData}>
                  <defs>
                    <linearGradient id="revGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="oklch(0.65 0.18 160)" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="oklch(0.65 0.18 160)" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="oklch(0.25 0.015 220)" />
                  <XAxis dataKey="month" tick={{ fill: "oklch(0.60 0.01 220)", fontSize: 11 }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fill: "oklch(0.60 0.01 220)", fontSize: 11 }} axisLine={false} tickLine={false} />
                  <Tooltip contentStyle={{ background: "oklch(0.16 0.015 220)", border: "1px solid oklch(0.25 0.015 220)", borderRadius: 8, color: "oklch(0.95 0.005 220)" }} />
                  <Area type="monotone" dataKey="revenue" stroke="oklch(0.65 0.18 160)" fill="url(#revGrad)" strokeWidth={2} />
                </AreaChart>
              </ResponsiveContainer>
              )}
            </CardContent>
          </Card>

          <Card className="bg-card border-border">
            <CardHeader><CardTitle className="text-sm font-medium text-muted-foreground">Conversations (Bot vs Human)</CardTitle></CardHeader>
            <CardContent>
              {convData.length === 0 ? (
                <ChartEmptyState label="AI-handled vs human conversations for the last 7 days will appear here." />
              ) : (
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={convData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="oklch(0.25 0.015 220)" />
                  <XAxis dataKey="day" tick={{ fill: "oklch(0.60 0.01 220)", fontSize: 11 }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fill: "oklch(0.60 0.01 220)", fontSize: 11 }} axisLine={false} tickLine={false} />
                  <Tooltip contentStyle={{ background: "oklch(0.16 0.015 220)", border: "1px solid oklch(0.25 0.015 220)", borderRadius: 8, color: "oklch(0.95 0.005 220)" }} />
                  <Bar dataKey="bot" fill="oklch(0.65 0.18 160)" radius={[3, 3, 0, 0]} />
                  <Bar dataKey="human" fill="oklch(0.60 0.18 200)" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
              )}
            </CardContent>
          </Card>
        </div>
        )}

        {/* Tenant Metrics */}
        {/* W22: merchant copilot Ask box (tenant-scoped aggregates only) */}
        <CopilotAskWidget tenantId={DEMO_TENANT} />
        {tenantDash && (
          <Card className="bg-card border-border">
            <CardHeader><CardTitle className="text-sm font-medium text-muted-foreground">Tenant Metrics — {myTenant?.name ?? "Your business"}</CardTitle></CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                {[
                  { label: "Open Conversations", value: tenantDash.conversations.open },
                  { label: "Bot Active", value: tenantDash.conversations.botActive },
                  { label: "Escalated", value: tenantDash.conversations.escalated },
                  { label: "Pending Orders", value: tenantDash.orders.pending },
                  { label: "Active Products", value: tenantDash.products.active },
                  { label: "Low Stock", value: tenantDash.products.lowStock },
                  { label: "Agent Interactions", value: tenantDash.agent.total },
                  { label: "Avg AI Latency", value: `${tenantDash.agent.avgLatency}ms` },
                ].map((m) => (
                  <div key={m.label} className="p-3 rounded-lg bg-accent/30 border border-border">
                    <p className="text-xs text-muted-foreground">{m.label}</p>
                    <p className="text-xl font-bold text-foreground mt-1">{m.value}</p>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Onboarding Funnel Analytics */}
        {/* Escalation SLA Card */}
        <Card className={`border ${(escalationSla?.openEscalatedCount ?? 0) > 0 ? "border-red-500/40 bg-red-500/5" : "bg-card border-border"}`}>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                <Siren className="w-4 h-4 text-red-400" />
                Dispute Escalation SLA
              </CardTitle>
              <Button variant="ghost" size="sm" className="text-xs h-7 text-muted-foreground" onClick={() => setLocation("/disputes")}>
                View all →
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-3 gap-4">
              <div className="p-3 rounded-lg bg-accent/30 border border-border">
                <p className="text-xs text-muted-foreground">Total Escalated</p>
                <p className={`text-2xl font-bold mt-1 ${(escalationSla?.escalatedCount ?? 0) > 0 ? "text-red-400" : "text-foreground"}`}>
                  {escalationSla?.escalatedCount ?? 0}
                </p>
              </div>
              <div className="p-3 rounded-lg bg-accent/30 border border-border">
                <p className="text-xs text-muted-foreground">Open Escalated</p>
                <p className={`text-2xl font-bold mt-1 ${(escalationSla?.openEscalatedCount ?? 0) > 0 ? "text-amber-400" : "text-green-400"}`}>
                  {escalationSla?.openEscalatedCount ?? 0}
                </p>
              </div>
              <div className="p-3 rounded-lg bg-accent/30 border border-border">
                <p className="text-xs text-muted-foreground">Avg Time to Escalate</p>
                <p className="text-2xl font-bold mt-1 text-foreground">
                  {escalationSla?.avgHoursToEscalation != null ? `${escalationSla.avgHoursToEscalation}h` : "—"}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="bg-card border-border">
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-medium text-muted-foreground">Merchant Onboarding Funnel</CardTitle>
              {funnelData && (
                <div className="flex items-center gap-3 text-xs text-muted-foreground">
                  <span>{funnelData.totalStarted} started</span>
                  <span className="flex items-center gap-1 text-green-400">
                    <CheckCircle2 className="w-3 h-3" />
                    {funnelData.completedCount} completed ({funnelData.completionRate}%)
                  </span>
                </div>
              )}
            </div>
          </CardHeader>
          <CardContent>
            {!funnelData || funnelData.totalStarted === 0 ? (
              <div className="text-center py-8 text-muted-foreground text-sm">
                No onboarding data yet. Funnel will populate as merchants start the wizard.
              </div>
            ) : (
              <div className="space-y-2">
                {funnelData.funnel.map((step, idx) => {
                  const maxCount = Math.max(...funnelData.funnel.map((s) => s.count), 1);
                  const pct = Math.round((step.count / maxCount) * 100);
                  const colors = ["oklch(0.65 0.18 250)", "oklch(0.65 0.18 220)", "oklch(0.65 0.18 190)", "oklch(0.65 0.18 160)", "oklch(0.65 0.18 130)"];
                  return (
                    <div key={step.step} className="flex items-center gap-3">
                      <span className="text-xs text-muted-foreground w-32 shrink-0">Step {idx + 1}: {step.label}</span>
                      <div className="flex-1 h-6 bg-accent/20 rounded overflow-hidden">
                        <div
                          className="h-full rounded transition-all duration-500 flex items-center px-2"
                          style={{ width: `${Math.max(pct, 4)}%`, background: colors[idx] }}
                        >
                          <span className="text-xs font-medium text-white">{step.count}</span>
                        </div>
                      </div>
                      {step.dropOff > 0 && (
                        <span className="text-xs text-red-400 w-20 shrink-0">-{step.dropOff} drop</span>
                      )}
                    </div>
                  );
                })}
                <div className="flex items-center gap-3 mt-3 pt-3 border-t border-border">
                  <span className="text-xs text-muted-foreground w-32 shrink-0">Completed</span>
                  <div className="flex-1 h-6 bg-accent/20 rounded overflow-hidden">
                    <div
                      className="h-full rounded flex items-center px-2"
                      style={{ width: `${Math.max(funnelData.completionRate, 4)}%`, background: "oklch(0.65 0.18 130)" }}
                    >
                      <span className="text-xs font-medium text-white">{funnelData.completedCount}</span>
                    </div>
                  </div>
                  <span className="text-xs text-green-400 w-20 shrink-0">{funnelData.completionRate}% rate</span>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}
