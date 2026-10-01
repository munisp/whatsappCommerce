import { useActiveTenant } from "@/contexts/TenantContext";
import DashboardLayout from "@/components/DashboardLayout";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { trpc } from "@/lib/trpc";
import { formatDistanceToNow } from "date-fns";
import { Bell, Clock, MessageSquare, Package, ShoppingCart, TrendingUp, Truck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { usePollInterval } from "@/hooks/usePollInterval";
import { useIsMobile } from "@/hooks/useMobile";
import { useTableVirtualizer, VirtualTableBody } from "@/components/VirtualTable";
// === W55 ui-c (ORPHAN-BE-19): orderCrud edit actions — status correction,
// cancel and refund, previously no UI surface (page was read-only via the
// order router). ===
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { MoreHorizontal } from "lucide-react";
import { toast } from "sonner";

const ORDER_STATUSES = ["pending", "confirmed", "processing", "shipped", "delivered", "cancelled", "refunded"] as const;
// === END W55 ui-c ===


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
  const { activeTenantId: DEMO_TENANT } = useActiveTenant();
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [, setLocation] = useLocation();
  const { data: stats } = trpc.order.stats.useQuery({ tenantId: DEMO_TENANT });
  // W48 PERF-FE-13: smaller first page on mobile viewports (payload trim).
  const isMobile = useIsMobile();
  const pageLimit = isMobile ? 25 : 50;
  const { data: orderList, isLoading } = trpc.order.list.useQuery({
    tenantId: DEMO_TENANT,
    status: statusFilter === "all" ? undefined : statusFilter,
    limit: pageLimit,
  });
  const orderIds = useMemo(() => (orderList ?? []).map((o) => o.id), [orderList]);
  // W48 PERF-FE-5: visibility-gated, raised from 30s to 60s.
  const unreadPoll = usePollInterval(60_000);
  const { data: unreadData } = trpc.whatsappNotifications.getBulkUnreadReplyCounts.useQuery(
    { orderIds },
    { enabled: orderIds.length > 0, refetchInterval: unreadPoll }
  );
  const unreadCounts = unreadData?.counts ?? {};
  // Derived list: when unreadOnly is on, hide rows with 0 unread replies
  const totalUnreadOrders = useMemo(
    () => Object.values(unreadCounts).filter((n) => n > 0).length,
    [unreadCounts]
  );
  const displayedOrders = useMemo(() => {
    if (!unreadOnly) return orderList ?? [];
    return (orderList ?? []).filter((o) => (unreadCounts[o.id] ?? 0) > 0);
  }, [orderList, unreadCounts, unreadOnly]);
  // === W48 perf (PERF-FE-4): virtualized order rows ===
  const { scrollRef, virtualizer } = useTableVirtualizer(displayedOrders.length, 53);

  // === W55 ui-c: orderCrud edit actions ===
  const utils = trpc.useUtils();
  const [statusEdit, setStatusEdit] = useState<{ id: string; status: string } | null>(null);
  const [newStatus, setNewStatus] = useState<string>("");
  const [statusNotes, setStatusNotes] = useState("");
  const [cancelFor, setCancelFor] = useState<string | null>(null);
  const [cancelReason, setCancelReason] = useState("");
  const [refundFor, setRefundFor] = useState<{ id: string; total: number; currency: string } | null>(null);
  const [refundAmount, setRefundAmount] = useState("");
  const [refundReason, setRefundReason] = useState("");

  const invalidateOrders = () => {
    utils.order.list.invalidate();
    utils.order.stats.invalidate();
  };
  const updateStatusMut = trpc.orderCrud.updateStatus.useMutation({
    onSuccess: () => { toast.success("Order status updated"); setStatusEdit(null); invalidateOrders(); },
    onError: (e) => toast.error(e.message),
  });
  const cancelMut = trpc.orderCrud.cancel.useMutation({
    onSuccess: (r) => {
      toast.success(r.escrowRefunded ? "Order cancelled and escrow refunded" : "Order cancelled");
      setCancelFor(null); setCancelReason(""); invalidateOrders();
    },
    onError: (e) => toast.error(e.message),
  });
  const refundMut = trpc.orderCrud.refund.useMutation({
    onSuccess: () => { toast.success("Refund initiated"); setRefundFor(null); setRefundAmount(""); setRefundReason(""); invalidateOrders(); },
    onError: (e) => toast.error(e.message),
  });
  // === END W55 ui-c ===

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
        {/* Unread-only toggle */}
        <div className="flex items-center gap-3 -mt-3">
          <button
            type="button"
            onClick={() => setUnreadOnly((v) => !v)}
            className={`flex items-center gap-2 px-3 py-1.5 rounded-full border text-xs font-medium transition-colors ${
              unreadOnly
                ? "bg-green-500/20 border-green-500/40 text-green-400 hover:bg-green-500/30"
                : "bg-card border-border text-muted-foreground hover:bg-accent/40 hover:text-foreground"
            }`}
          >
            <Bell className={`w-3.5 h-3.5 ${unreadOnly ? "text-green-400" : ""}`} />
            Unread replies only
            {totalUnreadOrders > 0 && (
              <span className={`inline-flex items-center justify-center h-4 min-w-[16px] px-1 rounded-full text-[10px] font-bold ${
                unreadOnly ? "bg-green-500 text-white" : "bg-green-500/20 text-green-400"
              }`}>
                {totalUnreadOrders}
              </span>
            )}
          </button>
          {unreadOnly && (
            <span className="text-xs text-muted-foreground">
              Showing {displayedOrders.length} order{displayedOrders.length !== 1 ? "s" : ""} with unread replies
            </span>
          )}
        </div>

        {/* Table */}
        <Card className="bg-card border-border">
          <CardHeader><CardTitle className="text-sm font-medium text-muted-foreground">Order List</CardTitle></CardHeader>
          <CardContent className="p-0">
            <div ref={scrollRef} className="max-h-[560px] overflow-y-auto">
            <Table>
              <TableHeader className="sticky top-0 z-10 bg-card">
                <TableRow className="border-border hover:bg-transparent">
                  <TableHead>Order #</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Payment</TableHead>
                  <TableHead>Amount</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              {isLoading ? (
                <TableBody>
                  <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground py-8">Loading orders...</TableCell></TableRow>
                </TableBody>
              ) : (
                <VirtualTableBody
                  rows={displayedOrders}
                  virtualizer={virtualizer}
                  colSpan={6}
                  emptyState={
                    <div className="text-center text-muted-foreground py-8">
                      {unreadOnly ? "No orders with unread WhatsApp replies" : "No orders found"}
                    </div>
                  }
                  renderRow={(o) => (
                  <TableRow key={o.id} className="border-border hover:bg-accent/30">
                    <TableCell className="font-mono text-xs">{o.orderNumber}</TableCell>
                    <TableCell><Badge variant="outline" className={statusColors[o.status] ?? ""}>{o.status}</Badge></TableCell>
                    <TableCell><Badge variant="outline" className={o.paymentStatus === "completed" ? "bg-green-500/20 text-green-400 border-green-500/30" : "bg-muted text-muted-foreground"}>{o.paymentStatus}</Badge></TableCell>
                    <TableCell className="font-mono">{o.currency} {Number(o.totalAmount).toFixed(2)}</TableCell>
                    <TableCell className="text-muted-foreground text-xs">{formatDistanceToNow(new Date(o.createdAt), { addSuffix: true })}</TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 text-xs gap-1 text-muted-foreground hover:text-foreground"
                          onClick={() => setLocation(`/orders/${o.orderNumber}`)}
                        >
                          <Clock className="w-3 h-3" /> Timeline
                        </Button>
                        {(unreadCounts[o.id] ?? 0) > 0 && (
                          <button
                            onClick={() => setLocation(`/orders/${o.orderNumber}`)}
                            className="flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-green-500/20 border border-green-500/40 text-green-400 text-[10px] font-semibold hover:bg-green-500/30 transition-colors"
                            title={`${unreadCounts[o.id]} unread WhatsApp ${unreadCounts[o.id] === 1 ? "reply" : "replies"}`}
                          >
                            <MessageSquare className="w-2.5 h-2.5" />
                            {unreadCounts[o.id]}
                          </button>
                        )}
                        {/* === W55 ui-c: orderCrud edit actions === */}
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground">
                              <MoreHorizontal className="w-4 h-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            {!["delivered", "cancelled", "refunded"].includes(o.status) && (
                              <DropdownMenuItem onClick={() => { setStatusEdit({ id: o.id, status: o.status }); setNewStatus(o.status); setStatusNotes(""); }}>
                                Update status
                              </DropdownMenuItem>
                            )}
                            {!["shipped", "delivered", "cancelled", "refunded"].includes(o.status) && (
                              <DropdownMenuItem onClick={() => { setCancelFor(o.id); setCancelReason(""); }}>
                                Cancel order
                              </DropdownMenuItem>
                            )}
                            {o.paymentStatus === "completed" && !["cancelled", "refunded"].includes(o.status) && (
                              <DropdownMenuItem onClick={() => { setRefundFor({ id: o.id, total: Number(o.totalAmount), currency: o.currency }); setRefundAmount(String(o.totalAmount)); setRefundReason(""); }}>
                                Initiate refund
                              </DropdownMenuItem>
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                        {/* === END W55 ui-c === */}
                      </div>
                    </TableCell>
                  </TableRow>
                  )}
                />
              )}
            </Table>
            </div>
          </CardContent>
        </Card>

        {/* === W55 ui-c: orderCrud edit dialogs === */}
        <Dialog open={!!statusEdit} onOpenChange={() => setStatusEdit(null)}>
          <DialogContent>
            <DialogHeader><DialogTitle>Update order status</DialogTitle></DialogHeader>
            <div className="space-y-4">
              <div className="space-y-2">
                <Label>New status (current: {statusEdit?.status})</Label>
                <Select value={newStatus} onValueChange={setNewStatus}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {ORDER_STATUSES.map((s) => (
                      <SelectItem key={s} value={s}>{s}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">Only legal transitions are accepted; illegal ones are rejected by the server.</p>
              </div>
              <div className="space-y-2">
                <Label>Note (optional)</Label>
                <Textarea value={statusNotes} onChange={(e) => setStatusNotes(e.target.value)} maxLength={500} />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setStatusEdit(null)}>Close</Button>
              <Button disabled={updateStatusMut.isPending || !newStatus}
                onClick={() => statusEdit && updateStatusMut.mutate({ orderId: statusEdit.id, status: newStatus as any, notes: statusNotes || undefined })}>
                Update
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Dialog open={!!cancelFor} onOpenChange={() => setCancelFor(null)}>
          <DialogContent>
            <DialogHeader><DialogTitle>Cancel order</DialogTitle></DialogHeader>
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground">Reserved inventory is released and any escrow is refunded. This cannot be undone.</p>
              <Label>Reason (optional)</Label>
              <Textarea value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} maxLength={500} />
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setCancelFor(null)}>Close</Button>
              <Button variant="destructive" disabled={cancelMut.isPending}
                onClick={() => cancelFor && cancelMut.mutate({ orderId: cancelFor, reason: cancelReason || undefined })}>
                Cancel order
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Dialog open={!!refundFor} onOpenChange={() => setRefundFor(null)}>
          <DialogContent>
            <DialogHeader><DialogTitle>Initiate refund</DialogTitle></DialogHeader>
            <div className="space-y-4">
              <div className="space-y-2">
                <Label>Amount ({refundFor?.currency}) — order total {refundFor?.total.toFixed(2)}</Label>
                <Input type="number" min="0.01" step="0.01" value={refundAmount} onChange={(e) => setRefundAmount(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>Reason</Label>
                <Textarea value={refundReason} onChange={(e) => setRefundReason(e.target.value)} maxLength={500} />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setRefundFor(null)}>Close</Button>
              <Button variant="destructive"
                disabled={refundMut.isPending || !refundReason.trim() || !(Number(refundAmount) > 0)}
                onClick={() => refundFor && refundMut.mutate({ orderId: refundFor.id, amount: Number(refundAmount), reason: refundReason.trim() })}>
                Initiate refund
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        {/* === END W55 ui-c === */}
      </div>
    </DashboardLayout>
  );
}
