// === W48 perf (PERF-FE-2 + PERF-FE-10) ===
// recharts (~100KB gzip) is confined to this module, which Dashboard lazy-loads
// via React.lazy so chart code stays out of the initial bundle. The widget is
// memoized so unrelated dashboard query updates don't re-render the charts.
import { memo } from "react";
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, BarChart, Bar } from "recharts";
import { TrendingUp } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export interface RevenuePoint {
  month: string;
  revenue: number;
}

export interface ConversationPoint {
  day: string;
  bot: number;
  human: number;
}

function ChartEmptyState({ label }: { label: string }) {
  return (
    <div className="h-[200px] flex flex-col items-center justify-center text-muted-foreground gap-1">
      <TrendingUp className="w-6 h-6 opacity-40" />
      <p className="text-sm font-medium">No data yet</p>
      <p className="text-xs">{label}</p>
    </div>
  );
}

const tooltipStyle = {
  background: "oklch(0.16 0.015 220)",
  border: "1px solid oklch(0.25 0.015 220)",
  borderRadius: 8,
  color: "oklch(0.95 0.005 220)",
} as const;

const axisTick = { fill: "oklch(0.60 0.01 220)", fontSize: 11 } as const;

export const RevenueTrendChart = memo(function RevenueTrendChart({ data }: { data: RevenuePoint[] }) {
  return (
    <Card className="bg-card border-border">
      <CardHeader><CardTitle className="text-sm font-medium text-muted-foreground">Revenue Trend (USD)</CardTitle></CardHeader>
      <CardContent>
        {data.length === 0 ? (
          <ChartEmptyState label="Completed (paid) order revenue for the last 7 months will appear here." />
        ) : (
          <ResponsiveContainer width="100%" height={200}>
            <AreaChart data={data}>
              <defs>
                <linearGradient id="revGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="oklch(0.65 0.18 160)" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="oklch(0.65 0.18 160)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="oklch(0.25 0.015 220)" />
              <XAxis dataKey="month" tick={axisTick} axisLine={false} tickLine={false} />
              <YAxis tick={axisTick} axisLine={false} tickLine={false} />
              <Tooltip contentStyle={tooltipStyle} />
              <Area type="monotone" dataKey="revenue" stroke="oklch(0.65 0.18 160)" fill="url(#revGrad)" strokeWidth={2} />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </CardContent>
    </Card>
  );
});

export const ConversationSplitChart = memo(function ConversationSplitChart({ data }: { data: ConversationPoint[] }) {
  return (
    <Card className="bg-card border-border">
      <CardHeader><CardTitle className="text-sm font-medium text-muted-foreground">Conversations (Bot vs Human)</CardTitle></CardHeader>
      <CardContent>
        {data.length === 0 ? (
          <ChartEmptyState label="AI-handled vs human conversations for the last 7 days will appear here." />
        ) : (
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={data}>
              <CartesianGrid strokeDasharray="3 3" stroke="oklch(0.25 0.015 220)" />
              <XAxis dataKey="day" tick={axisTick} axisLine={false} tickLine={false} />
              <YAxis tick={axisTick} axisLine={false} tickLine={false} />
              <Tooltip contentStyle={tooltipStyle} />
              <Bar dataKey="bot" fill="oklch(0.65 0.18 160)" radius={[3, 3, 0, 0]} />
              <Bar dataKey="human" fill="oklch(0.60 0.18 200)" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </CardContent>
    </Card>
  );
});

const DashboardCharts = memo(function DashboardCharts({
  revenueData,
  convData,
}: {
  revenueData: RevenuePoint[];
  convData: ConversationPoint[];
}) {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <RevenueTrendChart data={revenueData} />
      <ConversationSplitChart data={convData} />
    </div>
  );
});

export default DashboardCharts;
