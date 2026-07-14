import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import DashboardLayout from "@/components/DashboardLayout";

const STATUS_COLORS: Record<string, string> = {
  pending: "bg-gray-100 text-gray-600",
  created: "bg-blue-100 text-blue-700",
  picked_up: "bg-indigo-100 text-indigo-700",
  in_transit: "bg-yellow-100 text-yellow-700",
  out_for_delivery: "bg-orange-100 text-orange-700",
  delivered: "bg-green-100 text-green-700",
  failed: "bg-red-100 text-red-700",
  returned: "bg-gray-100 text-gray-500",
};

const SIMULATE_STEPS = ["picked_up", "in_transit", "out_for_delivery", "delivered", "failed"] as const;

function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`px-2 py-1 rounded-full text-xs font-medium ${STATUS_COLORS[status] ?? "bg-gray-100"}`}>
      {status.replace(/_/g, " ")}
    </span>
  );
}

export default function LogisticsTracker() {
  const [statusFilter, setStatusFilter] = useState("all");
  const [simStatus, setSimStatus] = useState<Record<string, string>>({});

  const { data: shipments, isLoading, refetch } = trpc.logistics.listShipments.useQuery({
    status: statusFilter === "all" ? undefined : statusFilter,
    limit: 100,
  });
  const { data: stats } = trpc.logistics.getStats.useQuery();

  const simulate = trpc.logistics.simulateDelivery.useMutation({
    onSuccess: (data) => {
      toast.success(`Shipment status updated to: ${data.status}`);
      refetch();
    },
    onError: (e) => toast.error(e.message),
  });

  const STATUSES = ["all", "pending", "created", "picked_up", "in_transit", "out_for_delivery", "delivered", "failed", "returned"];

  return (
    <DashboardLayout>
      <div className="p-6 space-y-6">
        <div>
          <h1 className="text-2xl font-bold">Logistics Tracker</h1>
          <p className="text-muted-foreground text-sm mt-1">Monitor all shipments and delivery events across the platform</p>
        </div>

        {/* Stats Row */}
        {stats && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Card><CardContent className="pt-6">
              <p className="text-sm text-muted-foreground">Total Shipments</p>
              <p className="text-2xl font-bold">{stats.total}</p>
            </CardContent></Card>
            <Card><CardContent className="pt-6">
              <p className="text-sm text-muted-foreground">Delivery Rate</p>
              <p className="text-2xl font-bold text-green-600">{stats.deliveryRate}%</p>
            </CardContent></Card>
            <Card><CardContent className="pt-6">
              <p className="text-sm text-muted-foreground">In Transit</p>
              <p className="text-2xl font-bold text-yellow-600">
                {(stats.byStatus["in_transit"] ?? 0) + (stats.byStatus["out_for_delivery"] ?? 0)}
              </p>
            </CardContent></Card>
            <Card><CardContent className="pt-6">
              <p className="text-sm text-muted-foreground">Failed / Returned</p>
              <p className="text-2xl font-bold text-red-600">
                {(stats.byStatus["failed"] ?? 0) + (stats.byStatus["returned"] ?? 0)}
              </p>
            </CardContent></Card>
          </div>
        )}

        {/* Filter */}
        <div className="flex items-center gap-3">
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-52">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STATUSES.map((s) => (
                <SelectItem key={s} value={s}>{s === "all" ? "All Statuses" : s.replace(/_/g, " ")}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="text-sm text-muted-foreground">{shipments?.total ?? 0} shipments</span>
        </div>

        {/* Shipment Table */}
        {isLoading ? (
          <div className="space-y-2">{[...Array(5)].map((_, i) => <Skeleton key={i} className="h-16" />)}</div>
        ) : (
          <div className="rounded-lg border overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="text-left px-4 py-3 font-medium">Shipment ID</th>
                  <th className="text-left px-4 py-3 font-medium">Order</th>
                  <th className="text-left px-4 py-3 font-medium">Carrier</th>
                  <th className="text-left px-4 py-3 font-medium">Tracking #</th>
                  <th className="text-left px-4 py-3 font-medium">Recipient</th>
                  <th className="text-left px-4 py-3 font-medium">Status</th>
                  <th className="text-left px-4 py-3 font-medium">Escrow Linked</th>
                  <th className="text-left px-4 py-3 font-medium">Created</th>
                  <th className="text-left px-4 py-3 font-medium">Simulate</th>
                </tr>
              </thead>
              <tbody>
                {(shipments?.items ?? []).length === 0 ? (
                  <tr><td colSpan={9} className="text-center py-8 text-muted-foreground">No shipments found</td></tr>
                ) : (shipments?.items ?? []).map((s) => (
                  <tr key={s.id} className="border-t hover:bg-muted/30 transition-colors">
                    <td className="px-4 py-3 font-mono text-xs">{s.id.slice(0, 8)}…</td>
                    <td className="px-4 py-3 font-mono text-xs">{s.orderId.slice(0, 8)}…</td>
                    <td className="px-4 py-3">{s.carrierName ?? s.carrierId ?? s.provider}</td>
                    <td className="px-4 py-3">
                      {s.trackingId ? (
                        s.trackingUrl ? (
                          <a href={s.trackingUrl} target="_blank" rel="noopener noreferrer"
                            className="text-blue-600 hover:underline font-mono text-xs">{s.trackingId}</a>
                        ) : (
                          <span className="font-mono text-xs">{s.trackingId}</span>
                        )
                      ) : <span className="text-muted-foreground text-xs">—</span>}
                    </td>
                    <td className="px-4 py-3 text-xs">{s.recipientName ?? "—"}</td>
                    <td className="px-4 py-3"><StatusBadge status={s.status} /></td>
                    <td className="px-4 py-3">
                      {s.escrowTxId ? (
                        <Badge variant="outline" className="text-xs text-green-700 border-green-300">Linked</Badge>
                      ) : (
                        <span className="text-muted-foreground text-xs">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">
                      {new Date(s.createdAt).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-3">
                      {!["delivered", "returned"].includes(s.status) && (
                        <div className="flex items-center gap-1">
                          <Select
                            value={simStatus[s.id] ?? "delivered"}
                            onValueChange={(v) => setSimStatus(p => ({ ...p, [s.id]: v }))}>
                            <SelectTrigger className="h-7 w-32 text-xs">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {SIMULATE_STEPS.map((step) => (
                                <SelectItem key={step} value={step}>{step.replace(/_/g, " ")}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <Button size="sm" variant="outline" className="h-7 text-xs"
                            disabled={simulate.isPending}
                            onClick={() => simulate.mutate({ shipmentId: s.id, status: (simStatus[s.id] ?? "delivered") as any })}>
                            Go
                          </Button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}
