import { TenantPortalLayout } from "@/components/TenantPortalLayout";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ShoppingCart, DollarSign, MessageSquare, Users, FileText, AlertTriangle } from "lucide-react";
import { Rocket, ChevronRight, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Link } from "wouter";
import { Skeleton } from "@/components/ui/skeleton";

function KpiCard({ title, value, icon: Icon, sub, color = "emerald" }: {
  title: string; value: string | number; icon: any; sub?: string; color?: string;
}) {
  return (
    <Card className="bg-slate-800 border-slate-700">
      <CardContent className="p-5">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs text-slate-400 mb-1">{title}</p>
            <p className="text-2xl font-bold text-white">{value}</p>
            {sub && <p className="text-xs text-slate-500 mt-1">{sub}</p>}
          </div>
          <div className={`bg-${color}-500/20 p-3 rounded-xl`}>
            <Icon className={`h-6 w-6 text-${color}-400`} />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export default function PortalDashboard() {
  const { data: tenant } = trpc.tenantPortal.getMyTenant.useQuery();
  const { data: kpis, isLoading } = trpc.tenantPortal.getDashboardKpis.useQuery();
  const { data: recentOrders } = trpc.tenantPortal.listMyOrders.useQuery({ limit: 5 });
  const { data: onboardingProgress } = trpc.onboardingProgress.getProgress.useQuery();

  const showResumeWidget = onboardingProgress && !onboardingProgress.isCompleted && onboardingProgress.completedSteps.length > 0;
  const onboardingPct = onboardingProgress
    ? Math.round((onboardingProgress.completedSteps.length / 5) * 100)
    : 0;

  return (
    <TenantPortalLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-white">
            {tenant ? `Welcome, ${tenant.name}` : "Merchant Dashboard"}
          </h1>
          <p className="text-slate-400 text-sm mt-1">
            Your store at a glance
            {tenant && <Badge className="ml-2 bg-emerald-600/20 text-emerald-400 border-emerald-600/30">{tenant.plan}</Badge>}
          </p>
        </div>

        {/* Resume Onboarding Widget */}
        {showResumeWidget && (
          <Card className="bg-amber-900/20 border-amber-600/40">
            <CardContent className="p-5">
              <div className="flex items-start justify-between gap-4">
                <div className="flex items-center gap-3">
                  <div className="bg-amber-500/20 p-2.5 rounded-xl">
                    <Rocket className="h-5 w-5 text-amber-400" />
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-white">Finish setting up your store</p>
                    <p className="text-xs text-slate-400 mt-0.5">
                      {onboardingProgress!.completedSteps.length} of 5 steps completed — continue where you left off
                    </p>
                    <div className="mt-2 flex items-center gap-2">
                      <Progress value={onboardingPct} className="h-1.5 w-32 bg-slate-700" />
                      <span className="text-xs text-amber-400 font-medium">{onboardingPct}%</span>
                    </div>
                  </div>
                </div>
                <Link href="/portal/setup">
                  <Button size="sm" className="bg-amber-600 hover:bg-amber-500 text-white shrink-0 gap-1">
                    Resume <ChevronRight className="h-3.5 w-3.5" />
                  </Button>
                </Link>
              </div>
            </CardContent>
          </Card>
        )}

        {isLoading ? (
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
            {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-24 bg-slate-700" />)}
          </div>
        ) : (
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
            <KpiCard title="Total Orders" value={kpis?.orders ?? 0} icon={ShoppingCart} sub="paid orders" />
            <KpiCard title="Revenue" value={`$${(kpis?.revenue ?? 0).toLocaleString()}`} icon={DollarSign} sub="all-time" color="yellow" />
            <KpiCard title="Conversations" value={kpis?.conversations ?? 0} icon={MessageSquare} sub="all channels" color="blue" />
            <KpiCard title="Customers" value={kpis?.customers ?? 0} icon={Users} sub="registered" color="purple" />
            <KpiCard title="Pending Invoices" value={kpis?.pendingInvoices ?? 0} icon={FileText} sub="awaiting payment" color="orange" />
          </div>
        )}

        <Card className="bg-slate-800 border-slate-700">
          <CardHeader className="pb-3">
            <CardTitle className="text-base text-white">Recent Orders</CardTitle>
          </CardHeader>
          <CardContent>
            {!recentOrders?.length ? (
              <p className="text-slate-500 text-sm text-center py-6">No orders yet</p>
            ) : (
              <div className="space-y-2">
                {recentOrders.map(order => (
                  <div key={order.id} className="flex items-center justify-between py-2 border-b border-slate-700 last:border-0">
                    <div>
                      <p className="text-sm font-medium text-white">{order.orderNumber}</p>
                      <p className="text-xs text-slate-400">{new Date(order.createdAt).toLocaleDateString()}</p>
                    </div>
                    <div className="text-right">
                      <p className="text-sm font-semibold text-white">${Number(order.totalAmount).toLocaleString()}</p>
                      <Badge variant="outline" className="text-xs border-slate-600 text-slate-300">{order.status}</Badge>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </TenantPortalLayout>
  );
}
