import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import DashboardLayout from "@/components/DashboardLayout";
import type { EscrowDispute } from "../../../drizzle/schema";

const STATUS_COLORS: Record<string, string> = {
  open: "bg-red-100 text-red-700",
  under_review: "bg-yellow-100 text-yellow-700",
  resolved_merchant: "bg-green-100 text-green-700",
  resolved_buyer: "bg-blue-100 text-blue-700",
  escalated: "bg-purple-100 text-purple-700",
};

const RESOLUTION_LABELS: Record<string, string> = {
  full_release_to_merchant: "Full Release to Merchant",
  full_refund_to_buyer: "Full Refund to Buyer",
  partial_refund: "Partial Refund",
  no_action: "No Action",
};

export default function DisputeManagement() {
  const [statusFilter, setStatusFilter] = useState("all");
  const [selected, setSelected] = useState<EscrowDispute | null>(null);
  const [resolution, setResolution] = useState<string>("full_release_to_merchant");
  const [notes, setNotes] = useState("");

  const { data: disputes, isLoading, refetch } = trpc.escrowDispute.list.useQuery({
    status: statusFilter === "all" ? undefined : statusFilter,
    limit: 100,
  });

  const review = trpc.escrowDispute.review.useMutation({
    onSuccess: () => {
      toast.success("Dispute resolved");
      setSelected(null);
      refetch();
    },
    onError: (e) => toast.error(e.message),
  });

  const openCount = (disputes ?? []).filter((d) => d.status === "open").length;
  const reviewCount = (disputes ?? []).filter((d) => d.status === "under_review").length;

  return (
    <DashboardLayout>
      <div className="p-6 space-y-6">
        <div>
          <h1 className="text-2xl font-bold">Dispute Management</h1>
          <p className="text-muted-foreground text-sm mt-1">Review buyer–merchant escrow disputes and issue resolutions</p>
        </div>

        {/* KPI Row */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Card><CardContent className="pt-6">
            <p className="text-sm text-muted-foreground">Open Disputes</p>
            <p className={`text-2xl font-bold ${openCount > 0 ? "text-red-600" : ""}`}>{openCount}</p>
          </CardContent></Card>
          <Card><CardContent className="pt-6">
            <p className="text-sm text-muted-foreground">Under Review</p>
            <p className="text-2xl font-bold text-yellow-600">{reviewCount}</p>
          </CardContent></Card>
          <Card><CardContent className="pt-6">
            <p className="text-sm text-muted-foreground">Resolved</p>
            <p className="text-2xl font-bold text-green-600">
              {(disputes ?? []).filter((d) => d.status.startsWith("resolved")).length}
            </p>
          </CardContent></Card>
          <Card><CardContent className="pt-6">
            <p className="text-sm text-muted-foreground">Total</p>
            <p className="text-2xl font-bold">{(disputes ?? []).length}</p>
          </CardContent></Card>
        </div>

        {/* Filter */}
        <div className="flex items-center gap-3">
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {["all", "open", "under_review", "resolved_merchant", "resolved_buyer", "escalated"].map((s) => (
                <SelectItem key={s} value={s}>{s === "all" ? "All Statuses" : s.replace(/_/g, " ")}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Disputes Table */}
        {isLoading ? (
          <div className="space-y-2">{[...Array(4)].map((_, i) => <Skeleton key={i} className="h-14" />)}</div>
        ) : (
          <div className="rounded-lg border overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="text-left px-4 py-3 font-medium">Dispute ID</th>
                  <th className="text-left px-4 py-3 font-medium">Order</th>
                  <th className="text-left px-4 py-3 font-medium">Raised By</th>
                  <th className="text-left px-4 py-3 font-medium">Reason</th>
                  <th className="text-left px-4 py-3 font-medium">Status</th>
                  <th className="text-left px-4 py-3 font-medium">Resolution</th>
                  <th className="text-left px-4 py-3 font-medium">Created</th>
                  <th className="text-left px-4 py-3 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {(disputes ?? []).length === 0 ? (
                  <tr><td colSpan={8} className="text-center py-8 text-muted-foreground">No disputes found</td></tr>
                ) : (disputes ?? []).map((d) => (
                  <tr key={d.id} className="border-t hover:bg-muted/30 transition-colors">
                    <td className="px-4 py-3 font-mono text-xs">{d.id.slice(0, 8)}…</td>
                    <td className="px-4 py-3 font-mono text-xs">{d.orderId.slice(0, 8)}…</td>
                    <td className="px-4 py-3">
                      <Badge variant={d.raisedBy === "buyer" ? "secondary" : "outline"} className="text-xs capitalize">
                        {d.raisedBy}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-xs">{d.reason.replace(/_/g, " ")}</td>
                    <td className="px-4 py-3">
                      <span className={`px-2 py-1 rounded-full text-xs font-medium ${STATUS_COLORS[d.status] ?? "bg-gray-100"}`}>
                        {d.status.replace(/_/g, " ")}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">
                      {d.resolution ? RESOLUTION_LABELS[d.resolution] ?? d.resolution : "—"}
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">
                      {new Date(d.createdAt).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-3">
                      {["open", "under_review"].includes(d.status) && (
                        <Button size="sm" variant="outline" className="text-xs h-7"
                          onClick={() => { setSelected(d as EscrowDispute); setResolution("full_release_to_merchant"); setNotes(""); }}>
                          Review
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Review Dialog */}
        <Dialog open={!!selected} onOpenChange={(open) => !open && setSelected(null)}>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>Resolve Dispute</DialogTitle>
            </DialogHeader>
            {selected && (
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div><span className="text-muted-foreground">Raised by:</span> <strong className="capitalize">{selected.raisedBy}</strong></div>
                  <div><span className="text-muted-foreground">Reason:</span> <strong>{selected.reason.replace(/_/g, " ")}</strong></div>
                  {selected.description && (
                    <div className="col-span-2">
                      <span className="text-muted-foreground">Description:</span>
                      <p className="mt-1 text-sm bg-muted/50 rounded p-2">{selected.description}</p>
                    </div>
                  )}
                </div>
                <div className="space-y-1">
                  <Label>Resolution</Label>
                  <Select value={resolution} onValueChange={setResolution}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {Object.entries(RESOLUTION_LABELS).map(([v, l]) => (
                        <SelectItem key={v} value={v}>{l}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label>Resolver Notes</Label>
                  <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Add notes for the audit trail…" rows={3} />
                </div>
              </div>
            )}
            <DialogFooter>
              <Button variant="outline" onClick={() => setSelected(null)}>Cancel</Button>
              <Button
                disabled={review.isPending}
                onClick={() => selected && review.mutate({
                  disputeId: selected.id,
                  resolution: resolution as any,
                  resolverNotes: notes,
                  resolvedBy: "admin",
                })}>
                {review.isPending ? "Saving…" : "Confirm Resolution"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </DashboardLayout>
  );
}
