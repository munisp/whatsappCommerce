import { useState } from "react";
import { trpc } from "@/lib/trpc";
import DashboardLayout from "@/components/DashboardLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CheckCircle, XCircle, Clock, FileText } from "lucide-react";
import { toast } from "sonner";

const STATUS_COLORS: Record<string, string> = {
  pending: "bg-yellow-100 text-yellow-800",
  approved: "bg-green-100 text-green-800",
  rejected: "bg-red-100 text-red-800",
};

export default function CogsDisputes() {
  const [statusFilter, setStatusFilter] = useState<"pending" | "approved" | "rejected" | "all">("all");
  const [reviewDialog, setReviewDialog] = useState<{ id: string; action: "approved" | "rejected" } | null>(null);
  const [reviewNote, setReviewNote] = useState("");

  const { data: disputes = [], refetch } = trpc.cogsDispute.list.useQuery({ status: statusFilter });
  const reviewMutation = trpc.cogsDispute.review.useMutation({
    onSuccess: () => {
      toast.success("Review submitted successfully");
      setReviewDialog(null);
      setReviewNote("");
      refetch();
    },
    onError: (e) => toast.error(e.message),
  });

  const pendingCount = disputes.filter((d) => d.status === "pending").length;

  return (
    <DashboardLayout>
      <div className="p-6 space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">COGS Rate Disputes</h1>
            <p className="text-muted-foreground text-sm mt-1">
              Review and approve merchant requests to adjust their Cost of Goods Sold rate, which directly affects profit-share calculations.
            </p>
          </div>
          {pendingCount > 0 && (
            <Badge className="bg-yellow-100 text-yellow-800 text-sm px-3 py-1">
              {pendingCount} pending review{pendingCount > 1 ? "s" : ""}
            </Badge>
          )}
        </div>

        {/* Summary cards */}
        <div className="grid grid-cols-3 gap-4">
          {(["pending", "approved", "rejected"] as const).map((s) => {
            const count = disputes.filter((d) => d.status === s).length;
            const icons = { pending: Clock, approved: CheckCircle, rejected: XCircle };
            const Icon = icons[s];
            return (
              <Card key={s} className="cursor-pointer hover:shadow-md transition-shadow"
                onClick={() => setStatusFilter(s === statusFilter ? "all" : s)}>
                <CardContent className="pt-4 flex items-center gap-3">
                  <Icon className={`w-8 h-8 ${s === "pending" ? "text-yellow-500" : s === "approved" ? "text-green-500" : "text-red-500"}`} />
                  <div>
                    <div className="text-2xl font-bold">{count}</div>
                    <div className="text-sm text-muted-foreground capitalize">{s}</div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>

        {/* Filter */}
        <div className="flex items-center gap-3">
          <span className="text-sm font-medium">Filter:</span>
          <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as any)}>
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="pending">Pending</SelectItem>
              <SelectItem value="approved">Approved</SelectItem>
              <SelectItem value="rejected">Rejected</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Disputes list */}
        <div className="space-y-3">
          {disputes.length === 0 ? (
            <Card>
              <CardContent className="py-12 text-center text-muted-foreground">
                <FileText className="w-10 h-10 mx-auto mb-3 opacity-30" />
                <p>No dispute requests found.</p>
              </CardContent>
            </Card>
          ) : disputes.map((d) => (
            <Card key={d.id} className="hover:shadow-sm transition-shadow">
              <CardContent className="pt-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 space-y-2">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold">{d.tenantName ?? d.tenantId}</span>
                      <Badge className={STATUS_COLORS[d.status ?? "pending"]}>
                        {d.status}
                      </Badge>
                    </div>
                    <div className="text-sm text-muted-foreground">
                      COGS rate: <span className="font-mono text-foreground">{(parseFloat(d.currentCogsRate) * 100).toFixed(0)}%</span>
                      {" → "}
                      <span className="font-mono text-foreground font-semibold">{(parseFloat(d.requestedCogsRate) * 100).toFixed(0)}%</span>
                      <span className="ml-3 text-xs">Requested {new Date(d.createdAt).toLocaleDateString()}</span>
                    </div>
                    {d.justification && (
                      <p className="text-sm bg-muted rounded p-2 italic">"{d.justification}"</p>
                    )}
                    {d.reviewNote && (
                      <p className="text-sm text-muted-foreground">
                        <span className="font-medium">Review note:</span> {d.reviewNote}
                        {d.reviewedBy && <span className="ml-1">— {d.reviewedBy}</span>}
                      </p>
                    )}
                  </div>
                  {d.status === "pending" && (
                    <div className="flex gap-2 shrink-0">
                      <Button size="sm" variant="outline" className="text-green-600 border-green-300 hover:bg-green-50"
                        onClick={() => setReviewDialog({ id: d.id, action: "approved" })}>
                        Approve
                      </Button>
                      <Button size="sm" variant="outline" className="text-red-600 border-red-300 hover:bg-red-50"
                        onClick={() => setReviewDialog({ id: d.id, action: "rejected" })}>
                        Reject
                      </Button>
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>

      {/* Review dialog */}
      <Dialog open={!!reviewDialog} onOpenChange={() => setReviewDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {reviewDialog?.action === "approved" ? "Approve" : "Reject"} COGS Rate Request
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <p className="text-sm text-muted-foreground">
              {reviewDialog?.action === "approved"
                ? "Approving will immediately update the tenant's COGS rate and affect future profit-share calculations."
                : "Rejecting will keep the tenant's current COGS rate unchanged."}
            </p>
            <Textarea
              placeholder="Add a review note (optional)..."
              value={reviewNote}
              onChange={(e) => setReviewNote(e.target.value)}
              rows={3}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReviewDialog(null)}>Cancel</Button>
            <Button
              variant={reviewDialog?.action === "approved" ? "default" : "destructive"}
              disabled={reviewMutation.isPending}
              onClick={() => {
                if (!reviewDialog) return;
                reviewMutation.mutate({
                  disputeId: reviewDialog.id,
                  action: reviewDialog.action,
                  reviewNote: reviewNote || undefined,
                });
              }}
            >
              {reviewMutation.isPending ? "Submitting..." : reviewDialog?.action === "approved" ? "Confirm Approve" : "Confirm Reject"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  );
}
