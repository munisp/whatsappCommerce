/**
 * Platform admin home: how the platform is doing, what needs the owner, and
 * what just happened (server/routers/platformOverview.ts).
 */
import DashboardLayout from "@/components/DashboardLayout";
import { AdminGuard } from "@/components/AdminGuard";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { trpc } from "@/lib/trpc";
import { formatMoney } from "@/lib/money";
import { formatDistanceToNow } from "date-fns";
import { AlertTriangle, ArrowRight, CheckCircle2, MessageSquare, ShoppingBag, Store, Wallet } from "lucide-react";
import { Link } from "wouter";

const SEVERITY: Record<string, string> = {
  high: "border-l-red-500",
  medium: "border-l-amber-500",
  low: "border-l-muted-foreground/40",
};

const PAYMENT: Record<string, { label: string; cls: string }> = {
  completed: { label: "Paid", cls: "bg-green-500/15 text-green-600 border-green-500/30" },
  unpaid: { label: "Unpaid", cls: "bg-amber-500/15 text-amber-600 border-amber-500/30" },
  pending: { label: "Pending", cls: "bg-amber-500/15 text-amber-600 border-amber-500/30" },
  failed: { label: "Failed", cls: "bg-red-500/15 text-red-600 border-red-500/30" },
  refunded: { label: "Refunded", cls: "bg-muted text-muted-foreground" },
};

const STATE_LABEL: Record<string, string> = { live: "Live", setting_up: "Setting up", trial: "Trial", failed: "Setup failed", suspended: "Suspended" };

function Stat({ icon: Icon, label, value, sub, href, alert }: { icon: any; label: string; value: string | number; sub?: string; href?: string; alert?: boolean }) {
  const body = (
    <Card className={`bg-card border-border h-full ${href ? "transition-colors hover:bg-accent/30" : ""}`}>
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-2">
          <p className="text-xs text-muted-foreground">{label}</p>
          <Icon className={`w-4 h-4 ${alert ? "text-red-500" : "text-muted-foreground"}`} aria-hidden="true" />
        </div>
        <p className="text-2xl font-bold mt-1 text-foreground tabular-nums">{value}</p>
        {sub && <p className={`text-xs mt-1 ${alert ? "text-red-500" : "text-muted-foreground"}`}>{sub}</p>}
      </CardContent>
    </Card>
  );
  return href ? <Link href={href} className="block h-full">{body}</Link> : body;
}

