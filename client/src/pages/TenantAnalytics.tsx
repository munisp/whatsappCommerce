import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import DashboardLayout from "@/components/DashboardLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  LineChart, Line, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from "recharts";

const COLORS = ["#22c55e", "#3b82f6", "#f59e0b", "#ef4444", "#8b5cf6", "#06b6d4"];

function StatCard({ title, value, sub, growth, loading }: {
  title: string; value: string; sub?: string; growth?: number; loading?: boolean;
}) {
  return (
    <Card>
      <CardHeader className="pb-1">
        <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-8 w-24" />
        ) : (
          <div className="flex items-end gap-2">
            <span className="text-2xl font-bold">{value}</span>
            {growth !== undefined && (
              <Badge variant={growth >= 0 ? "default" : "destructive"} className="mb-1 text-xs">
                {growth >= 0 ? "+" : ""}{growth.toFixed(1)}%
              </Badge>
            )}
          </div>
        )}
        {sub && <p className="text-xs text-muted-foreground mt-1">{sub}</p>}
      </CardContent>
    </Card>
  );
}

export default function TenantAnalytics() {
  const { user } = useAuth();
  const [days, setDays] = useState("30");
  const [tenantId, setTenantId] = useState<string>("");

  // Load tenants list
  const { data: tenantsData } = trpc.tenant.list.useQuery(undefined, { enabled: !!user });
  const tenants = (tenantsData as any)?.tenants ?? tenantsData ?? [];
  const activeTenantId = tenantId || (Array.isArray(tenants) && tenants.length > 0 ? tenants[0]?.id : "");

  const daysNum = parseInt(days);
  const enabled = !!activeTenantId && !!user;

  const { data: overview, isLoading: ovLoading } = trpc.tenantAnalytics.getOverview.useQuery(
    { tenantId: activeTenantId, days: daysNum }, { enabled }
  );
  const { data: gmvTs } = trpc.tenantAnalytics.getGmvTimeSeries.useQuery(
    { tenantId: activeTenantId, days: Math.min(daysNum, 90) }, { enabled }
  );
  const { data: topProds } = trpc.tenantAnalytics.getTopProducts.useQuery(
    { tenantId: activeTenantId, days: daysNum, limit: 8 }, { enabled }
  );
  const { data: retention } = trpc.tenantAnalytics.getRetention.useQuery(
    { tenantId: activeTenantId, days: daysNum }, { enabled }
  );
  const { data: payBreakdown } = trpc.tenantAnalytics.getPaymentBreakdown.useQuery(
    { tenantId: activeTenantId, days: daysNum }, { enabled }
  );

  const fmt = (n: number) => n >= 1_000_000
    ? `$${(n / 1_000_000).toFixed(2)}M`
    : n >= 1_000
    ? `$${(n / 1_000).toFixed(1)}K`
    : `$${n.toFixed(2)}`;

  return (
    <DashboardLayout>
      <div className="p-6 space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold">Tenant Analytics</h1>
            <p className="text-sm text-muted-foreground">GMV, orders, top products, and customer retention by tenant</p>
          </div>
          <div className="flex gap-2">
            <Select value={activeTenantId} onValueChange={setTenantId}>
              <SelectTrigger className="w-48">
                <SelectValue placeholder="Select tenant" />
              </SelectTrigger>
              <SelectContent>
                {Array.isArray(tenants) && tenants.map((t: any) => (
                  <SelectItem key={t.id} value={t.id}>{t.name ?? t.id}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={days} onValueChange={setDays}>
              <SelectTrigger className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="7">Last 7 days</SelectItem>
                <SelectItem value="30">Last 30 days</SelectItem>
                <SelectItem value="60">Last 60 days</SelectItem>
                <SelectItem value="90">Last 90 days</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* KPI Cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <StatCard title="Gross Merchandise Value" value={fmt(overview?.gmv ?? 0)} growth={overview?.gmvGrowth} loading={ovLoading} sub="vs previous period" />
          <StatCard title="Total Orders" value={String(overview?.orderCount ?? 0)} growth={overview?.orderGrowth} loading={ovLoading} sub={`${overview?.paidOrders ?? 0} paid`} />
          <StatCard title="Avg Order Value" value={fmt(overview?.avgOrderValue ?? 0)} loading={ovLoading} sub="per completed order" />
          <StatCard title="New Customers" value={String(overview?.newCustomers ?? 0)} loading={ovLoading} sub={`${overview?.cancelledOrders ?? 0} cancelled orders`} />
        </div>

        {/* GMV Time Series */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Daily GMV & Orders</CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={240}>
              <LineChart data={gmvTs?.series ?? []}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                <XAxis dataKey="date" tick={{ fontSize: 11 }} tickFormatter={d => d?.slice(5)} />
                <YAxis yAxisId="left" tick={{ fontSize: 11 }} tickFormatter={v => fmt(v)} />
                <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 11 }} />
                <Tooltip formatter={(v: any, name: string) => [name === "gmv" ? fmt(v) : v, name === "gmv" ? "GMV" : "Orders"]} />
                <Legend />
                <Line yAxisId="left" type="monotone" dataKey="gmv" stroke="#22c55e" strokeWidth={2} dot={false} name="GMV" />
                <Line yAxisId="right" type="monotone" dataKey="orders" stroke="#3b82f6" strokeWidth={2} dot={false} name="Orders" />
              </LineChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        {/* Top Products + Payment Breakdown */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Top Products by Revenue</CardTitle>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={topProds?.products ?? []} layout="vertical">
                  <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                  <XAxis type="number" tick={{ fontSize: 11 }} tickFormatter={v => fmt(v)} />
                  <YAxis type="category" dataKey="name" tick={{ fontSize: 10 }} width={100} />
                  <Tooltip formatter={(v: any) => [fmt(v), "Revenue"]} />
                  <Bar dataKey="revenue" fill="#22c55e" radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Payment Method Breakdown</CardTitle>
            </CardHeader>
            <CardContent className="flex items-center gap-4">
              <ResponsiveContainer width="55%" height={200}>
                <PieChart>
                  <Pie data={payBreakdown?.breakdown ?? []} dataKey="total" nameKey="provider" cx="50%" cy="50%" outerRadius={80} label={false}>
                    {(payBreakdown?.breakdown ?? []).map((_: any, i: number) => (
                      <Cell key={i} fill={COLORS[i % COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip formatter={(v: any) => [fmt(v), "Revenue"]} />
                </PieChart>
              </ResponsiveContainer>
              <div className="flex flex-col gap-2 text-sm">
                {(payBreakdown?.breakdown ?? []).map((b: any, i: number) => (
                  <div key={b.provider} className="flex items-center gap-2">
                    <span className="w-3 h-3 rounded-full inline-block" style={{ background: COLORS[i % COLORS.length] }} />
                    <span className="capitalize">{b.provider}</span>
                    <span className="text-muted-foreground ml-auto">{b.count} txns</span>
                  </div>
                ))}
                {(payBreakdown?.breakdown ?? []).length === 0 && (
                  <p className="text-muted-foreground text-xs">No payment data yet</p>
                )}
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Customer Retention */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Customer Retention</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex justify-between items-center">
                <span className="text-sm text-muted-foreground">New customers</span>
                <span className="font-semibold">{retention?.newCustomers ?? 0}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-sm text-muted-foreground">Returning customers</span>
                <span className="font-semibold">{retention?.returningCustomers ?? 0}</span>
              </div>
              <div className="flex justify-between items-center border-t pt-2">
                <span className="text-sm font-medium">Retention rate</span>
                <Badge variant={(retention?.retentionRate ?? 0) >= 30 ? "default" : "secondary"}>
                  {(retention?.retentionRate ?? 0).toFixed(1)}%
                </Badge>
              </div>
            </CardContent>
          </Card>

          <Card className="lg:col-span-2">
            <CardHeader>
              <CardTitle className="text-base">Weekly Customer Cohorts</CardTitle>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={180}>
                <BarChart data={retention?.cohorts ?? []}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                  <XAxis dataKey="week" tick={{ fontSize: 10 }} tickFormatter={d => d?.slice(5)} />
                  <YAxis tick={{ fontSize: 11 }} />
                  <Tooltip />
                  <Legend />
                  <Bar dataKey="customers" fill="#3b82f6" name="Customers" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="orders" fill="#22c55e" name="Orders" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        </div>
      </div>
    </DashboardLayout>
  );
}
