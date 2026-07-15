import { useState, useMemo } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { TenantPortalLayout } from "@/components/TenantPortalLayout";
import {
  LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from "recharts";
import { TrendingUp, ShoppingCart, DollarSign, Package, BarChart3 } from "lucide-react";

type Period = "7d" | "30d" | "90d";

function fmt(n: number) {
  if (n >= 1_000_000) return `₦${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `₦${(n / 1_000).toFixed(1)}K`;
  return `₦${n.toLocaleString()}`;
}

export default function MerchantAnalytics() {
  const [period, setPeriod] = useState<Period>("30d");

  const { data, isLoading } = trpc.tenantPortal.getAnalytics.useQuery(
    { period },
    { staleTime: 60_000 },
  );

  const periodLabel = period === "7d" ? "Last 7 days" : period === "30d" ? "Last 30 days" : "Last 90 days";

  const kpis = useMemo(() => [
    {
      label: "Total GMV",
      value: data ? fmt(data.summary.totalGmv) : "—",
      icon: DollarSign,
      color: "text-emerald-600",
      bg: "bg-emerald-50",
    },
    {
      label: "Total Orders",
      value: data ? data.summary.totalOrders.toLocaleString() : "—",
      icon: ShoppingCart,
      color: "text-blue-600",
      bg: "bg-blue-50",
    },
    {
      label: "Avg Order Value",
      value: data ? fmt(data.summary.aov) : "—",
      icon: TrendingUp,
      color: "text-purple-600",
      bg: "bg-purple-50",
    },
    {
      label: "Period",
      value: data ? `${data.summary.periodDays} days` : "—",
      icon: BarChart3,
      color: "text-orange-600",
      bg: "bg-orange-50",
    },
  ], [data]);

  return (
    <TenantPortalLayout>
      <div className="p-6 space-y-6 max-w-6xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">Analytics</h1>
            <p className="text-sm text-muted-foreground mt-1">{periodLabel}</p>
          </div>
          <Select value={period} onValueChange={(v) => setPeriod(v as Period)}>
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="7d">Last 7 days</SelectItem>
              <SelectItem value="30d">Last 30 days</SelectItem>
              <SelectItem value="90d">Last 90 days</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* KPI Cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {kpis.map((kpi) => (
            <Card key={kpi.label}>
              <CardContent className="pt-5">
                <div className="flex items-start gap-3">
                  <div className={`p-2 rounded-lg ${kpi.bg}`}>
                    <kpi.icon className={`w-5 h-5 ${kpi.color}`} />
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">{kpi.label}</p>
                    {isLoading ? (
                      <Skeleton className="h-6 w-20 mt-1" />
                    ) : (
                      <p className="text-xl font-bold mt-0.5">{kpi.value}</p>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        {/* GMV Trend Chart */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">GMV Trend</CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <Skeleton className="h-64 w-full" />
            ) : !data?.dailyTrend.length ? (
              <div className="h-64 flex items-center justify-center text-muted-foreground text-sm">
                No order data in this period
              </div>
            ) : (
              <ResponsiveContainer width="100%" height={260}>
                <LineChart data={data.dailyTrend} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                  <XAxis
                    dataKey="day"
                    tick={{ fontSize: 11 }}
                    tickFormatter={(v: string) => {
                      const d = new Date(v);
                      return `${d.getMonth() + 1}/${d.getDate()}`;
                    }}
                  />
                  <YAxis tick={{ fontSize: 11 }} tickFormatter={(v: number) => fmt(v)} width={70} />
                  <Tooltip
                    formatter={(value: number) => [fmt(value), "GMV"]}
                    labelFormatter={(label: string) => new Date(label).toLocaleDateString()}
                  />
                  <Line
                    type="monotone"
                    dataKey="gmv"
                    stroke="#10b981"
                    strokeWidth={2}
                    dot={false}
                    activeDot={{ r: 5 }}
                  />
                </LineChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        {/* Order Volume Chart */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Order Volume</CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <Skeleton className="h-56 w-full" />
            ) : !data?.dailyTrend.length ? (
              <div className="h-56 flex items-center justify-center text-muted-foreground text-sm">
                No order data in this period
              </div>
            ) : (
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={data.dailyTrend} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                  <XAxis
                    dataKey="day"
                    tick={{ fontSize: 11 }}
                    tickFormatter={(v: string) => {
                      const d = new Date(v);
                      return `${d.getMonth() + 1}/${d.getDate()}`;
                    }}
                  />
                  <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                  <Tooltip
                    formatter={(value: number) => [value, "Orders"]}
                    labelFormatter={(label: string) => new Date(label).toLocaleDateString()}
                  />
                  <Bar dataKey="orderCount" fill="#6366f1" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        {/* Top Products Table */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Package className="w-4 h-4" />
              Top Products by Revenue
            </CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="space-y-2">
                {[...Array(5)].map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}
              </div>
            ) : !data?.topProducts.length ? (
              <p className="text-sm text-muted-foreground py-6 text-center">No product sales in this period</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b">
                      <th className="text-left py-2 px-3 font-medium text-muted-foreground">#</th>
                      <th className="text-left py-2 px-3 font-medium text-muted-foreground">Product</th>
                      <th className="text-right py-2 px-3 font-medium text-muted-foreground">Revenue</th>
                      <th className="text-right py-2 px-3 font-medium text-muted-foreground">Qty Sold</th>
                      <th className="text-right py-2 px-3 font-medium text-muted-foreground">Orders</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.topProducts.map((p, idx) => (
                      <tr key={p.productId} className="border-b last:border-0 hover:bg-muted/30 transition-colors">
                        <td className="py-2.5 px-3 text-muted-foreground">{idx + 1}</td>
                        <td className="py-2.5 px-3 font-medium">{p.productName}</td>
                        <td className="py-2.5 px-3 text-right font-mono text-emerald-700">{fmt(p.totalRevenue)}</td>
                        <td className="py-2.5 px-3 text-right">{p.totalQuantity.toLocaleString()}</td>
                        <td className="py-2.5 px-3 text-right">
                          <Badge variant="secondary">{p.orderCount}</Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </TenantPortalLayout>
  );
}
