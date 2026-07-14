import { useState } from "react";
import { trpc } from "@/lib/trpc";
import DashboardLayout from "@/components/DashboardLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ResponsiveContainer, PieChart, Pie, Cell,
} from "recharts";
import {
  TrendingUp, TrendingDown, DollarSign, Users, CreditCard,
  BarChart2, Info, ArrowUpRight, ArrowDownRight, Telescope, Trophy,
} from "lucide-react";
import { cn } from "@/lib/utils";

const COLORS = ["#22d3ee", "#4ade80", "#fbbf24", "#a78bfa", "#f87171", "#fb923c"];

function fmt(n: number, decimals = 0) {
  if (n >= 1_000_000) return `₦${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `₦${(n / 1_000).toFixed(1)}k`;
  return `₦${n.toFixed(decimals)}`;
}
function fmtUsd(n: number) {
  if (n >= 1_000) return `$${(n / 1_000).toFixed(2)}k`;
  return `$${n.toFixed(2)}`;
}
function pct(n: number) {
  return `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;
}

function KpiCard({
  title, value, sub, trend, icon: Icon, accent = false,
}: {
  title: string; value: string; sub?: string; trend?: number; icon: React.ElementType; accent?: boolean;
}) {
  return (
    <Card className={cn("relative overflow-hidden", accent && "border-cyan-500/40 bg-cyan-950/20")}>
      <CardContent className="pt-5 pb-4">
        <div className="flex items-start justify-between">
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground uppercase tracking-wider">{title}</p>
            <p className="text-2xl font-bold">{value}</p>
            {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
          </div>
          <div className={cn("rounded-lg p-2", accent ? "bg-cyan-500/20" : "bg-muted")}>
            <Icon className={cn("h-5 w-5", accent ? "text-cyan-400" : "text-muted-foreground")} />
          </div>
        </div>
        {trend !== undefined && (
          <div className={cn("mt-3 flex items-center gap-1 text-xs font-medium",
            trend >= 0 ? "text-green-400" : "text-red-400")}>
            {trend >= 0 ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
            {pct(trend)} vs last month
          </div>
        )}
      </CardContent>
    </Card>
  );
}

const CustomTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border bg-card p-3 shadow-lg text-xs space-y-1">
      <p className="font-semibold text-foreground mb-2">{label}</p>
      {payload.map((p: any) => (
        <div key={p.name} className="flex items-center gap-2">
          <span className="inline-block h-2 w-2 rounded-full" style={{ background: p.color }} />
          <span className="text-muted-foreground">{p.name}:</span>
          <span className="font-medium">{typeof p.value === "number" && p.value > 100 ? fmt(p.value) : p.value}</span>
        </div>
      ))}
    </div>
  );
};

