import { CapabilityGuard } from "@/components/CapabilityGuard";
import DashboardLayout from "@/components/DashboardLayout";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useActiveTenant } from "@/contexts/TenantContext";
import { trpc } from "@/lib/trpc";

const money = (amount: number | string, currency = "NGN") =>
  new Intl.NumberFormat("en-NG", { style: "currency", currency, maximumFractionDigits: 2 }).format(Number(amount));

const STATE_LABELS: Record<string, string> = {
  payment_received: "Payment received",
  escrow_held: "Held",
  delivery_confirmed: "Delivered",
  release_instructed: "Being released",
  settled: "Paid to you",
  dispute_raised: "In dispute",
  dispute_resolved: "Dispute resolved",
  refunded: "Refunded",
  expired: "Expired",
};

function MerchantEscrowInner() {
  const { activeTenantId: tenantId } = useActiveTenant();
  const query = trpc.tenantPortal.getMyEscrow.useQuery({ tenantId: tenantId! }, { enabled: !!tenantId });
  const data = query.data;
  return (
    <DashboardLayout>
      <div className="p-6 space-y-5 max-w-5xl">
        <div>
          <h1 className="text-2xl font-bold">Escrow</h1>
          <p className="text-sm text-muted-foreground mt-1">Customers' payments are held safely until their orders are delivered, then released to you.</p>
        </div>
        {query.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
        {query.error && <p className="text-sm text-destructive">{query.error.message}</p>}
        {data && (
          <>
            <div className="grid gap-4 sm:grid-cols-3">
              <Card><CardHeader className="pb-1"><CardTitle className="text-sm font-medium">Being held</CardTitle></CardHeader><CardContent className="text-2xl font-bold">{money(data.held)}</CardContent></Card>
              <Card><CardHeader className="pb-1"><CardTitle className="text-sm font-medium">Paid to you</CardTitle></CardHeader><CardContent className="text-2xl font-bold">{money(data.settled)}</CardContent></Card>
              <Card><CardHeader className="pb-1"><CardTitle className="text-sm font-medium">Open disputes</CardTitle></CardHeader><CardContent className="text-2xl font-bold">{data.openDisputes}</CardContent></Card>
            </div>
            <Card>
              <CardHeader><CardTitle className="text-sm">Recent payments</CardTitle></CardHeader>
              <CardContent className="overflow-x-auto">
                {data.items.length === 0 ? <p className="text-sm text-muted-foreground">No escrow payments yet.</p> : (
                  <table className="w-full text-sm">
                    <thead><tr className="text-left text-muted-foreground"><th className="py-2 pr-4 font-medium">Date</th><th className="py-2 pr-4 font-medium">Amount</th><th className="py-2 pr-4 font-medium">Fee</th><th className="py-2 pr-4 font-medium">You get</th><th className="py-2 font-medium">Status</th></tr></thead>
                    <tbody>
                      {data.items.map((item) => (
                        <tr key={item.id} className="border-t border-border">
                          <td className="py-2 pr-4">{new Date(item.createdAt).toLocaleDateString("en-NG", { day: "numeric", month: "short", year: "numeric" })}</td>
                          <td className="py-2 pr-4">{money(item.amount, item.currency)}</td>
                          <td className="py-2 pr-4">{money(item.platformFee ?? 0, item.currency)}</td>
                          <td className="py-2 pr-4">{item.netMerchantAmount === null ? "—" : money(item.netMerchantAmount, item.currency)}</td>
                          <td className="py-2"><Badge variant="secondary">{STATE_LABELS[item.state] ?? item.state}</Badge></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </DashboardLayout>
  );
}

export default function MerchantEscrow() {
  return (
    <CapabilityGuard cap="finance">
      <MerchantEscrowInner />
    </CapabilityGuard>
  );
}
