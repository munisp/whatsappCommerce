import { TenantPortalLayout } from "@/components/TenantPortalLayout";
import { trpc } from "@/lib/trpc";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { FileText, DollarSign } from "lucide-react";

const STATUS_COLORS: Record<string, string> = {
  draft: "bg-slate-600/20 text-slate-400 border-slate-600/30",
  sent: "bg-yellow-600/20 text-yellow-400 border-yellow-600/30",
  paid: "bg-emerald-600/20 text-emerald-400 border-emerald-600/30",
  overdue: "bg-red-600/20 text-red-400 border-red-600/30",
  cancelled: "bg-slate-600/20 text-slate-400 border-slate-600/30",
};

export default function PortalInvoices() {
  const { data: invoices } = trpc.tenantPortal.listMyInvoices.useQuery({ limit: 100 });

  const total = (invoices ?? []).reduce((s, i) => s + Number(i.totalAmount), 0);
  const paid = (invoices ?? []).filter(i => i.status === "paid").reduce((s, i) => s + Number(i.totalAmount), 0);
  const outstanding = total - paid;

  return (
    <TenantPortalLayout>
      <div className="space-y-6">
        <h1 className="text-2xl font-bold text-white">My Invoices</h1>

        <div className="grid grid-cols-3 gap-4">
          {[
            { label: "Total Invoiced", value: `$${total.toLocaleString()}`, color: "text-white" },
            { label: "Paid", value: `$${paid.toLocaleString()}`, color: "text-emerald-400" },
            { label: "Outstanding", value: `$${outstanding.toLocaleString()}`, color: "text-amber-400" },
          ].map(({ label, value, color }) => (
            <Card key={label} className="bg-slate-800 border-slate-700">
              <CardContent className="p-4">
                <p className="text-xs text-slate-400 mb-1">{label}</p>
                <p className={`text-xl font-bold ${color}`}>{value}</p>
              </CardContent>
            </Card>
          ))}
        </div>

        <Card className="bg-slate-800 border-slate-700">
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-700 text-slate-400 text-xs">
                  <th className="text-left p-4">Invoice #</th>
                  <th className="text-left p-4">Period</th>
                  <th className="text-left p-4">Amount</th>
                  <th className="text-left p-4">Type</th>
                  <th className="text-left p-4">Status</th>
                  <th className="text-left p-4">Due</th>
                </tr>
              </thead>
              <tbody>
                {(invoices ?? []).map(inv => (
                  <tr key={inv.id} className="border-b border-slate-700/50 hover:bg-slate-700/30">
                    <td className="p-4 font-mono text-white">{inv.invoiceNumber}</td>
                    <td className="p-4 text-slate-400">
                      {inv.periodStart ? new Date(inv.periodStart).toLocaleDateString() : "—"} –{" "}
                      {inv.periodEnd ? new Date(inv.periodEnd).toLocaleDateString() : "—"}
                    </td>
                    <td className="p-4 text-emerald-400 font-semibold">${Number(inv.totalAmount).toFixed(2)}</td>
                    <td className="p-4 text-slate-300 capitalize">{inv.type}</td>
                    <td className="p-4">
                      <Badge className={`text-xs ${STATUS_COLORS[inv.status] ?? ""}`}>{inv.status}</Badge>
                    </td>
                    <td className="p-4 text-slate-400">
                      {inv.dueDate ? new Date(inv.dueDate).toLocaleDateString() : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!invoices?.length && (
              <p className="text-center text-slate-500 py-10">No invoices yet</p>
            )}
          </CardContent>
        </Card>
      </div>
    </TenantPortalLayout>
  );
}