export default function RevenueDashboard() {
  const [trendMonths, setTrendMonths] = useState("12");
  const [forecastHorizon, setForecastHorizon] = useState("6");
  const { data: summary, isLoading: summaryLoading } = trpc.revenue.summary.useQuery();
  const { data: trend, isLoading: trendLoading } = trpc.revenue.monthlyTrend.useQuery({
    months: parseInt(trendMonths),
  });
  const { data: tenantBreakdown, isLoading: breakdownLoading } = trpc.revenue.tenantBreakdown.useQuery({ limit: 20 });
  const { data: config } = trpc.revenue.getConfig.useQuery();
  const { data: forecastData, isLoading: forecastLoading } = trpc.revenue.forecast.useQuery({
    horizonMonths: parseInt(forecastHorizon),
  });
  const { data: leaderboard, isLoading: leaderboardLoading } = trpc.revenue.gmvLeaderboard.useQuery({ limit: 15 });
  const combinedForecast = forecastData
    ? [
        ...forecastData.historical.map((h) => ({ ...h, isForecast: false })),
        ...forecastData.forecast,
      ]
    : [];

  const pieData = summary
    ? [
        { name: "Profit Share (5% of tenant net profit)", value: summary.platformProfitShare },
        { name: "Txn Revenue Share (0.2% GMV)", value: summary.platformTxnRevenue },
      ]
    : [];

  return (
    <DashboardLayout>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">Revenue Dashboard</h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              Profit-sharing model · Platform earns{" "}
              <span className="font-semibold text-cyan-400">
                {config ? `${(config.profitShareRate * 100).toFixed(0)}% of tenant net profit` : "5% of tenant net profit"}
              </span>{" "}
              +{" "}
              <span className="font-semibold text-green-400">
                {config ? `${(config.txnShareRate * 100).toFixed(1)}% of GMV` : "0.2% of GMV"}
              </span>
            </p>
          </div>
          <Badge variant="outline" className="gap-1 text-cyan-400 border-cyan-500/40">
            <Info className="h-3 w-3" /> Live data
          </Badge>
        </div>

        {/* Model explanation banner */}
        {config && (
          <div className="rounded-lg border border-cyan-500/20 bg-cyan-950/10 p-4 text-sm text-muted-foreground">
            <span className="font-semibold text-foreground">Profit-Sharing Model: </span>
            {config.description}
            {" "}Estimated tenant COGS: {(config.cogsEstimateRate * 100).toFixed(0)}%.
            Processing cost deducted: {(config.processingCostRate * 100).toFixed(1)}%.
          </div>
        )}

        {/* KPI Cards */}
        {summaryLoading ? (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {[...Array(4)].map((_, i) => <Skeleton key={i} className="h-28 rounded-xl" />)}
          </div>
        ) : summary ? (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <KpiCard
              title="Platform Revenue (MTD)"
              value={fmtUsd(summary.totalPlatformRevenue)}
              sub={`Profit share: ${fmtUsd(summary.platformProfitShare)} · Txn: ${fmtUsd(summary.platformTxnRevenue)}`}
              icon={DollarSign}
              accent
            />
            <KpiCard
              title="Gross GMV (MTD)"
              value={fmt(summary.gmvThisMonth)}
              sub={`Last month: ${fmt(summary.gmvLastMonth)}`}
              trend={summary.gmvGrowthPct}
              icon={TrendingUp}
            />
            <KpiCard
              title="Transactions (30d)"
              value={summary.txnTotal.toLocaleString()}
              sub={`Success rate: ${summary.txnSuccessRate}%`}
              icon={CreditCard}
            />
            <KpiCard
              title="Active Tenants (30d)"
              value={`${summary.activeTenants} / ${summary.totalTenants}`}
              sub="Active vs total enrolled"
              icon={Users}
            />
          </div>
        ) : (
          <p className="text-muted-foreground text-sm">No transaction data yet.</p>
        )}

        <Tabs defaultValue="trend">
          <div className="flex items-center justify-between">
            <TabsList>
              <TabsTrigger value="trend">Monthly Trend</TabsTrigger>
              <TabsTrigger value="breakdown">Tenant Breakdown</TabsTrigger>
              <TabsTrigger value="mix">Revenue Mix</TabsTrigger>
              <TabsTrigger value="forecast">Forecast</TabsTrigger>
              <TabsTrigger value="leaderboard">GMV Growth</TabsTrigger>
            </TabsList>
            <Select value={trendMonths} onValueChange={setTrendMonths}>
              <SelectTrigger className="w-32 h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="3">3 months</SelectItem>
                <SelectItem value="6">6 months</SelectItem>
                <SelectItem value="12">12 months</SelectItem>
                <SelectItem value="24">24 months</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Monthly Trend Tab */}
          <TabsContent value="trend" className="mt-4 space-y-4">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium">GMV & Platform Revenue</CardTitle>
              </CardHeader>
              <CardContent>
                {trendLoading ? <Skeleton className="h-64" /> : (
                  <ResponsiveContainer width="100%" height={280}>
                    <AreaChart data={trend} margin={{ top: 4, right: 8, bottom: 0, left: 8 }}>
                      <defs>
                        <linearGradient id="gmvGrad" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#22d3ee" stopOpacity={0.3} />
                          <stop offset="95%" stopColor="#22d3ee" stopOpacity={0} />
                        </linearGradient>
                        <linearGradient id="revGrad" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#4ade80" stopOpacity={0.4} />
                          <stop offset="95%" stopColor="#4ade80" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                      <XAxis dataKey="month" tick={{ fontSize: 11, fill: "#94a3b8" }} />
                      <YAxis tick={{ fontSize: 11, fill: "#94a3b8" }} tickFormatter={(v) => fmt(v)} />
                      <Tooltip content={<CustomTooltip />} />
                      <Legend wrapperStyle={{ fontSize: 12 }} />
                      <Area type="monotone" dataKey="gmv" name="GMV (₦)" stroke="#22d3ee" fill="url(#gmvGrad)" strokeWidth={2} />
                      <Area type="monotone" dataKey="platformRevenue" name="Platform Revenue ($)" stroke="#4ade80" fill="url(#revGrad)" strokeWidth={2} />
                    </AreaChart>
                  </ResponsiveContainer>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium">Transaction Volume</CardTitle>
              </CardHeader>
              <CardContent>
                {trendLoading ? <Skeleton className="h-48" /> : (
                  <ResponsiveContainer width="100%" height={200}>
                    <BarChart data={trend} margin={{ top: 4, right: 8, bottom: 0, left: 8 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                      <XAxis dataKey="month" tick={{ fontSize: 11, fill: "#94a3b8" }} />
                      <YAxis tick={{ fontSize: 11, fill: "#94a3b8" }} />
                      <Tooltip content={<CustomTooltip />} />
                      <Legend wrapperStyle={{ fontSize: 12 }} />
                      <Bar dataKey="txnCount" name="Successful" fill="#4ade80" radius={[3, 3, 0, 0]} />
                      <Bar dataKey="failedCount" name="Failed" fill="#f87171" radius={[3, 3, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* Tenant Breakdown Tab */}
          <TabsContent value="breakdown" className="mt-4">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium flex items-center gap-2">
                  <BarChart2 className="h-4 w-4" /> Top Tenants by GMV (Last 30 Days)
                </CardTitle>
              </CardHeader>
              <CardContent>
                {breakdownLoading ? <Skeleton className="h-64" /> : !tenantBreakdown?.length ? (
                  <p className="text-sm text-muted-foreground py-8 text-center">No transaction data yet.</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b text-xs text-muted-foreground uppercase">
                          <th className="text-left py-2 pr-4">Tenant</th>
                          <th className="text-right py-2 pr-4">GMV</th>
                          <th className="text-right py-2 pr-4">Txns</th>
                          <th className="text-right py-2 pr-4">Profit Share</th>
                          <th className="text-right py-2 pr-4">Txn Revenue</th>
                          <th className="text-right py-2">Total Platform Rev</th>
                        </tr>
                      </thead>
                      <tbody>
                        {tenantBreakdown.map((t, i) => (
                          <tr key={t.tenantId} className="border-b border-border/40 hover:bg-muted/30 transition-colors">
                            <td className="py-2 pr-4">
                              <div className="flex items-center gap-2">
                                <span className="text-xs text-muted-foreground w-5">{i + 1}</span>
                                <span className="font-medium truncate max-w-[160px]">{t.businessName}</span>
                              </div>
                            </td>
                            <td className="text-right py-2 pr-4 font-mono text-xs">{fmt(t.gmv)}</td>
                            <td className="text-right py-2 pr-4 text-muted-foreground">{t.txnCount}</td>
                            <td className="text-right py-2 pr-4 text-green-400 font-mono text-xs">{fmtUsd(t.profitShareRevenue)}</td>
                            <td className="text-right py-2 pr-4 text-cyan-400 font-mono text-xs">{fmtUsd(t.txnRevenue)}</td>
                            <td className="text-right py-2 font-semibold font-mono text-xs">{fmtUsd(t.platformRevenue)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* Revenue Mix Tab */}

          {/* Forecast Tab */}
          <TabsContent value="forecast" className="mt-4 space-y-4">
            <div className="flex items-center justify-between">
              <p className="text-sm text-muted-foreground">Linear regression on last 12 months. Dashed = projected.</p>
              <Select value={forecastHorizon} onValueChange={setForecastHorizon}>
                <SelectTrigger className="w-36 h-8 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="3">+3 months</SelectItem>
                  <SelectItem value="6">+6 months</SelectItem>
                  <SelectItem value="12">+12 months</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium flex items-center gap-2">
                  <Telescope className="h-4 w-4 text-cyan-400" /> Revenue Forecast
                </CardTitle>
              </CardHeader>
              <CardContent>
                {forecastLoading ? <Skeleton className="h-72" /> : (
                  <ResponsiveContainer width="100%" height={300}>
                    <AreaChart data={combinedForecast} margin={{ top: 4, right: 8, bottom: 0, left: 8 }}>
                      <defs>
                        <linearGradient id="foreGrad" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#4ade80" stopOpacity={0.35} />
                          <stop offset="95%" stopColor="#4ade80" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                      <XAxis dataKey="month" tick={{ fontSize: 11, fill: "#94a3b8" }} />
                      <YAxis tick={{ fontSize: 11, fill: "#94a3b8" }} tickFormatter={(v) => fmtUsd(v)} />
                      <Tooltip content={<CustomTooltip />} />
                      <Legend wrapperStyle={{ fontSize: 12 }} />
                      <Area type="monotone" dataKey="platformRevenue" name="Platform Revenue ($)" stroke="#4ade80" fill="url(#foreGrad)" strokeWidth={2} connectNulls />
                      <Area type="monotone" dataKey="gmv" name="GMV (₦)" stroke="#22d3ee" fill="none" strokeWidth={1.5} connectNulls />
                    </AreaChart>
                  </ResponsiveContainer>
                )}
              </CardContent>
            </Card>
            {forecastData && forecastData.forecast.length > 0 && (
              <Card>
                <CardHeader className="pb-2"><CardTitle className="text-sm font-medium">Projected Months</CardTitle></CardHeader>
                <CardContent>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b text-xs text-muted-foreground uppercase">
                          <th className="text-left py-2 pr-4">Month</th>
                          <th className="text-right py-2 pr-4">Projected GMV</th>
                          <th className="text-right py-2">Projected Platform Revenue</th>
                        </tr>
                      </thead>
                      <tbody>
                        {forecastData.forecast.map((f) => (
                          <tr key={f.month} className="border-b border-border/40 hover:bg-muted/30">
                            <td className="py-2 pr-4 font-mono text-xs text-yellow-400">{f.month} <span className="text-muted-foreground">(forecast)</span></td>
                            <td className="text-right py-2 pr-4 font-mono text-xs">{fmt(f.gmv)}</td>
                            <td className="text-right py-2 font-semibold font-mono text-xs text-green-400">{fmtUsd(f.platformRevenue)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </CardContent>
              </Card>
            )}
          </TabsContent>

          {/* GMV Growth Leaderboard Tab */}
          <TabsContent value="leaderboard" className="mt-4">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium flex items-center gap-2">
                  <Trophy className="h-4 w-4 text-yellow-400" /> GMV Growth Leaderboard — Month-on-Month
                </CardTitle>
              </CardHeader>
              <CardContent>
                {leaderboardLoading ? <Skeleton className="h-64" /> : !leaderboard?.length ? (
                  <p className="text-sm text-muted-foreground py-8 text-center">No transaction data yet.</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b text-xs text-muted-foreground uppercase">
                          <th className="text-left py-2 pr-4">Rank</th>
                          <th className="text-left py-2 pr-4">Tenant</th>
                          <th className="text-right py-2 pr-4">GMV This Mo.</th>
                          <th className="text-right py-2 pr-4">GMV Last Mo.</th>
                          <th className="text-right py-2 pr-4">MoM Growth</th>
                          <th className="text-right py-2 pr-4">COGS</th>
                          <th className="text-right py-2">Platform Rev</th>
                        </tr>
                      </thead>
                      <tbody>
                        {leaderboard
                          .slice()
                          .sort((a, b) => (b.momGrowthPct ?? -Infinity) - (a.momGrowthPct ?? -Infinity))
                          .map((t, i) => (
                            <tr key={t.tenantId} className="border-b border-border/40 hover:bg-muted/30 transition-colors">
                              <td className="py-2 pr-4">
                                <span className={cn("text-xs font-bold", i === 0 ? "text-yellow-400" : i === 1 ? "text-slate-300" : i === 2 ? "text-amber-600" : "text-muted-foreground")}>
                                  #{i + 1}
                                </span>
                              </td>
                              <td className="py-2 pr-4 font-medium truncate max-w-[160px]">{t.businessName}</td>
                              <td className="text-right py-2 pr-4 font-mono text-xs">{fmt(t.gmvThisMonth)}</td>
                              <td className="text-right py-2 pr-4 font-mono text-xs text-muted-foreground">{fmt(t.gmvLastMonth)}</td>
                              <td className="text-right py-2 pr-4">
                                {t.momGrowthPct === null ? (
                                  <span className="text-xs text-muted-foreground">New</span>
                                ) : (
                                  <span className={cn("text-xs font-semibold", t.momGrowthPct >= 0 ? "text-green-400" : "text-red-400")}>
                                    {t.momGrowthPct >= 0 ? "+" : ""}{t.momGrowthPct.toFixed(1)}%
                                  </span>
                                )}
                              </td>
                              <td className="text-right py-2 pr-4 text-xs text-muted-foreground">{(t.cogsRate * 100).toFixed(0)}%</td>
                              <td className="text-right py-2 font-semibold font-mono text-xs text-cyan-400">{fmtUsd(t.platformRevenue)}</td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="mix" className="mt-4">
            <div className="grid md:grid-cols-2 gap-4">
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium">Revenue Stream Mix (MTD)</CardTitle>
                </CardHeader>
                <CardContent>
                  {summaryLoading ? <Skeleton className="h-56" /> : (
                    <ResponsiveContainer width="100%" height={220}>
                      <PieChart>
                        <Pie data={pieData} cx="50%" cy="50%" outerRadius={80} dataKey="value" label={({ name, percent }) =>
                          `${(percent * 100).toFixed(0)}%`
                        }>
                          {pieData.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                        </Pie>
                        <Tooltip formatter={(v: number) => fmtUsd(v)} />
                        <Legend wrapperStyle={{ fontSize: 11 }} />
                      </PieChart>
                    </ResponsiveContainer>
                  )}
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium">Profit-Sharing Rate Card</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3 pt-2">
                  {config ? (
                    <>
                      <div className="flex justify-between items-center py-2 border-b border-border/40">
                        <span className="text-sm text-muted-foreground">Profit share rate</span>
                        <Badge className="bg-cyan-500/20 text-cyan-300 border-cyan-500/30">
                          {(config.profitShareRate * 100).toFixed(0)}% of net profit
                        </Badge>
                      </div>
                      <div className="flex justify-between items-center py-2 border-b border-border/40">
                        <span className="text-sm text-muted-foreground">Transaction revenue share</span>
                        <Badge className="bg-green-500/20 text-green-300 border-green-500/30">
                          {(config.txnShareRate * 100).toFixed(1)}% of GMV
                        </Badge>
                      </div>
                      <div className="flex justify-between items-center py-2 border-b border-border/40">
                        <span className="text-sm text-muted-foreground">Processing cost deducted</span>
                        <span className="text-sm font-medium">{(config.processingCostRate * 100).toFixed(1)}%</span>
                      </div>
                      <div className="flex justify-between items-center py-2">
                        <span className="text-sm text-muted-foreground">Estimated COGS deducted</span>
                        <span className="text-sm font-medium">{(config.cogsEstimateRate * 100).toFixed(0)}%</span>
                      </div>
                      <p className="text-xs text-muted-foreground pt-2 leading-relaxed">
                        Net profit = GMV − {(config.processingCostRate * 100).toFixed(1)}% processing − {(config.cogsEstimateRate * 100).toFixed(0)}% COGS.
                        Platform revenue = {(config.profitShareRate * 100).toFixed(0)}% × net profit + {(config.txnShareRate * 100).toFixed(1)}% × GMV.
                      </p>
                    </>
                  ) : <Skeleton className="h-40" />}
                </CardContent>
              </Card>
            </div>
          </TabsContent>
        </Tabs>
      </div>
    </DashboardLayout>
  );
}