function OverviewInner() {
  const { data, isLoading, error } = trpc.platformOverview.overview.useQuery(undefined, { refetchInterval: 60_000 });

  return (
    <DashboardLayout>
      <div className="p-4 sm:p-6 space-y-6 max-w-7xl">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Platform overview</h1>
          <p className="text-muted-foreground mt-1">
            {new Date().toLocaleDateString("en-NG", { weekday: "long", day: "numeric", month: "long" })} · refreshes every minute
          </p>
        </div>

        {error && <p className="text-sm text-red-500" role="alert">Couldn't load the overview: {error.message}</p>}
        {isLoading && <p className="text-sm text-muted-foreground" role="status">Loading…</p>}

        {data && (
          <>
            <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
              <Stat icon={Store} label="Shops live" value={data.shops.live} sub={`of ${data.shops.total} shops`} href="/tenants?state=live" />
              <Stat icon={Store} label="Setting up" value={data.shops.settingUp}
                sub={data.shops.failed ? `${data.shops.failed} failed setup` : "none stuck"} alert={data.shops.failed > 0} href="/tenants?state=setting_up" />
              <Stat icon={ShoppingBag} label="Orders, last 7 days" value={data.orders.last7d} sub={`${data.orders.today} today`} />
              <Stat icon={Wallet} label="Paid sales, last 7 days" value={formatMoney(data.orders.paidNgn7d, "NGN", 0)} sub={`${data.orders.paid7d} paid orders`} />
              <Stat icon={MessageSquare} label="WhatsApp, last 24 hours" value={data.messages.sent24h}
                sub={data.messages.failed24h ? `sent · ${data.messages.failed24h} failed` : `sent · ${data.messages.received24h} received`}
                alert={data.messages.failed24h > 0} />
            </div>

            <div className="grid gap-6 lg:grid-cols-5">
              <Card className="bg-card border-border lg:col-span-3">
                <CardHeader className="pb-2">
                  <CardTitle className="text-base flex items-center gap-2">
                    Needs your attention
                    {data.attention.length > 0 && <Badge variant="outline">{data.attention.length}</Badge>}
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  {data.attention.length === 0 ? (
                    <p className="flex items-center gap-2 text-sm text-muted-foreground py-4">
                      <CheckCircle2 className="w-4 h-4 text-green-600" aria-hidden="true" /> Nothing needs you right now.
                    </p>
                  ) : data.attention.map((a, i) => (
                    <div key={i} className={`border border-border border-l-4 ${SEVERITY[a.severity]} rounded-md p-3 flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between`}>
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-foreground flex items-center gap-1.5">
                          {a.severity === "high" && <AlertTriangle className="w-3.5 h-3.5 text-red-500 shrink-0" aria-hidden="true" />}
                          {a.title}
                        </p>
                        <p className="text-xs text-muted-foreground mt-0.5">{a.detail}</p>
                      </div>
                      {a.action && (
                        <Link href={a.action} className="text-xs font-medium text-primary inline-flex items-center gap-1 shrink-0 hover:underline">
                          {a.kind === "verification" || a.kind === "not_discoverable" ? "Review" : "Open shop"} <ArrowRight className="w-3 h-3" aria-hidden="true" />
                        </Link>
                      )}
                    </div>
                  ))}
                </CardContent>
              </Card>

              <div className="lg:col-span-2 space-y-6">
                <Card className="bg-card border-border">
                  <CardHeader className="pb-2"><CardTitle className="text-base">Latest orders</CardTitle></CardHeader>
                  <CardContent className="space-y-0 divide-y divide-border">
                    {data.recentOrders.length === 0 ? <p className="text-sm text-muted-foreground py-2">No orders yet.</p> : data.recentOrders.map((o) => (
                      <div key={o.id} className="py-2 flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-sm font-medium truncate">{o.shop}</p>
                          <p className="text-xs text-muted-foreground font-mono">{o.number} · {formatDistanceToNow(new Date(o.at), { addSuffix: true })}</p>
                        </div>
                        <div className="text-right shrink-0">
                          <p className="text-sm tabular-nums">{formatMoney(o.total, o.currency, 0)}</p>
                          <Badge variant="outline" className={`text-[10px] ${PAYMENT[o.payment]?.cls ?? ""}`}>{PAYMENT[o.payment]?.label ?? o.payment}</Badge>
                        </div>
                      </div>
                    ))}
                  </CardContent>
                </Card>

                <Card className="bg-card border-border">
                  <CardHeader className="pb-2 flex flex-row items-center justify-between space-y-0">
                    <CardTitle className="text-base">Newest shops</CardTitle>
                    <Link href="/tenants" className="text-xs text-primary hover:underline">All shops</Link>
                  </CardHeader>
                  <CardContent className="divide-y divide-border">
                    {data.newestShops.map((s) => (
                      <Link key={s.id} href={`/tenants/${s.id}`} className="py-2 flex items-center justify-between gap-3 hover:bg-accent/30 -mx-2 px-2 rounded">
                        <div className="min-w-0">
                          <p className="text-sm font-medium truncate">{s.name}</p>
                          <p className="text-xs text-muted-foreground">{formatDistanceToNow(new Date(s.createdAt), { addSuffix: true })} · {s.whatsapp === "own" ? "own number" : "shared number"}</p>
                        </div>
                        <Badge variant="outline" className="shrink-0">{STATE_LABEL[s.state] ?? s.state}</Badge>
                      </Link>
                    ))}
                  </CardContent>
                </Card>
              </div>
            </div>
          </>
        )}
      </div>
    </DashboardLayout>
  );
}

export default function PlatformOverview() {
  return (
    <AdminGuard>
      <OverviewInner />
    </AdminGuard>
  );
}
