import { TenantPortalLayout } from "@/components/TenantPortalLayout";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";

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
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const { data: orders, refetch } = trpc.tenantPortal.listMyOrders.useQuery({
    status: filter === "all" ? undefined : filter,
    limit: 100,
  });
  const updateMutation = trpc.tenantPortal.updateMyOrderStatus.useMutation({
    onSuccess: () => { toast.success("Order status updated"); refetch(); },
    onError: (e) => toast.error(e.message),
  });

  const { data: orderDetail, isLoading: detailLoading } = trpc.tenantPortal.getMyOrderDetail.useQuery(
    { orderId: expandedId ?? "" },
    { enabled: !!expandedId }
  );

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
                  <th className="text-left p-4 w-8"></th>
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
                  <>
                  <tr key={order.id} className={`border-b border-slate-700/50 hover:bg-slate-700/30 cursor-pointer ${expandedId === order.id ? "bg-slate-700/40" : ""}`}
                    onClick={() => setExpandedId(expandedId === order.id ? null : order.id)}>
                    <td className="p-4 text-slate-400">
                      {expandedId === order.id ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                    </td>
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
                          onValueChange={(v: any) => { updateMutation.mutate({ orderId: order.id, status: v }); }}
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
                  {expandedId === order.id && (
                    <tr key={`${order.id}-detail`} className="bg-slate-800/60 border-b border-slate-700/50">
                      <td colSpan={7} className="px-6 py-4">
                        {detailLoading ? (
                          <div className="space-y-2"><Skeleton className="h-4 w-48 bg-slate-700" /><Skeleton className="h-4 w-32 bg-slate-700" /></div>
                        ) : orderDetail ? (
                          <div className="space-y-3">
                            <div className="grid grid-cols-3 gap-4 text-xs">
                              <div><p className="text-slate-500">Customer ID</p><p className="text-slate-200 font-mono text-[10px]">{orderDetail.order.customerId ?? "—"}</p></div>
                              <div><p className="text-slate-500">Payment</p><p className="text-slate-200 capitalize">{orderDetail.order.paymentStatus}</p></div>
                              <div><p className="text-slate-500">Notes</p><p className="text-slate-200">{(orderDetail.order as any).notes ?? "—"}</p></div>
                            </div>
                            {orderDetail.items && orderDetail.items.length > 0 && (
                              <div>
                                <p className="text-xs text-slate-500 mb-2">Items</p>
                                <div className="space-y-1">
                                  {orderDetail.items.map((item: any, i: number) => (
                                    <div key={i} className="flex items-center justify-between text-xs bg-slate-700/40 rounded px-3 py-2">
                                      <span className="text-slate-200">{item.productName ?? item.productId}</span>
                                      <span className="text-slate-400">x{item.quantity}</span>
                                      <span className="text-emerald-400">${Number(item.unitPrice ?? 0).toFixed(2)}</span>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}
                          </div>
                        ) : (
                          <p className="text-slate-500 text-xs">No detail available</p>
                        )}
                      </td>
                    </tr>
                  )}
                  </>
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
