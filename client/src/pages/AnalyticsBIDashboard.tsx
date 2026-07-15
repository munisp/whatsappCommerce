import { trpc } from "@/lib/trpc";
import DashboardLayout from "@/components/DashboardLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { TrendingUp, Users, AlertTriangle, BarChart2 } from "lucide-react";

const TENANT_ID = "default";

export default function AnalyticsBIDashboard() {
  const { data: summary } = trpc.analyticsBI.biSummary.useQuery({ tenantId: TENANT_ID });
  const { data: cohorts } = trpc.analyticsBI.listCohorts.useQuery({ tenantId: TENANT_ID });
  const { data: churnRisks } = trpc.analyticsBI.listChurnRisks.useQuery({ tenantId: TENANT_ID });

  const riskColor = (r: string) => {
    if (r === "high") return "bg-red-100 text-red-800";
    if (r === "medium") return "bg-yellow-100 text-yellow-800";
    return "bg-green-100 text-green-800";
  };

  return (
    <DashboardLayout>
      <div className="p-6 space-y-6">
        <h1 className="text-2xl font-bold text-gray-900">Analytics & Business Intelligence</h1>
        <p className="text-gray-500 text-sm">Cohort analysis · LTV · Churn prediction</p>

        {summary && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {[
              { label: "Latest Cohort", value: summary.latestCohortMonth ?? "—", icon: BarChart2, color: "text-blue-600" },
              { label: "Cohort Customers", value: summary.latestCohortCustomers, icon: Users, color: "text-green-600" },
              { label: "High Churn Risk", value: summary.churnHighRisk, icon: AlertTriangle, color: "text-red-600" },
              { label: "Avg Order Value", value: `₦${parseFloat(summary.avgOrderValue ?? "0").toLocaleString()}`, icon: TrendingUp, color: "text-purple-600" },
            ].map(({ label, value, icon: Icon, color }) => (
              <Card key={label}><CardContent className="pt-4"><div className="flex items-center gap-3"><Icon className={`w-8 h-8 ${color}`} /><div><p className="text-2xl font-bold">{value}</p><p className="text-xs text-gray-500">{label}</p></div></div></CardContent></Card>
            ))}
          </div>
        )}

        <div className="grid md:grid-cols-2 gap-6">
          <Card>
            <CardHeader><CardTitle className="text-base">Cohort Retention Trend</CardTitle></CardHeader>
            <CardContent>
              {(cohorts ?? []).length === 0 ? (
                <p className="text-center text-gray-400 py-6">No cohort data yet. Run cohort analysis to populate.</p>
              ) : (
                <div className="space-y-2">
                  {(cohorts ?? []).map(c => (
                    <div key={c.id} className="flex items-center justify-between py-2 border-b last:border-0">
                      <div>
                        <p className="font-medium">{c.cohortMonth}</p>
                        <p className="text-xs text-gray-500">{c.totalCustomers} customers</p>
                      </div>
                      <div className="text-right">
                        <p className="text-sm font-semibold">₦{parseFloat(c.totalRevenue ?? "0").toLocaleString()}</p>
                        <p className="text-xs text-gray-400">AOV: ₦{parseFloat(c.avgOrderValue ?? "0").toLocaleString()}</p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="text-base">Churn Risk Customers</CardTitle></CardHeader>
            <CardContent>
              {(churnRisks ?? []).length === 0 ? (
                <p className="text-center text-gray-400 py-6">No churn predictions yet.</p>
              ) : (
                <div className="space-y-2">
                  {(churnRisks ?? []).slice(0, 10).map(c => (
                    <div key={c.id} className="flex items-center justify-between py-2 border-b last:border-0">
                      <div>
                        <p className="font-medium">{c.customerPhone}</p>
                        <p className="text-xs text-gray-500">{c.daysSinceLastOrder ?? "?"} days since last order</p>
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge className={riskColor(c.riskLevel)}>{c.riskLevel} risk</Badge>
                        <span className="text-sm font-semibold">{c.churnScore}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </DashboardLayout>
  );
}
