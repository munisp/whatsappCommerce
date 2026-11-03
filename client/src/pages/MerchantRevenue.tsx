import { CapabilityGuard } from "@/components/CapabilityGuard";
import DashboardLayout from "@/components/DashboardLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useActiveTenant } from "@/contexts/TenantContext";
import { trpc } from "@/lib/trpc";

const money = (amount: number, currency: string) =>
  new Intl.NumberFormat("en-NG", { style: "currency", currency, maximumFractionDigits: 2 }).format(amount);

function MerchantRevenueInner() {
  const { activeTenantId: tenantId } = useActiveTenant();
  const query = trpc.tenantPortal.getMyRevenue.useQuery({ tenantId: tenantId! }, { enabled: !!tenantId });
  const data = query.data;
  return (
    <DashboardLayout>
      <div className="p-6 space-y-5 max-w-5xl">
        <div>
          <h1 className="text-2xl font-bold">Revenue</h1>
          <p className="text-sm text-muted-foreground mt-1">What your shop has earned from paid orders.</p>
        </div>
        {query.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
        {query.error && <p className="text-sm text-destructive">{query.error.message}</p>}
        {data && data.totals.length === 0 && <p className="text-sm text-muted-foreground">No paid orders yet. Your revenue will appear here.</p>}
        {data?.totals.map((row) => (
          <div key={row.currency} className="grid gap-4 sm:grid-cols-4">
            <Card><CardHeader className="pb-1"><CardTitle className="text-sm font-medium">All time</CardTitle></CardHeader><CardContent className="text-2xl font-bold">{money(row.total, row.currency)}</CardContent></Card>
            <Card><CardHeader className="pb-1"><CardTitle className="text-sm font-medium">This month</CardTitle></CardHeader><CardContent className="text-2xl font-bold">{money(row.thisMonth, row.currency)}</CardContent></Card>
            <Card><CardHeader className="pb-1"><CardTitle className="text-sm font-medium">Last month</CardTitle></CardHeader><CardContent className="text-2xl font-bold">{money(row.lastMonth, row.currency)}</CardContent></Card>
            <Card><CardHeader className="pb-1"><CardTitle className="text-sm font-medium">Paid orders</CardTitle></CardHeader><CardContent className="text-2xl font-bold">{row.orders}</CardContent></Card>
          </div>
        ))}
        {data && data.months.length > 0 && (
          <Card>
            <CardHeader><CardTitle className="text-sm">Last 6 months</CardTitle></CardHeader>
            <CardContent className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="text-left text-muted-foreground"><th className="py-2 pr-4 font-medium">Month</th><th className="py-2 pr-4 font-medium">Paid orders</th><th className="py-2 font-medium">Revenue</th></tr></thead>
                <tbody>
                  {data.months.map((row) => (
                    <tr key={`${row.month}-${row.currency}`} className="border-t border-border">
                      <td className="py-2 pr-4">{new Date(`${row.month}-01T12:00:00`).toLocaleDateString("en-NG", { month: "long", year: "numeric" })}</td>
                      <td className="py-2 pr-4">{row.orders}</td>
                      <td className="py-2">{money(row.total, row.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
        )}
      </div>
    </DashboardLayout>
  );
}

export default function MerchantRevenue() {
  return (
    <CapabilityGuard cap="finance">
      <MerchantRevenueInner />
    </CapabilityGuard>
  );
}
