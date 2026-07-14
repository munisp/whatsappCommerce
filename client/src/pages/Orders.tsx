import DashboardLayout from "@/components/DashboardLayout";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { trpc } from "@/lib/trpc";
import { formatDistanceToNow } from "date-fns";
import { Package, ShoppingCart, TrendingUp, Truck } from "lucide-react";
import { useState } from "react";

const DEMO_TENANT = "demo-tenant-001";

const statusColors: Record<string, string> = {
  pending: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30",
  confirmed: "bg-blue-500/20 text-blue-400 border-blue-500/30",
  processing: "bg-purple-500/20 text-purple-400 border-purple-500/30",
  shipped: "bg-cyan-500/20 text-cyan-400 border-cyan-500/30",
  delivered: "bg-green-500/20 text-green-400 border-green-500/30",
  cancelled: "bg-red-500/20 text-red-400 border-red-500/30",
  refunded: "bg-orange-500/20 text-orange-400 border-orange-500/30",
};

export default function Orders() {
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const { data: stats } = trpc.order.stats.useQuery({ tenantId: DEMO_TENANT });
  const { data: orderList, isLoading } = trpc.order.list.useQuery({
    tenantId: DEMO_TENANT,
    status: statusFilter === "all" ? undefined : statusFilter,
    limit: 50,
  });

  return (
    <DashboardLayout>
      <div className="p-6 space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Orders</h1>
          <p className="text-muted-foreground mt-1">Track and manage customer orders</p>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {[
            { label: "Total Orders", value: stats?.total ?? 0, icon: ShoppingCart, color: "text-blue-400" },
            { label: "Pending", value: stats?.pending ?? 0, icon: Package, color: "text-yellow-400" },
            { label: "Confirmed", value: stats?.confirmed ?? 0, icon: Truck, color: "text-green-400" },
            { label: "Revenue", value: `$${(stats?.revenue ?? 0).toLocaleString()}`, icon: TrendingUp, color: "text-primary" },
          ].map((s) => (
            <Card key={s.label} className="bg-card border-border">
              <CardContent className="p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-xs text-muted-foreground">{s.label}</p>
                    <p className={`text-2xl font-bold mt-1 ${s.color}`}>{s.value}</p>
                  </div>
                  <s.icon className={`w-8 h-8 ${s.color} opacity-60`} />
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        {/* Filter */}
        <div className="flex items-center gap-3">
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-48 bg-card border-border">
              <SelectValue placeholder="Filter by status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Statuses</SelectItem>
              <SelectItem value="pending">Pending</SelectItem>
              <SelectItem value="confirmed">Confirmed</SelectItem>
              <SelectItem value="processing">Processing</SelectItem>
              <SelectItem value="shipped">Shipped</SelectItem>
              <SelectItem value="delivered">Delivered</SelectItem>
              <SelectItem value="cancelled">Cancelled</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Table */}
        <Card className="bg-card border-border">
          <CardHeader><CardTitle className="text-sm font-medium text-muted-foreground">Order List</CardTitle></CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow className="border-border hover:bg-transparent">
                  <TableHead>Order #</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Payment</TableHead>
                  <TableHead>Amount</TableHead>
                  <TableHead>Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground py-8">Loading orders...</TableCell></TableRow>
                ) : orderList?.length === 0 ? (
                  <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground py-8">No orders found</TableCell></TableRow>
                ) : orderList?.map((o) => (
                  <TableRow key={o.id} className="border-border hover:bg-accent/30">
                    <TableCell className="font-mono text-xs">{o.orderNumber}</TableCell>
                    <TableCell><Badge variant="outline" className={statusColors[o.status] ?? ""}>{o.status}</Badge></TableCell>
                    <TableCell><Badge variant="outline" className={o.paymentStatus === "completed" ? "bg-green-500/20 text-green-400 border-green-500/30" : "bg-muted text-muted-foreground"}>{o.paymentStatus}</Badge></TableCell>
                    <TableCell className="font-mono">{o.currency} {Number(o.totalAmount).toFixed(2)}</TableCell>
                    <TableCell className="text-muted-foreground text-xs">{formatDistanceToNow(new Date(o.createdAt), { addSuffix: true })}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}
