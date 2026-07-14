import { useActiveTenant } from "@/contexts/TenantContext";
import DashboardLayout from "@/components/DashboardLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { trpc } from "@/lib/trpc";
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, BarChart, Bar } from "recharts";
import { AlertTriangle, Building2, Bot, MessageSquare, ShoppingCart, TrendingUp, Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { useLocation } from "wouter";


// Static chart data for visual richness
const revenueData = [
  { month: "Jan", revenue: 12400 }, { month: "Feb", revenue: 18200 }, { month: "Mar", revenue: 15800 },
  { month: "Apr", revenue: 22100 }, { month: "May", revenue: 28400 }, { month: "Jun", revenue: 31200 },
  { month: "Jul", revenue: 29800 },
];
const convData = [
  { day: "Mon", bot: 142, human: 18 }, { day: "Tue", bot: 168, human: 22 }, { day: "Wed", bot: 155, human: 15 },
  { day: "Thu", bot: 190, human: 28 }, { day: "Fri", bot: 210, human: 32 }, { day: "Sat", bot: 98, human: 12 }, { day: "Sun", bot: 76, human: 8 },
];

export default function Dashboard() {
  const { activeTenantId: DEMO_TENANT } = useActiveTenant();
  const { data: overview } = trpc.analytics.platformOverview.useQuery();
  const { data: tenantDash } = trpc.analytics.tenantDashboard.useQuery({ tenantId: DEMO_TENANT });
  const { data: stockData } = trpc.inventory.getStockLevels.useQuery(
    { tenantId: DEMO_TENANT },
    { enabled: !!DEMO_TENANT }
  );
  const [, setLocation] = useLocation();
  const lowStockCount = stockData?.filter((s: { stockStatus: string }) => s.stockStatus === "low_stock").length ?? 0;
  const outOfStockCount = stockData?.filter((s: { stockStatus: string }) => s.stockStatus === "out_of_stock").length ?? 0;

  const kpis = [
    { label: "Active Tenants", value: overview?.tenants?.active ?? 0, icon: Building2, color: "text-primary", sub: `of ${overview?.tenants?.total ?? 0} total` },
    { label: "Total Revenue", value: `$${(overview?.revenue ?? 0).toLocaleString()}`, icon: TrendingUp, color: "text-green-400", sub: "all-time completed" },
    { label: "Conversations", value: (overview?.conversations ?? 0).toLocaleString(), icon: MessageSquare, color: "text-blue-400", sub: "all tenants" },
    { label: "Orders", value: (overview?.orders ?? 0).toLocaleString(), icon: ShoppingCart, color: "text-purple-400", sub: "paid orders" },
    { label: "AI Interactions", value: (overview?.agentInteractions ?? 0).toLocaleString(), icon: Bot, color: "text-yellow-400", sub: "agent events" },
  { label: "Customers", value: (tenantDash?.customers ?? 0).toLocaleString(), icon: Users, color: "text-cyan-400", sub: "registered" },
  ];

  const alertColor = outOfStockCount > 0 ? "text-red-400" : lowStockCount > 0 ? "text-amber-400" : "text-green-400";
  const alertCount = outOfStockCount > 0 ? outOfStockCount : lowStockCount;

  return (
    <DashboardLayout>
      <div className="p-6 space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Platform Overview</h1>
          <p className="text-muted-foreground mt-1">Real-time metrics across all tenants and services</p>
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

        {/* Charts */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Card className="bg-card border-border">
            <CardHeader><CardTitle className="text-sm font-medium text-muted-foreground">Revenue Trend (USD)</CardTitle></CardHeader>
            <CardContent>
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
            </CardContent>
          </Card>

          <Card className="bg-card border-border">
            <CardHeader><CardTitle className="text-sm font-medium text-muted-foreground">Conversations (Bot vs Human)</CardTitle></CardHeader>
            <CardContent>
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
            </CardContent>
          </Card>
        </div>

        {/* Tenant Metrics */}
        {tenantDash && (
          <Card className="bg-card border-border">
            <CardHeader><CardTitle className="text-sm font-medium text-muted-foreground">Tenant Metrics — Demo Tenant</CardTitle></CardHeader>
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
      </div>
    </DashboardLayout>
  );
}
