import { TenantPortalLayout } from "@/components/TenantPortalLayout";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { useState } from "react";

const STATUS_COLORS: Record<string, string> = {
  pending: "bg-yellow-600/20 text-yellow-400 border-yellow-600/30",
  confirmed: "bg-blue-600/20 text-blue-400 border-blue-600/30",
  processing: "bg-purple-600/20 text-purple-400 border-purple-600/30",
  shipped: "bg-cyan-600/20 text-cyan-400 border-cyan-600/30",
  delivered: "bg-emerald-600/20 text-emerald-400 border-emerald-600/30",
  cancelled: "bg-red-600/20 text-red-400 border-red-600/30",
};

export default function PortalOrders() {
  const [filter, setFilter] = useState("all");
  const { data: orders, refetch } = trpc.tenantPortal.listMyOrders.useQuery({
    status: filter === "all" ? undefined : filter,
    limit: 100,
  });
  const updateMutation = trpc.tenantPortal.updateMyOrderStatus.useMutation({
    onSuccess: () => { toast.success("Order status updated"); refetch(); },
    onError: (e) => toast.error(e.message),
  });

  return (
    <TenantPortalLayout>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold text-white">My Orders</h1>
          <Select value={filter} onValueChange={setFilter}>
            <SelectTrigger className="w-40 bg-slate-800 border-slate-700 text-white">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="bg-slate-800 border-slate-700">
              {["all","pending","confirmed","processing","shipped","delivered","cancelled"].map(s => (
                <SelectItem key={s} value={s} className="text-slate-200 capitalize">{s}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <Card className="bg-slate-800 border-slate-700">
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-700 text-slate-400 text-xs">
                  <th className="text-left p-4">Order #</th>
                  <th className="text-left p-4">Date</th>
                  <th className="text-left p-4">Amount</th>
                  <th className="text-left p-4">Payment</th>
                  <th className="text-left p-4">Status</th>
                  <th className="text-left p-4">Action</th>
                </tr>
              </thead>
              <tbody>
                {(orders ?? []).map(order => (
                  <tr key={order.id} className="border-b border-slate-700/50 hover:bg-slate-700/30">
                    <td className="p-4 font-mono text-white">{order.orderNumber}</td>
                    <td className="p-4 text-slate-400">{new Date(order.createdAt).toLocaleDateString()}</td>
                    <td className="p-4 text-emerald-400 font-semibold">${Number(order.totalAmount).toFixed(2)}</td>
                    <td className="p-4">
                      <Badge variant="outline" className="text-xs border-slate-600 text-slate-300">{order.paymentStatus}</Badge>
                    </td>
                    <td className="p-4">
                      <Badge className={`text-xs ${STATUS_COLORS[order.status] ?? ""}`}>{order.status}</Badge>
                    </td>
                    <td className="p-4">
                      {["pending","confirmed","processing"].includes(order.status) && (
                        <Select
                          onValueChange={(v: any) => updateMutation.mutate({ orderId: order.id, status: v })}
                        >
                          <SelectTrigger className="h-7 w-32 bg-slate-700 border-slate-600 text-xs text-white">
                            <SelectValue placeholder="Update…" />
                          </SelectTrigger>
                          <SelectContent className="bg-slate-800 border-slate-700">
                            {["confirmed","processing","shipped","delivered","cancelled"].map(s => (
                              <SelectItem key={s} value={s} className="text-slate-200 text-xs capitalize">{s}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!orders?.length && (
              <p className="text-center text-slate-500 py-10">No orders found</p>
            )}
          </CardContent>
        </Card>
      </div>
    </TenantPortalLayout>
  );
}
