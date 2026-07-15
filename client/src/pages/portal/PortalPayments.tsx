import { TenantPortalLayout } from "@/components/TenantPortalLayout";
import { trpc } from "@/lib/trpc";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

const STATUS_COLORS: Record<string, string> = {
  initiated: "bg-yellow-600/20 text-yellow-400 border-yellow-600/30",
  completed: "bg-emerald-600/20 text-emerald-400 border-emerald-600/30",
  failed: "bg-red-600/20 text-red-400 border-red-600/30",
  cancelled: "bg-slate-600/20 text-slate-400 border-slate-600/30",
};

export default function PortalPayments() {
  const { data: txs } = trpc.tenantPortal.listMyTransactions.useQuery({ limit: 50 });

  return (
    <TenantPortalLayout>
      <div className="space-y-6">
        <h1 className="text-2xl font-bold text-white">Payment Transactions</h1>
        <Card className="bg-slate-800 border-slate-700">
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-700 text-slate-400 text-xs">
                  <th className="text-left p-4">Ref</th>
                  <th className="text-left p-4">Provider</th>
                  <th className="text-left p-4">Amount</th>
                  <th className="text-left p-4">Currency</th>
                  <th className="text-left p-4">Status</th>
                  <th className="text-left p-4">Date</th>
                </tr>
              </thead>
              <tbody>
                {(txs ?? []).map(tx => (
                  <tr key={tx.id} className="border-b border-slate-700/50 hover:bg-slate-700/30">
                    <td className="p-4 font-mono text-xs text-slate-300">{tx.providerRef ?? tx.id.slice(0, 8)}</td>
                    <td className="p-4 text-slate-300 capitalize">{tx.provider}</td>
                    <td className="p-4 text-emerald-400 font-semibold">{Number(tx.amount).toFixed(2)}</td>
                    <td className="p-4 text-slate-400">{tx.currency}</td>
                    <td className="p-4">
                      <Badge className={`text-xs ${STATUS_COLORS[tx.status] ?? ""}`}>{tx.status}</Badge>
                    </td>
                    <td className="p-4 text-slate-400">{new Date(tx.createdAt).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!txs?.length && (
              <p className="text-center text-slate-500 py-10">No transactions yet</p>
            )}
          </CardContent>
        </Card>
      </div>
    </TenantPortalLayout>
  );
}

